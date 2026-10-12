// 静态服务器的路径安全回归测试（跑在 Node 侧，不跑浏览器）。
//
// 为什么这一节必须在 Node 里而不是跟着 tests.mjs 跑在浏览器里：
// 浏览器 fetch/XHR 会在客户端就把 ".." 归一化掉，请求根本到不了服务器；
// Node 的 http.request 会原样发送路径字符串（等价 curl --path-as-is）。
// 如果只在浏览器里测，目录穿越这类问题永远探不出来 —— 之前正是因此漏掉的。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './serve.mjs';

/** 原样发送路径，不做任何归一化。 */
function rawGet(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export async function checkServerSafety() {
  const lines = [];
  let pass = 0;
  const failures = [];
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; lines.push(`  ok   ${name}`); }
    else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); lines.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-safety-'));
  // 关键构造：兄弟目录的名字以根目录名开头（root + "-secret"）。
  // 这正是 startsWith 前缀判断会放过的那一类，专门用来锁死该回归。
  const root = path.join(work, 'root');
  const sibling = root + '-secret';
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });

  const CANARY_SIBLING = 'SIBLING-CANARY-9917';
  const CANARY_DOTENV = 'DOTENV-CANARY-4412';
  const CANARY_GIT = 'GIT-CONFIG-CANARY-2285';
  fs.writeFileSync(path.join(root, 'index.html'), '<!DOCTYPE html><title>ok</title>');
  fs.writeFileSync(path.join(root, '.nojekyll'), '');
  fs.writeFileSync(path.join(root, '.env'), CANARY_DOTENV + '\n');
  fs.writeFileSync(path.join(root, '.git', 'config'), CANARY_GIT + '\n');
  fs.writeFileSync(path.join(root, '.git', 'index'), 'binary');
  fs.writeFileSync(path.join(sibling, 'leak.txt'), CANARY_SIBLING + '\n');
  // 根目录内的软链接，指向根目录外的兄弟目录。
  // 字符串边界看不出任何问题（路径文本确实在根目录内），只能靠 realpath 拦。
  fs.symlinkSync(sibling, path.join(root, 'link-out'));

  const server = await startServer({ root });
  try {
    const get = (p) => rawGet(server.port, p);

    const home = await get('/index.html');
    check('根目录内文件正常返回 200', home.status === 200, String(home.status));

    // ---- 隐藏路径 ----
    for (const p of ['/.env', '/.git/config', '/.git/index', '/.DS_Store']) {
      const r = await get(p);
      check(`拒绝隐藏路径 ${p}`, r.status === 403, String(r.status));
    }
    for (const [name, canary] of [['/.env', CANARY_DOTENV], ['/.git/config', CANARY_GIT]]) {
      const r = await get(name);
      check(`${name} 未泄露金丝雀内容`, !r.body.includes(canary));
    }
    const nj = await get('/.nojekyll');
    check('.nojekyll 白名单仍可访问', nj.status === 200, String(nj.status));

    // ---- 目录穿越（raw path，浏览器里测不到）----
    const escapes = [
      `/../${path.basename(sibling)}/leak.txt`,
      `/%2e%2e/${path.basename(sibling)}/leak.txt`,
      `/..%2f${path.basename(sibling)}%2fleak.txt`,
    ];
    for (const p of escapes) {
      const r = await get(p);
      check(`拒绝目录穿越 ${p}`, r.status === 403, String(r.status));
      check(`穿越未泄露金丝雀内容（${p.slice(0, 18)}…）`, !r.body.includes(CANARY_SIBLING));
    }

    // ---- 软链接逃逸：字符串边界看不出问题，只有 realpath 拦得住 ----
    const viaLink = await get('/link-out/leak.txt');
    check('拒绝软链接逃逸到根目录外', viaLink.status === 403, String(viaLink.status));
    check('软链接逃逸未泄露金丝雀内容', !viaLink.body.includes(CANARY_SIBLING));

    // ---- 语义不变的常规请求 ----
    const q = await get('/index.html?x=1');
    check('带查询串的请求正常', q.status === 200, String(q.status));
    const nf = await get('/nope.html');
    check('不存在的文件返回 404', nf.status === 404, String(nf.status));
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }

  lines.push(`\n${'─'.repeat(50)}`);
  lines.push(`静态服务器路径安全：通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    lines.push('\n失败项：');
    for (const f of failures) lines.push(`  · ${f}`);
  }
  return { text: lines.join('\n'), pass, fail: failures.length };
}
