// .pdf 抽取（浏览器版）。
//
// 和 Node 版的关键差别：Node 版把 PDF 原始字节当作 document 块交给 Claude，
// 但本站的桥接层只接受图片。浏览器里反而更好办 —— pdf.js 可以直接把页面
// 画到 canvas 上，再转成图片送进视觉通道。Node 版做不到这点是因为
// 服务端渲染需要 canvas 原生模块（依赖 cairo），本机装不了。

import { PDF_VISION_MAX_PAGES, PDF_RENDER_SCALE, PDF_FIGURE_SCALE } from './config.js';

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/+esm';
const WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs';

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = WORKER_URL;
      return lib;
    }).catch((err) => {
      // [FIX M4] 失败时必须把缓存清空。原来这里把 rejected promise 永久留在
      // pdfjsPromise 里，一次离线（或 CDN 临时 5xx）之后，网络恢复了也永远解析不了
      // PDF，用户必须手动刷新页面 —— 看起来就像"这个功能坏了"。
      pdfjsPromise = null;
      throw err;
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

/**
 * 量出原卷正文字号（pt）。
 * pdf.js 的 transform 是 [a,b,c,d,e,f]，竖直缩放量 hypot(c,d) 就是字号（PDF 单位即 pt）。
 * 同样取众数当正文字号；读不到返回 null。
 */
function detectBodyPt(sizeCounts) {
  if (!sizeCounts.size) return null;
  const best = [...sizeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return Math.round(best * 2) / 2; // 归到 0.5pt
}

/**
 * 探测一页里有没有图形。
 * 两类都算：位图（paintImageXObject 等）和矢量线条图——工程图、受力图、
 * 坐标系大多是矢量路径画出来的，只看位图会把它们全漏掉。
 * @returns {{images:number, paths:number, hasFigure:boolean}}
 */
async function detectFigures(page, OPS) {
  try {
    const ops = await page.getOperatorList();
    let images = 0;
    let paths = 0;
    for (const fn of ops.fnArray) {
      if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) images++;
      else if (fn === OPS.constructPath) paths++;
    }
    // 阈值是量出来的，不是拍的：pdf.js 会把整条路径序列合并成一个 constructPath，
    // 实测纯文字页只有 1 个（页眉线之类），矢量受力图页 10 个，内嵌图页 3 个。
    // 定在 3 既能抓住图，也不会把纯文字页误判进来。
    // 代价：带框线的表格页可能被当成有图——多渲染一页只是多花点 token，不会出错。
    return { images, paths, hasFigure: images > 0 || paths >= 3 };
  } catch {
    return { images: 0, paths: 0, hasFigure: false };
  }
}

/** 把一页渲染成 PNG Blob，供视觉通道识别公式与图形。 */
async function renderPageToBlob(page, scale = PDF_RENDER_SCALE) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  // 白底：PDF 透明区域在 PNG 里会变黑，模型会看不清
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    await page.render({ canvasContext: ctx, viewport }).promise;
    return await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('页面栅格化失败'))), 'image/png');
    });
  } finally {
    // [FIX L5] 主动把像素缓冲缩到 0。A4 在 2.2 倍下约 1300×1850（单张 ~10MB），
    // 10 页峰值可达 100MB；不显式释放的话移动端 Safari 容易在中途被杀。
    canvas.width = 0;
    canvas.height = 0;
  }
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

  // [FIX H1] 任务生命周期必须由 finally 兜住。
  // 原来 task.destroy() 写在函数最后一行，中途任何一步抛错（损坏页、内存不足、
  // canvas.toBlob 返回 null）都会跳过它，pdfjs 的 worker 线程与整份 PDF 的
  // Uint8Array 就一直活着 —— 连续上传几个坏文件后内存持续上涨，最后连正常文件
  // 也解不开。改成 try/finally 后，成功失败都释放。
  try {
    return await extractWithTask(pdfjs, task, warnings, log);
  } finally {
    try { await task.destroy(); } catch { /* 已经销毁过 */ }
  }
}

/** 真正的抽取流程。单独拆出来，是为了让 task 的销毁由上面的 finally 统一负责。 */
async function extractWithTask(pdfjs, task, warnings, log) {
  const doc = await task.promise;

  const pages = [];
  const images = [];
  const sizeCounts = new Map();

  // 第一遍：抽文字、量字号、探测图形。不在这一遍渲染，
  // 因为要先知道哪些页有图，才能决定把有限的图片名额给谁。
  const survey = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim() || !it.transform) continue;
      const pt = Math.round(Math.hypot(it.transform[2], it.transform[3]) * 2) / 2;
      if (pt >= 6 && pt <= 36) sizeCounts.set(pt, (sizeCounts.get(pt) || 0) + it.str.length);
    }
    const lines = itemsToLines(tc.items);
    const chars = lines.join('').length;
    pages.push(`--- 第 ${i} 页 ---\n${lines.join('\n')}`);
    const fig = await detectFigures(page, pdfjs.OPS);
    survey.push({ i, page, chars, ...fig });
  }

  // 名额分配：有图的页优先，其次是文字极少的页（多半是扫描件），
  // 其余按页序补齐。最后仍按页序送出，保持与题目顺序一致。
  const budget = Math.min(doc.numPages, PDF_VISION_MAX_PAGES);
  const ranked = [...survey].sort((a, b) => {
    if (a.hasFigure !== b.hasFigure) return a.hasFigure ? -1 : 1;
    if (a.chars < 50 !== (b.chars < 50)) return a.chars < 50 ? -1 : 1;
    return a.i - b.i;
  });
  const chosen = new Set(ranked.slice(0, budget).map((x) => x.i));
  const figurePages = survey.filter((x) => x.hasFigure).length;

  for (const item of survey) {
    if (chosen.has(item.i)) {
      // 含图的页用更高倍率渲染：受力图上的小字号标注在 1.5 倍下常常糊掉
      const scale = item.hasFigure ? PDF_FIGURE_SCALE : PDF_RENDER_SCALE;
      log(`正在渲染第 ${item.i} 页${item.hasFigure ? '（含图形）' : ''}…`);
      images.push({ index: item.i, blob: await renderPageToBlob(item.page, scale) });
    }
    item.page.cleanup();
  }

  const text = pages.join('\n\n');
  const pageCount = doc.numPages;
  // [FIX H1] 原来这里有一行 `await task.destroy();`，现在统一由 extractPdf 的 finally 负责。

  if (pageCount > budget) {
    const picked = [...chosen].sort((a, b) => a - b).join(', ');
    warnings.push(`文档共 ${pageCount} 页，受单次请求图片数量上限所限只送了 ${budget} 页（第 ${picked} 页，含图形的页优先），其余页仅使用文字层`);
  }
  if (figurePages) warnings.push(`检测到 ${figurePages} 页含图形，已按更高倍率渲染以便识别图中标注`);

  const charsPerPage = text.replace(/--- 第 \d+ 页 ---/g, '').trim().length / Math.max(1, pageCount);
  if (charsPerPage < 50) {
    warnings.push('文档几乎没有文字层（疑似扫描件），将完全依赖视觉识别');
  }

  return { kind: 'pdf', bodyPt: detectBodyPt(sizeCounts), text, pageCount, images, equationCount: 0, warnings };
}
