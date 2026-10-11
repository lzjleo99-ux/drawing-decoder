// 极简静态服务器，服务于本地预览与测试。
//
// 存在的理由：本仓库的 JS 含中文正则，而 `python -m http.server` 之类不会为 .js
// 声明 charset，浏览器会按 Latin-1 解析，中文正则直接抛
// "Range out of order in character class"。这里对所有文本类型显式带上 utf-8。
//
// 两种用法：
//   1) 命令行预览整个站点 —— node test/serve.mjs [根目录] [端口]
//   2) 被 test/run.mjs 作为模块引用（port 传 0 由系统分配空闲端口）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * 起一个只读静态服务。
 * @param {{root:string, port?:number, host?:string}} opts
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>}>}
 */
export function startServer({ root, port = 0, host = '127.0.0.1' }) {
  const base = path.resolve(root);

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(base, urlPath === '/' ? '/index.html' : urlPath);

    // 目录穿越防护
    if (!file.startsWith(base)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`not found: ${urlPath}`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        url: `http://${host}:${actual}/`,
        port: actual,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// 直接执行时按命令行参数起服务
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const root = process.argv[2] || path.join(import.meta.dirname, '..');
  const port = Number(process.argv[3] || process.env.PORT || 8099);
  const { url } = await startServer({ root, port });
  console.log(`serving ${path.resolve(root)} at ${url}`);
}
