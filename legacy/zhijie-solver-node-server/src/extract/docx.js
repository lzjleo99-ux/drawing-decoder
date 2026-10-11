// .docx 抽取：把 Word 文档线性化成"带 LaTeX 公式标记的纯文本 + 图片列表"。
//
// 这里不用 mammoth。mammoth 会整段丢弃 Word 公式，而公式对理工科试卷就是题目本身；
// 自己遍历 document.xml 才能在正确位置插入公式（公式与上下文的相对位置必须保留，
// 否则"求下式的积分"后面跟不上式子，题目就不完整了）。
// 附带好处：去掉 mammoth 后依赖树里不再有已知漏洞。

import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import sharp from 'sharp';
import { ommlElementToLatex } from './omml2latex.js';

// Claude 视觉通道支持的图片类型
const VISION_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
};
// 这些格式 Word 里很常见（粘贴的图表/公式图），但视觉通道和 sharp 都读不了
const UNREADABLE = ['emf', 'wmf', 'wmz', 'emz'];

const MAX_IMAGES = 20;
const MAX_EDGE = 1568; // 视觉输入建议的长边上限，超过无额外收益只增成本

function localName(n) {
  return n.nodeType === 1 ? n.localName : null;
}

function attrNS(el, name) {
  if (!el?.attributes) return null;
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.localName === name) return a.value;
  }
  return null;
}

function findDescendant(el, localNames) {
  if (!el) return null;
  const want = new Set(localNames);
  let found = null;
  const visit = (n) => {
    if (found || n.nodeType !== 1) return;
    if (want.has(n.localName)) { found = n; return; }
    for (let c = n.firstChild; c; c = c.nextSibling) visit(c);
  };
  for (let c = el.firstChild; c; c = c.nextSibling) visit(c);
  return found;
}

/** 解析 document.xml.rels，得到 关系ID → media 文件路径 的映射。 */
function parseRels(files) {
  const map = new Map();
  const raw = files['word/_rels/document.xml.rels'];
  if (!raw) return map;
  let doc;
  try {
    doc = new DOMParser().parseFromString(strFromU8(raw), 'text/xml');
  } catch {
    return map; // 关系表坏了只会丢图片，不该让整篇文档解析失败
  }
  const nodes = doc.getElementsByTagName('Relationship');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const id = el.getAttribute('Id');
    const target = el.getAttribute('Target');
    if (id && target) map.set(id, target.replace(/^\/?/, '').replace(/^word\//, ''));
  }
  return map;
}

/** 遍历一个 w:r（文本 run），处理文本、制表、换行、以及 run 内嵌的公式。 */
function runToText(r) {
  let out = '';
  for (let n = r.firstChild; n; n = n.nextSibling) {
    switch (localName(n)) {
      case 't': {
        for (let t = n.firstChild; t; t = t.nextSibling) {
          if (t.nodeType === 3) out += t.nodeValue;
        }
        break;
      }
      case 'tab': out += '\t'; break;
      case 'br': out += '\n'; break;
      case 'cr': out += '\n'; break;
      case 'noBreakHyphen': out += '-'; break;
      default: break;
    }
  }
  return out;
}

/**
 * 按文档顺序遍历一个段落（或表格单元格）的内容。
 * 顺序很关键：公式必须落在它原本的位置。
 */
function blockToText(el, ctx) {
  let out = '';
  for (let n = el.firstChild; n; n = n.nextSibling) {
    const ln = localName(n);
    if (!ln) continue;
    if (ln === 'r') {
      // run 内可能挂着图片
      const drawing = findDescendant(n, ['blip', 'imagedata']);
      if (drawing) {
        const rid = attrNS(drawing, 'embed') || attrNS(drawing, 'id') || attrNS(drawing, 'link');
        if (rid) {
          const marker = ctx.addImage(rid);
          if (marker) out += marker;
        }
      }
      out += runToText(n);
    } else if (ln === 'oMath') {
      const latex = ommlElementToLatex(n);
      if (latex) { out += ` $${latex}$ `; ctx.equationCount++; }
    } else if (ln === 'oMathPara') {
      // 独立成行的公式（显示公式）
      for (let m = n.firstChild; m; m = m.nextSibling) {
        if (localName(m) === 'oMath') {
          const latex = ommlElementToLatex(m);
          if (latex) { out += `\n$$${latex}$$\n`; ctx.equationCount++; }
        }
      }
    } else if (ln === 'hyperlink' || ln === 'smartTag' || ln === 'sdtContent' || ln === 'ins') {
      out += blockToText(n, ctx);
    }
  }
  return out;
}

/** 段落 → 文本，带标题/列表前缀。 */
function paragraphToText(p, ctx) {
  const pPr = Array.from({ length: 1 }).map(() => {
    for (let n = p.firstChild; n; n = n.nextSibling) if (localName(n) === 'pPr') return n;
    return null;
  })[0];

  let prefix = '';
  if (pPr) {
    const styleEl = findDescendant(pPr, ['pStyle']);
    const style = styleEl ? attrNS(styleEl, 'val') : null;
    const heading = style && /^(Heading|heading|标题)(\d)/.exec(style);
    if (heading) prefix = '#'.repeat(Math.min(6, Number(heading[2]))) + ' ';
    else if (findDescendant(pPr, ['numPr'])) prefix = '- ';
  }
  const body = blockToText(p, ctx).replace(/[ \t]+/g, ' ').trim();
  return body ? prefix + body : '';
}

/** 表格 → 以 | 分隔的文本行，保留行列结构。 */
function tableToText(tbl, ctx) {
  const rows = [];
  for (let tr = tbl.firstChild; tr; tr = tr.nextSibling) {
    if (localName(tr) !== 'tr') continue;
    const cells = [];
    for (let tc = tr.firstChild; tc; tc = tc.nextSibling) {
      if (localName(tc) !== 'tc') continue;
      const parts = [];
      for (let p = tc.firstChild; p; p = p.nextSibling) {
        if (localName(p) === 'p') {
          const t = paragraphToText(p, ctx);
          if (t) parts.push(t);
        }
      }
      cells.push(parts.join(' ').trim());
    }
    if (cells.length) rows.push(`| ${cells.join(' | ')} |`);
  }
  return rows.join('\n');
}

/**
 * 抽取 .docx。
 * @param {Buffer} buf
 * @returns {Promise<{kind:string,text:string,images:Array,equationCount:number,warnings:string[]}>}
 */
export async function extractDocx(buf) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buf));
  } catch (e) {
    throw new Error(`无法解压 .docx（文件可能已损坏，或实际不是 Word 文档）：${e.message}`);
  }
  const docXml = files['word/document.xml'];
  if (!docXml) throw new Error('不是有效的 .docx：缺少 word/document.xml');

  const rels = parseRels(files);
  const warnings = [];
  const images = [];
  const seen = new Map();

  const ctx = {
    equationCount: 0,
    // 图片按首次出现顺序编号，文本里留下 [图N] 标记供模型与图片列表对应
    addImage(rid) {
      if (seen.has(rid)) return ` [图${seen.get(rid)}] `;
      const target = rels.get(rid);
      if (!target) return '';
      const idx = seen.size + 1;
      if (images.length >= MAX_IMAGES) {
        if (!warnings.some((w) => w.includes('图片数量'))) {
          warnings.push(`图片数量超过 ${MAX_IMAGES} 张，其余图片未送入识别`);
        }
        return ` [图${idx}·未识别] `;
      }
      seen.set(rid, idx);
      images.push({ index: idx, path: `word/${target}` });
      return ` [图${idx}] `;
    },
  };

  let doc;
  try {
    doc = new DOMParser().parseFromString(strFromU8(docXml), 'text/xml');
  } catch (e) {
    throw new Error(`.docx 内部的 document.xml 无法解析，文件可能已损坏：${e.message}`);
  }
  const bodies = doc.getElementsByTagName('w:body');
  const body = bodies.length ? bodies[0] : doc.documentElement;

  const chunks = [];
  for (let n = body.firstChild; n; n = n.nextSibling) {
    const ln = localName(n);
    if (ln === 'p') {
      const t = paragraphToText(n, ctx);
      if (t) chunks.push(t);
    } else if (ln === 'tbl') {
      const t = tableToText(n, ctx);
      if (t) chunks.push(t);
    }
  }

  // 读取并规范化图片：统一转 PNG、限制长边，EMF/WMF 无法解码则明确告警而不是静默丢弃
  const resolved = [];
  for (const img of images) {
    const ext = (img.path.split('.').pop() || '').toLowerCase();
    const raw = files[img.path];
    if (!raw) { warnings.push(`图${img.index} 的媒体文件缺失`); continue; }
    if (UNREADABLE.includes(ext)) {
      warnings.push(`图${img.index} 是 ${ext.toUpperCase()} 矢量格式，无法解码送入识别（Word 粘贴的图表常是此格式，建议在 Word 里另存为 PNG 后重试）`);
      continue;
    }
    try {
      const out = await sharp(Buffer.from(raw))
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      resolved.push({ index: img.index, mediaType: 'image/png', base64: out.toString('base64') });
    } catch (e) {
      const mt = VISION_TYPES[ext];
      if (mt) {
        resolved.push({ index: img.index, mediaType: mt, base64: Buffer.from(raw).toString('base64') });
      } else {
        warnings.push(`图${img.index} 解码失败（${ext || '未知格式'}）：${e.message}`);
      }
    }
  }

  return {
    kind: 'docx',
    text: chunks.join('\n\n'),
    images: resolved,
    equationCount: ctx.equationCount,
    warnings,
  };
}
