// 测试入口：起本地静态服务 → 无头 Chrome 打开 test/index.html → 取回结果。
//
//   node test/run.mjs
//
// 为什么不用 Node 直接跑测试：solver/ 的模块从 CDN 以 https:// URL import，
// Node 的 ESM 加载器不支持 https 说明符；且溢出测量要真实布局引擎、PDF 抽取要 canvas。
// 详见 test/tests.mjs 顶部说明。
//
// 为什么用 DevTools 协议而不是 --dump-dom：测试里有异步的 CDN 加载与 pdfjs 栅格化，
// --dump-dom 在 load 事件后就把 DOM 抓走，会拿到半截结果。这里改成轮询
// window.__TEST_RESULT__，测试真正跑完才收工。
//
// 需要本机有 Chrome / Chromium / Edge / Brave 之一，可用 CHROME_PATH 指定。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './serve.mjs';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  // Linux
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* 继续找 */ }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端：按 id 配对请求与响应。 */
function makeCdp(ws) {
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const chrome = findChrome();
if (!chrome) {
  console.error('找不到 Chrome / Chromium / Edge / Brave。用 CHROME_PATH=/path/to/chrome 指定。');
  process.exit(2);
}

const root = path.join(import.meta.dirname, '..');
const server = await startServer({ root });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'solver-test-'));

const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
  '--hide-scrollbars',
  '--window-size=1280,900',
  '--remote-debugging-port=0',
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  // 容器 / CI / 受限环境下 Chrome 的 setuid 沙箱无法初始化（会直接 FATAL 退出）。
  // 这个实例只加载本地静态页、用的是临时 profile，不碰用户的浏览器配置。
  // 想恢复沙箱：SOLVER_TEST_SANDBOX=1 node test/run.mjs
  ...(process.env.SOLVER_TEST_SANDBOX === '1' ? [] : ['--no-sandbox', '--disable-setuid-sandbox']),
  'about:blank',
];

const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
child.stderr.on('data', (c) => { chromeErr += c; });

let exitCode = 1;
let ws = null;
try {
  // Chrome 把实际端口写进 profile 下的 DevToolsActivePort
  const portFile = path.join(profile, 'DevToolsActivePort');
  let devtoolsPort = null;
  for (let i = 0; i < 100 && devtoolsPort === null; i++) {
    try { devtoolsPort = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]); } catch { await sleep(100); }
  }
  if (!devtoolsPort) throw new Error('Chrome 未能在 10s 内打开调试端口');

  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 还没起来 */ }
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('找不到可用的页面调试目标');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });

  const send = makeCdp(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${server.url}test/index.html` });

  // 轮询到测试自己声明跑完为止
  const deadline = Date.now() + 240000;
  let payload = null;
  while (Date.now() < deadline && !payload) {
    try {
      const r = await send('Runtime.evaluate', {
        expression: 'window.__TEST_RESULT__'
          + ' ? JSON.stringify({ r: window.__TEST_RESULT__, out: document.getElementById("out").textContent })'
          + ' : ""',
        returnByValue: true,
      });
      const v = r?.result?.value;
      if (v) payload = JSON.parse(v);
    } catch { /* 页面还在导航，下一轮再试 */ }
    if (!payload) await sleep(1000);
  }

  if (!payload) {
    console.error('测试在 240s 内没有跑完。Chrome 输出末尾：');
    console.error(chromeErr.slice(-1500));
  } else {
    console.log(payload.out);
    exitCode = payload.r.fail === 0 ? 0 : 1;
  }
} catch (e) {
  console.error(`运行失败：${e.message}`);
  if (chromeErr) console.error(chromeErr.slice(-1500));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill('SIGKILL');
  await server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

process.exit(exitCode);
