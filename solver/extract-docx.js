// .docx 抽取：把 Word 文档线性化成"带 LaTeX 公式标记的纯文本 + 图片列表"。
//
// 这里不用 mammoth。mammoth 会整段丢弃 Word 公式，而公式对理工科试卷就是题目本身；
// 自己遍历 document.xml 才能在正确位置插入公式（公式与上下文的相对位置必须保留，
// 否则"求下式的积分"后面跟不上式子，题目就不完整了）。
// 附带好处：去掉 mammoth 后依赖树里不再有已知漏洞。

import { unzipSync, strFromU8 } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm';
import { ommlElementToLatex } from './omml2latex.js';
// DOMParser 用浏览器原生的；图片缩放用 canvas 代替 sharp

// Claude 视觉通道支持的图片类型
const VISION_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
};
// 这些格式 Word 里很常见（粘贴的图表/公式图），但浏览器解码不了，只能提示用户另存为 PNG
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

/** 取指定 localName 的直接子元素（不递归）。 */
function child(el, localName) {
  if (!el) return null;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.localName === localName) return n;
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


/** 长边超过上限就用 canvas 缩小：省 token，也避开视觉通道的体积限制。 */
async function shrinkIfNeeded(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    const longest = Math.max(bmp.width, bmp.height);
    if (longest <= MAX_EDGE) return blob;
    const k = MAX_EDGE / longest;
    const cv = document.createElement('canvas');
    cv.width = Math.round(bmp.width * k);
    cv.height = Math.round(bmp.height * k);
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    return await new Promise((resolve, reject) => {
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 导出失败'))), 'image/png');
    });
  } finally {
    bmp.close?.();
  }
}


/**
 * 文档默认字号（pt）。Word 的 w:sz 是"半点"，24 = 12pt。
 */
function defaultPt(files) {
  const styles = files['word/styles.xml'];
  if (!styles) return null;
  const m = /<w:docDefaults[\s\S]*?<w:sz\s+w:val="(\d+)"/.exec(strFromU8(styles));
  return m ? Number(m[1]) / 2 : null;
}

/**
 * 量出原卷的正文字号（pt）。
 *
 * 不能简单统计 w:sz 出现次数：Word 的正文段落通常不写显式字号（继承文档默认），
 * 写了显式字号的往往恰恰是标题这类少数文本。所以按"字符数"加权，
 * 并把"没有显式字号"单独算一桶，该桶胜出时用文档默认值。
 * @param {Map<number|null, number>} charsBySize 半点字号 → 字符数，null 表示继承
 */
function detectBodyPt(charsBySize, files) {
  if (!charsBySize.size) return defaultPt(files);
  let bestKey = null;
  let bestChars = -1;
  for (const [half, chars] of charsBySize) {
    if (chars > bestChars) { bestChars = chars; bestKey = half; }
  }
  if (bestKey === null) return defaultPt(files);
  const pt = bestKey / 2;
  return pt >= 6 && pt <= 36 ? pt : defaultPt(files);
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
      // 记录这个 run 的字号与字符数，供 detectBodyPt 做加权统计
      if (ctx.charsBySize) {
        const szEl = child(child(n, 'rPr'), 'sz');
        const half = szEl ? Number(attrNS(szEl, 'val')) : null;
        const key = Number.isFinite(half) ? half : null;
        const len = runToText(n).length;
        if (len) ctx.charsBySize.set(key, (ctx.charsBySize.get(key) || 0) + len);
      }
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
  const pPr = child(p, 'pPr');

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
    charsBySize: new Map(),
    nextImageIdx: 1,
    // 图片按首次出现顺序编号，文本里留下 [图N] 标记供模型与图片列表对应
    addImage(rid) {
      // [FIX L4] 重复引用时也要区分"已识别"和"超限未识别"，否则同一张超限图
      // 第二次出现会被标成 [图N]，看起来像已经送进视觉通道了。
      if (seen.has(rid)) {
        const n = seen.get(rid);
        return images.some((i) => i.index === n) ? ` [图${n}] ` : ` [图${n}·未识别] `;
      }
      const target = rels.get(rid);
      if (!target) return '';
      // [FIX L4] 编号必须用单调递增计数器，不能用 seen.size + 1。
      // 超过 MAX_IMAGES 的图片原来不写入 seen，于是下一张超限图算出同样的编号，
      // 文本里出现多个 [图13·未识别]，模型无法区分是第几张。
      const idx = ctx.nextImageIdx++;
      seen.set(rid, idx);
      if (images.length >= MAX_IMAGES) {
        if (!warnings.some((w) => w.includes('图片数量'))) {
          warnings.push(`图片数量超过 ${MAX_IMAGES} 张，其余图片未送入识别`);
        }
        return ` [图${idx}·未识别] `;
      }
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

  // 读取并规范化图片：统一成可送入视觉通道的 Blob。
  // 这里用 canvas 代替 Node 版的 sharp —— 浏览器里本来就有栅格化能力。
  const resolved = [];
  for (const img of images) {
    const ext = (img.path.split('.').pop() || '').toLowerCase();
    const raw = files[img.path];
    if (!raw) { warnings.push(`图${img.index} 的媒体文件缺失`); continue; }
    if (UNREADABLE.includes(ext)) {
      warnings.push(`图${img.index} 是 ${ext.toUpperCase()} 矢量格式，浏览器无法解码（Word 粘贴的图表常是此格式，建议在 Word 里另存为 PNG 后重试）`);
      continue;
    }
    const mime = VISION_TYPES[ext];
    if (!mime) { warnings.push(`图${img.index} 格式不支持识别（${ext || '未知'}）`); continue; }
    try {
      const blob = await shrinkIfNeeded(new Blob([raw], { type: mime }));
      resolved.push({ index: img.index, blob });
    } catch (e) {
      warnings.push(`图${img.index} 解码失败：${e.message}`);
    }
  }

  return {
    kind: 'docx',
    bodyPt: detectBodyPt(ctx.charsBySize, files),
    text: chunks.join('\n\n'),
    images: resolved,
    equationCount: ctx.equationCount,
    warnings,
  };
}
