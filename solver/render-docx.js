// 答卷 → .docx（浏览器内生成）。
//
// 公式走 OMML，是 Word 原生公式对象（可双击编辑），不是图片。
// 链路：LaTeX → temml → MathML → mathml2omml → OMML → 作为原始 XML 注入。
// 全程纯 JS，不需要 pandoc / LaTeX / Word。

import * as docx from 'https://cdn.jsdelivr.net/npm/docx@9.9.0/+esm';
import { FONTS, LAYOUT, DEFAULT_FONT } from './config.js';
import { latexToOmml, normalizeLatex, splitInlineMath } from './math.js';
import { sanitizeSvg } from './svg.js';

const {
  Document, Packer, Paragraph, TextRun, AlignmentType, ImportedXmlComponent,
  ImageRun, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  convertMillimetersToTwip,
} = docx;

const A4_W_MM = 210;
const A4_H_MM = 297;
const CONTENT_WIDTH_PX = Math.floor(((A4_W_MM - 2 * LAYOUT.marginMm) / 25.4) * 96);
/** 行距：Word 用 240 = 单倍行距，按倍数折算。 */
const LINE = Math.round(240 * LAYOUT.lineSpacing);

/**
 * 把 OMML 字符串变成可塞进段落的 docx 组件。
 *
 * 不能直接用 ImportedXmlComponent.fromXmlString 的返回值：它内部把 xml-js 的
 * "文档"对象（没有 name）当成元素交给转换器，真正的 m:oMath 被包在一个 rootKey
 * 为 undefined 的空壳里，序列化出 <undefined>...</undefined> —— Word 打不开。
 */
function ommlComponent(omml) {
  const wrapper = ImportedXmlComponent.fromXmlString(omml);
  if (wrapper?.rootKey === 'm:oMath') return wrapper;
  const real = (wrapper?.root || []).find((c) => c?.rootKey === 'm:oMath');
  if (!real) throw new Error('OMML 包装结构异常，未找到 m:oMath 节点');
  return real;
}

function mathChild(latex, display, stats) {
  const tex = normalizeLatex(latex);
  if (!tex) return null;
  const omml = latexToOmml(tex, display);
  if (omml) {
    try {
      const child = ommlComponent(omml);
      stats.ommlOk++;
      return child;
    } catch (e) {
      stats.warnings.push(`公式注入失败：${e.message}`);
    }
  }
  // 降级：保留 LaTeX 源码并计数上报，而不是悄悄插一张图假装成功
  stats.ommlFail++;
  stats.failedLatex.push(tex);
  return new TextRun({ text: ` ${tex} `, font: { ascii: 'Consolas', eastAsia: 'Consolas' }, color: 'B45309' });
}

/** 把混排文本切成 Word 的 run 序列，公式保持在原位。 */
function inlineChildren(text, stats) {
  const out = [];
  for (const part of splitInlineMath(text)) {
    if (part.kind === 'text') {
      part.value.split(/\*\*(.+?)\*\*/g).forEach((seg, i) => {
        if (seg) out.push(new TextRun({ text: seg, bold: i % 2 === 1 }));
      });
    } else {
      const child = mathChild(part.value, part.display, stats);
      if (child) out.push(child);
    }
  }
  return out;
}

/** SVG → PNG。用 canvas 代替 Node 版的 sharp。 */
async function svgToPng(svg, maxWidthPx) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // 没有显式宽高的 SVG，naturalWidth 可能为 0，退回 viewBox 推算
    let iw = img.naturalWidth;
    let ih = img.naturalHeight;
    if (!iw || !ih) {
      const vb = /viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/.exec(svg);
      iw = vb ? Number(vb[1]) : 400;
      ih = vb ? Number(vb[2]) : 300;
    }
    const width = Math.min(maxWidthPx, iw);
    const height = Math.round((ih / iw) * width);
    const cv = document.createElement('canvas');
    // 2 倍采样再按逻辑尺寸插入，避免矢量图栅格化后发虚
    cv.width = width * 2;
    cv.height = height * 2;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const png = await new Promise((resolve, reject) => {
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 导出失败'))), 'image/png');
    });
    return { data: new Uint8Array(await png.arrayBuffer()), width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function figureParagraphs(block, stats) {
  const { svg, removed } = sanitizeSvg(block.svg);
  if (!svg) { stats.svgRejected++; return []; }
  if (removed.length) stats.svgStripped.push(...removed);
  try {
    const { data, width, height } = await svgToPng(svg, CONTENT_WIDTH_PX);
    stats.figures++;
    const paras = [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 60, line: LINE },
      children: [new ImageRun({ type: 'png', data, transformation: { width, height } })],
    })];
    if (block.caption) {
      paras.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 160, line: LINE },
        children: [new TextRun({ text: block.caption, size: 18, color: '595959' })],
      }));
    }
    return paras;
  } catch (e) {
    stats.figureFail++;
    stats.warnings.push(`图形栅格化失败：${e.message}`);
    return [];
  }
}

function tableBlock(block) {
  const headers = Array.isArray(block.headers) ? block.headers : [];
  const rows = Array.isArray(block.rows) ? block.rows : [];
  if (!headers.length && !rows.length) return null;
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
  const borders = { top: border, bottom: border, left: border, right: border };
  const mk = (cells, bold) => new TableRow({
    children: cells.map((c) => new TableCell({
      borders,
      shading: bold ? { type: ShadingType.CLEAR, fill: 'F1F5F9' } : undefined,
      children: [new Paragraph({ spacing: { line: LINE }, children: [new TextRun({ text: String(c ?? ''), bold: !!bold })] })],
    })),
  });
  const trs = [];
  if (headers.length) trs.push(mk(headers, true));
  for (const r of rows) trs.push(mk(Array.isArray(r) ? r : [r], false));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: trs });
}

/**
 * 渲染答卷为 .docx。
 * @returns {Promise<{blob:Blob, stats:object}>}
 */
export async function renderDocx(answerDoc) {
  const fontKey = FONTS[answerDoc.meta?.font] ? answerDoc.meta.font : DEFAULT_FONT;
  const font = FONTS[fontKey].docx;
  const stats = { ommlOk: 0, ommlFail: 0, failedLatex: [], figures: 0, figureFail: 0,
    svgStripped: [], svgRejected: 0, warnings: [] };

  const children = [];
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 120, line: LINE },
    children: [new TextRun({ text: answerDoc.meta?.title || '作业解答', bold: true, size: 32 })],
  }));
  if (answerDoc.meta?.subtitle) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 320, line: LINE },
      children: [new TextRun({ text: answerDoc.meta.subtitle, size: 20, color: '595959' })],
    }));
  }

  for (const q of answerDoc.questions || []) {
    const heading = [q.number, q.title].filter(Boolean).join('、');
    if (heading) {
      children.push(new Paragraph({
        spacing: { before: 280, after: 120, line: LINE },
        children: [new TextRun({ text: heading, bold: true, size: 24 })],
      }));
    }
    if (q.statement) {
      children.push(new Paragraph({ spacing: { after: 160, line: LINE }, children: inlineChildren(q.statement, stats) }));
    }

    for (const block of q.blocks || []) {
      switch (block.type) {
        case 'text':
          children.push(new Paragraph({ spacing: { after: 120, line: LINE }, children: inlineChildren(block.text || '', stats) }));
          break;
        case 'equation': {
          const child = mathChild(block.latex || '', true, stats);
          if (child) {
            children.push(new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 120, after: 120, line: LINE },
              children: [child],
            }));
          }
          break;
        }
        case 'figure':
          children.push(...(await figureParagraphs(block, stats)));
          break;
        case 'table': {
          const t = tableBlock(block);
          if (t) { children.push(t); children.push(new Paragraph({ spacing: { after: 160, line: LINE }, text: '' })); }
          break;
        }
        case 'answer':
          children.push(new Paragraph({
            spacing: { before: 160, after: 200, line: LINE },
            shading: { type: ShadingType.CLEAR, fill: 'F8FAFC' },
            children: [new TextRun({ text: '答：', bold: true }), ...inlineChildren(block.text || '', stats)],
          }));
          break;
        default:
          break;
      }
    }
  }

  const doc = new Document({
    creator: '机械工程学习网页',
    title: answerDoc.meta?.title || '作业解答',
    styles: {
      default: {
        document: {
          run: { font: { ascii: font.ascii, eastAsia: font.eastAsia, hAnsi: font.ascii, cs: font.ascii }, size: LAYOUT.bodyPt * 2 },
          paragraph: { spacing: { line: LINE, lineRule: 'auto' } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: convertMillimetersToTwip(A4_W_MM), height: convertMillimetersToTwip(A4_H_MM) },
          margin: {
            top: convertMillimetersToTwip(LAYOUT.marginMm), right: convertMillimetersToTwip(LAYOUT.marginMm),
            bottom: convertMillimetersToTwip(LAYOUT.marginMm), left: convertMillimetersToTwip(LAYOUT.marginMm),
          },
        },
      },
      children,
    }],
  });

  return { blob: await Packer.toBlob(doc), stats };
}
