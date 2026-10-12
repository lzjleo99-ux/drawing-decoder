// 测试入口：起本地静态服务 → 无头 Chrome 打开 test/index.html → 取回结果。
//
//   node test/run.mjs
//
// 为什么不用 Node 直接跑测试：solver/ 的模块从 CDN 以 https:// URL import，
// Node 的 ESM 加载器不支持 https 说明符；且溢出测量要真实布局引擎、PDF 抽取要 canvas。
// 详见 test/tests.mjs 顶部说明。
//
// 为什么用 DevTools 协议而不是 --dump-dom：测试里有异步的 CDN 加载与 pdfjs 栅格化，
// --dump-dom 在 load 事件后就把 DOM 抓走，会拿到半截结果。这里改成轮询页面里的
// 状态变量，测试真正跑完才收工。
//
// 需要本机有 Chrome / Chromium / Edge / Brave 之一，可用 CHROME_PATH 指定。
//
// ─────────────────────────────────────────────────────────────────────────────
// [FIX] 缺陷说明与修复
//
// 原实现只有一个完成信号 window.__TEST_RESULT__，轮询循环是
//   while (Date.now() < deadline && !payload)   // deadline = now + 240000
// 而 <script type="module"> 的加载/解析是"全成全败"的：tests.mjs 顶部 import 的
// 任何一条取不到（离线、CDN 故障）或 tests.mjs 本身有语法错误，整个模块体一行都不
// 执行 —— 连它自己的 try/catch 都进不去，window.__TEST_RESULT__ 永远不赋值。
// 于是脚本静默空转 4 分钟，最后只打印一句"测试在 240s 内没有跑完"，真正的原因
// （哪一行语法错 / 哪个 URL 取不到）一个字都不给。
//
// 改法：
//   1) test/index.html 里在模块加载之前立一个内联经典脚本，把 window 的 error 与
//      unhandledrejection 兜住，写进 window.__HARNESS_ERROR__（并用捕获阶段接收
//      不冒泡的资源加载失败）。
//   2) 本文件把等待拆成三个阶段，彼此时延独立可配：
//      阶段一  等 __HARNESS_READY__  —— 区分"页面根本没起来"与"模块加载失败"
//      阶段二  轮询 { done, err, out } —— 见到 err 立刻带着真实原因退出
//      阶段三  即便一切正常也每 10s 打一次心跳，永远不再出现"没有任何输出"
//   3) 测试正常在本机约 20–30 秒，240s 的默认超时纯属浪费，下调到 120s 且可用
//      SOLVER_TEST_TIMEOUT_MS / SOLVER_TEST_BOOT_MS 覆盖。
// ─────────────────────────────────────────────────────────────────────────────
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

/** [FIX] 页面里求值一次；导航中途执行上下文不可用时静默返回 null，下一轮再试。 */
async function evaluate(send, expression) {
  try {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.value ?? null;
  } catch {
    return null;
  }
}

const chrome = findChrome();
if (!chrome) {
  console.error('找不到 Chrome / Chromium / Edge / Brave。用 CHROME_PATH=/path/to/chrome 指定。');
  process.exit(2);
}

// [FIX] 三段时间分开可配：Chrome 就绪 → 承载页挂载 → 测试跑完。
const BOOT_TIMEOUT = Number(process.env.SOLVER_TEST_BOOT_MS || 15_000);
const RUN_TIMEOUT = Number(process.env.SOLVER_TEST_TIMEOUT_MS || 120_000);
const HEARTBEAT = Number(process.env.SOLVER_TEST_HEARTBEAT_MS || 10_000);

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

/** [FIX] 只打有用的 Chrome 报错，滤掉 headless 环境下无害的噪音。 */
function usefulChromeErr() {
  const HARMLESS = /CVDisplayLinkCreateWithCGDisplay|DEPRECATED_ENDPOINT|updater|GCM|Selected adapter|panic|InitializeLog|crash-handler/i;
  return chromeErr
    .split('\n')
    .filter((l) => /ERROR|FATAL|SyntaxError|ERR_|net::|Uncaught|Failed to/i.test(l) && !HARMLESS.test(l))
    .slice(-20)
    .join('\n');
}

let exitCode = 1;
let ws = null;
try {
  // ---- Chrome 调试端口与页面目标 ----
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

  // ---- 阶段 1（[FIX] 新增）：等承载页自身挂载 ----
  // 单独拆出这一段，是为了把"页面根本没起来"（静态服务器路径写错、404、端口不通）
  // 和"页面起来了但测试模块加载失败"区分开 —— 这两类的修法完全不同。
  const bootDeadline = Date.now() + BOOT_TIMEOUT;
  let booted = false;
  while (Date.now() < bootDeadline && !booted) {
    booted = !!(await evaluate(send, 'window.__HARNESS_READY__'));
    if (!booted) await sleep(200);
  }
  if (!booted) {
    console.error('承载页未就绪。/test/index.html 没能跑起来：');
    console.error(`  ${server.url}test/index.html`);
    console.error('请用浏览器直接打开这个地址确认；常见原因是 test/ 目录路径不对或静态服务器未启动。');
    throw new Error('harness_not_ready');
  }

  // ---- 阶段 2：等测试跑完，同时盯承载页记录的致命错误 ----
  // 一次求值同时取三样东西：测试结果、致命错误、以及当前的 #out 正文。
  // #out 由 tests.mjs 边跑边写，取到 done 时它已经是完整的最后一段输出。
  const PROBE = 'JSON.stringify({'
    + ' done: window.__TEST_RESULT__ || null,'
    + ' err: window.__HARNESS_ERROR__ || null,'
    + ' out: document.getElementById("out").textContent'
    + ' })';

  const runDeadline = Date.now() + RUN_TIMEOUT;
  const startedAt = Date.now();
  let snap = null;
  let nextHeartbeat = Date.now() + HEARTBEAT;

  while (Date.now() < runDeadline && !snap) {
    const raw = await evaluate(send, PROBE);
    if (raw) {
      const o = JSON.parse(raw);
      if (o.done) snap = { kind: 'done', out: o.out, fail: o.done.fail };
      else if (o.err) snap = { kind: 'module_error', err: o.err, out: o.out };
    }
    // [FIX] 即便一切正常，每 10s 也打一次心跳，绝不出现"几分钟没有任何输出"
    if (!snap && Date.now() > nextHeartbeat) {
      console.log(`…仍在等待测试完成（已 ${Math.round((Date.now() - startedAt) / 1000)}s，`
        + `超时上限 ${Math.round(RUN_TIMEOUT / 1000)}s）`);
      nextHeartbeat = Date.now() + HEARTBEAT;
    }
    if (!snap) await sleep(1000);
  }

  // ---- 阶段 3：报结论 ----
  if (!snap) {
    console.error(`测试在 ${Math.round(RUN_TIMEOUT / 1000)}s 内没有跑完。`);
    console.error('可能是某个用例挂起；需要放宽可试 SOLVER_TEST_TIMEOUT_MS=240000。');
    const noise = usefulChromeErr();
    if (noise) console.error('\nChrome 报错（已滤掉噪音）：\n' + noise);
  } else if (snap.kind === 'module_error') {
    // [FIX] 这是修复的关键收益：失败时立刻拿到真实原因，而不是等 4 分钟
    console.error('测试模块加载/执行失败（常见原因：离线或 CDN 不可达导致 import 失败，'
      + '或 tests.mjs 存在语法错误）：');
    console.error(`  ${snap.err}`);
    const noise = usefulChromeErr();
    if (noise) console.error('\nChrome 报错（已滤掉噪音）：\n' + noise);
  } else {
    console.log(snap.out);
    exitCode = snap.fail === 0 ? 0 : 1;
  }
} catch (e) {
  console.error(`运行失败：${e.message}`);
  const noise = usefulChromeErr();
  if (noise) console.error(noise);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill('SIGKILL');
  await server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

process.exit(exitCode);
