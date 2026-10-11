// 答卷 HTML → PDF（无头 Chrome）。
//
// 本机没有 LaTeX / LibreOffice，Chrome 是现成且排版可靠的选择。
// 关键点：PDF 的页面尺寸与页边距直接取 HTML 里的 @page（preferCSSPageSize），
// 不在这里重复设置 —— 版式参数只有 config.js 一个来源。
//
// 同时把页内溢出修正脚本的结果读出来，用于日志上报：
// "检测到版面溢出并重排"是实测结果，不是写死的提示语。

import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  // Linux（Codespaces / 容器 / 服务器部署）
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* 忽略权限问题，继续找下一个 */ }
  }
  return null;
}

let browserPromise = null;

/** 复用单个浏览器实例：每次请求都启动 Chrome 太慢（约 300ms+）。 */
async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    if (b.connected) return b;
    browserPromise = null; // 实例已断开，重新启动
  }
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error(
      '找不到可用的 Chrome。请安装 Google Chrome，或用环境变量 CHROME_PATH 指定浏览器可执行文件路径。',
    );
  }
  browserPromise = puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  try { (await browserPromise).close(); } catch { /* 关闭失败不影响退出 */ }
  browserPromise = null;
}

/**
 * HTML → PDF。
 * @param {string} html 自包含的答卷 HTML
 * @returns {Promise<{buffer:Buffer, adjusted:Array<{index:number,scale:string}>}>}
 */
export async function renderPdf(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    // 等页内溢出修正跑完；字体加载后脚本会再跑一次，这里给它机会
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-fit-done') === '1',
      { timeout: 10000 },
    ).catch(() => { /* 超时则按未修正继续出 PDF，有总比没有好 */ });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});

    const adjusted = await page.evaluate(() => window.__eqAdjusted || []);
    const buffer = await page.pdf({
      printBackground: true,
      preferCSSPageSize: true, // 页面尺寸与边距来自 HTML 的 @page
    });
    return { buffer: Buffer.from(buffer), adjusted };
  } finally {
    await page.close();
  }
}
