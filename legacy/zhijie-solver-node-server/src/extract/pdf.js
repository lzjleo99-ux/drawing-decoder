// .pdf 抽取。
//
// 策略：PDF 的首选通道是把原始字节直接交给 Claude 的 document 块 —— 模型能同时读到
// 文字、公式和图形，比任何本地文字层抽取都准。本模块因此只做两件事：
//   1. 抽出文字层，作为上下文提示（也用于判断是否扫描件）；
//   2. 判断能否走视觉通道（体积上限），不能走时文字层就是唯一依据。
// 之所以不在本地把页面渲染成图片：那需要 canvas 原生模块（依赖 cairo），
// 本机没有 Homebrew 装不了，而 document 块本来就比自己截图更准。

import { createRequire } from 'node:module';
import { UPLOAD } from '../config.js';

const require = createRequire(import.meta.url);

/** 懒加载 pdfjs：它体积大且只在处理 PDF 时需要。 */
async function loadPdfjs() {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Node 下不用 worker 线程，关掉以免去找 worker 文件
  lib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  return lib;
}

/**
 * 把一页的文字片段按版面重组成行。
 * pdfjs 给的是一堆带坐标的碎片，直接拼接会把多列/多行揉成一团，
 * 所以先按 y 坐标分行，再按 x 排序。
 */
function itemsToLines(items) {
  const lines = [];
  for (const it of items) {
    if (typeof it.str !== 'string' || !it.str.length) continue;
    const y = Math.round((it.transform?.[5] ?? 0) * 10) / 10;
    const x = it.transform?.[4] ?? 0;
    // 同一行允许 2.5pt 的 y 抖动（上下标、不同字号会有微小偏移）
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
      // 片段之间有明显间隙时补一个空格，否则 "F_t" 和 "tan" 会粘成一个词
      if (prevEnd !== null && p.x - prevEnd > 1.2 && !/\s$/.test(s)) s += ' ';
      s += p.str;
      prevEnd = p.x + p.str.length * 0.5;
    }
    return s.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
}

/**
 * 抽取 .pdf。
 * @param {Buffer} buf
 * @returns {Promise<{kind:string,text:string,pageCount:number,pdfBase64:string|null,warnings:string[]}>}
 */
export async function extractPdf(buf) {
  const pdfjs = await loadPdfjs();
  const warnings = [];

  // destroy() 挂在 loading task 上（v6 起 document proxy 只有 cleanup()），
  // 所以必须留着 task 的引用才能释放资源
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    // 关掉字体/系统字体加载：我们只要文字，不渲染
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  });
  const doc = await task.promise;

  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const lines = itemsToLines(tc.items);
    pages.push(`--- 第 ${i} 页 ---\n${lines.join('\n')}`);
    page.cleanup();
  }
  const text = pages.join('\n\n');
  await task.destroy();

  // 文字层极少 → 大概率是扫描件，此时视觉通道是唯一出路
  const charsPerPage = text.replace(/--- 第 \d+ 页 ---/g, '').trim().length / Math.max(1, doc.numPages);
  const looksScanned = charsPerPage < 50;

  const canUseVision = buf.length <= UPLOAD.pdfVisionMaxBytes;
  if (!canUseVision) {
    warnings.push(`PDF 体积 ${(buf.length / 1048576).toFixed(1)}MB 超过视觉通道上限 ${UPLOAD.pdfVisionMaxBytes / 1048576}MB，仅使用文字层解析，图形题可能识别不全`);
  }
  if (looksScanned && !canUseVision) {
    warnings.push('文档几乎没有文字层（疑似扫描件）且无法走视觉通道，解析结果可能不可用');
  } else if (looksScanned) {
    warnings.push('文档几乎没有文字层（疑似扫描件），将完全依赖视觉识别');
  }

  return {
    kind: 'pdf',
    text,
    pageCount: doc.numPages,
    pdfBase64: canUseVision ? buf.toString('base64') : null,
    images: [],
    equationCount: 0,
    warnings,
  };
}
