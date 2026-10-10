// .pdf 抽取（浏览器版）。
//
// 和 Node 版的关键差别：Node 版把 PDF 原始字节当作 document 块交给 Claude，
// 但本站的桥接层只接受图片。浏览器里反而更好办 —— pdf.js 可以直接把页面
// 画到 canvas 上，再转成图片送进视觉通道。Node 版做不到这点是因为
// 服务端渲染需要 canvas 原生模块（依赖 cairo），本机装不了。

import { PDF_VISION_MAX_PAGES, PDF_RENDER_SCALE } from './config.js';

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/+esm';
const WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs';

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = WORKER_URL;
      return lib;
    });
  }
  return pdfjsPromise;
}

/**
 * 把一页的文字片段按版面重组成行。
 * pdf.js 给的是一堆带坐标的碎片，直接拼接会把多行揉成一团。
 */
function itemsToLines(items) {
  const lines = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str.length) continue;
    const y = Math.round((it.transform?.[5] ?? 0) * 10) / 10;
    const x = it.transform?.[4] ?? 0;
    let line = lines.find((l) => Math.abs(l.y - y) < 2.5);
    if (!line) { line = { y, parts: [] }; lines.push(line); }
    line.parts.push({ x, str: it.str });
  }
  lines.sort((a, b) => b.y - a.y); // PDF 坐标系自下而上
  return lines.map((l) => {
    l.parts.sort((a, b) => a.x - b.x);
    let s = '';
    let prevEnd = null;
    for (const p of l.parts) {
      if (prevEnd !== null && p.x - prevEnd > 1.2 && !/\s$/.test(s)) s += ' ';
      s += p.str;
      prevEnd = p.x + p.str.length * 0.5;
    }
    return s.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
}

/** 把一页渲染成 PNG Blob，供视觉通道识别公式与图形。 */
async function renderPageToBlob(page) {
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  // 白底：PDF 透明区域在 PNG 里会变黑，模型会看不清
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('页面栅格化失败'))), 'image/png');
  });
}

/**
 * 抽取 .pdf。
 * @param {ArrayBuffer|Uint8Array} buf
 * @param {(msg:string, level?:string)=>void} log
 */
export async function extractPdf(buf, log = () => {}) {
  const pdfjs = await loadPdfjs();
  const warnings = [];

  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false });
  const doc = await task.promise;

  const pages = [];
  const images = [];
  const visionPages = Math.min(doc.numPages, PDF_VISION_MAX_PAGES);

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(`--- 第 ${i} 页 ---\n${itemsToLines(tc.items).join('\n')}`);
    if (i <= visionPages) {
      log(`正在渲染第 ${i}/${visionPages} 页供识别…`);
      images.push({ index: i, blob: await renderPageToBlob(page) });
    }
    page.cleanup();
  }

  const text = pages.join('\n\n');
  const pageCount = doc.numPages;
  await task.destroy();

  if (pageCount > visionPages) {
    warnings.push(`文档共 ${pageCount} 页，仅前 ${visionPages} 页送入视觉识别（单次请求的图片数量上限），其余页只用文字层`);
  }

  const charsPerPage = text.replace(/--- 第 \d+ 页 ---/g, '').trim().length / Math.max(1, pageCount);
  if (charsPerPage < 50) {
    warnings.push('文档几乎没有文字层（疑似扫描件），将完全依赖视觉识别');
  }

  return { kind: 'pdf', text, pageCount, images, equationCount: 0, warnings };
}
