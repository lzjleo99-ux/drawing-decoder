// 极简静态服务器，服务于本地预览与测试。
//
// 存在的理由：本仓库的 JS 含中文正则，而 `python -m http.server` 之类不会为 .js
// 声明 charset，浏览器会按 Latin-1 解析，中文正则会直接抛
// "Range out of order in character class"。这里对所有文本类型显式带上 utf-8。
//
// 两种用法：
//   1) 命令行预览整个站点 —— node test/serve.mjs [根目录] [端口]
//   2) 被 test/run.mjs 作为模块引用（port 传 0 由系统分配空闲端口）
//
// ─────────────────────────────────────────────────────────────────────────────
// [FIX] 安全加固（原实现有两个可被利用的缺陷）
//
// 缺陷一：目录穿越（可跨出根目录读任意文件）
//   原判断是  file.startsWith(base)
//   这是**字符串前缀匹配，不是路径边界匹配**：若根目录是 /tmp/verify-target，
//   那么 /tmp/verify-target-secret/secret.txt 也以它开头，判断为"在目录内"。
//   实际验证过，下面三条原始路径都能拿到根目录之外的文件：
//     /../verify-target-secret/secret.txt
//     /%2e%2e/verify-target-secret/secret.txt      （先 decode 成 ..，再被 path.join 归一）
//     /..%2fverify-target-secret%2fsecret.txt
//   注意 fetch/XHR 会在客户端把 .. 归一化掉，所以浏览器里探不出来；
//   用 `curl --path-as-is` 这类不做归一化的客户端一发就中。
//
// 缺陷二：隐藏路径被下发
//   /.git/config、/.git/index、.git/objects/** 全部能以 200 返回，等于把版本库
//   内部文件挂在 HTTP 上。虽然默认只绑 127.0.0.1，但一旦有人为了手机联调把它
//   改成 0.0.0.0，就是真实的信息泄露。
//
// 修法：
//   1) 边界判断改为 base + path.sep（带上分隔符才叫"在目录内"）；
//   2) 拒绝任何以 "." 开头的路径段，仅白名单放行 .nojekyll（GitHub Pages 的空配置）。
//      decode 在判断之前完成，所以 %2e 这类编码变体同样覆盖。
// ─────────────────────────────────────────────────────────────────────────────
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

// [FIX] 允许通过 HTTP 访问的点号文件。只留 Pages 需要的空配置；
// legacy/ 里归档版本自带的 .gitignore 之类一律不对外。
const ALLOWED_DOT_SEGMENTS = new Set(['.nojekyll']);

// [FIX] 任一路径段以 "." 开头（解码后）即视为隐藏路径。
// size 判断放在解码之后，%2e%2e 与 .. 等价处理。
function isHiddenPath(urlPath) {
  return urlPath.split('/').some((seg) => {
    if (!seg) return false;                       // 前导 '/' 或空段，不是隐藏路径
    const s = seg.toLowerCase();
    return s.startsWith('.') && !ALLOWED_DOT_SEGMENTS.has(s);
  });
}

/**
 * 起一个只读静态服务。
 * @param {{root:string, port?:number, host?:string}} opts
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>}>}
 */
export function startServer({ root, port = 0, host = '127.0.0.1' }) {
  const base = path.resolve(root);

  // [FIX] 把根目录本身也解析成真实路径：macOS 上 /tmp、/var 都是指向
  //   /private/... 的软链接，归一化之后才能比较。
  let realBase = base;
  try { realBase = fs.realpathSync(base); } catch { /* 根目录不存在时保持原样，readFile 自然会 404 */ }

  // [FIX] 必须是"同一目录或其子目录"，而不是字符串前缀。
  //   少了"带路径分隔符"这一层，与根目录同前缀的兄弟目录（root-secret）就会被判为合法。
  //   这里保留两套边界：原始路径对原始根目录、解析后的路径对解析后的根目录。
  //   只用一套是错的 —— macOS 上 base 是 /var/... 而 realpath 后是 /private/var/...，
  //   拿未解析的 file 去比解析后的 realBase 会把所有请求都判成越界（实测全 403）。
  const prefix = (p) => (p.endsWith(path.sep) ? p : p + path.sep);
  const rawInside = (p) => p === base || p.startsWith(prefix(base));
  const realInside = (p) => p === realBase || p.startsWith(prefix(realBase));

  // [FIX] 不只比路径字符串，还要解析符号链接后再比一次。
  //   否则"根目录内放一个指向外部的软链接"仍然能走出去 —— path.join 不解析软链接。
  const resolved = (file) => {
    try { return fs.realpathSync(file); } catch { return file; }
  };

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

    // [FIX] 隐藏路径优先挡掉（.git / .env / .DS_Store …）
    if (isHiddenPath(urlPath)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('forbidden: hidden path');
      return;
    }

    const file = path.join(base, urlPath === '/' ? '/index.html' : urlPath);

    // [FIX] 路径边界校验：字符串边界 + 软链接边界。
    //   软链接边界只在"确实解析出了别的东西"时才生效：文件不存在时 realpath 会失败、
    //   拿未解析的路径去比解析后的根目录必然不匹配，那样会把本该返回 404 的请求误判成 403。
    const real = resolved(file);
    if (!rawInside(file) || (real !== file && !realInside(real))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('forbidden: path escapes the served root');
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
