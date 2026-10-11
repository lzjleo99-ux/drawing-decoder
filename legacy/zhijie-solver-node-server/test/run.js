// 测试：公式转换、文档抽取、三种渲染、以及走 HTTP 的端到端流程。
// 端到端部分用空跑模式（SOLVER_DRY_RUN=1），不调用模型、不花钱。

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import temmlPkg from 'temml';
import { mml2omml } from 'mathml2omml';
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';

import { ommlToLatex } from '../src/extract/omml2latex.js';
import { latexToOmml, splitInlineMath } from '../src/render/math.js';
import { extract } from '../src/extract/index.js';
import { renderDocx } from '../src/render/docx.js';
import { renderHtml } from '../src/render/html.js';
import { renderPdf, closeBrowser } from '../src/render/pdf.js';
import { sanitizeSvg } from '../src/render/svg.js';

const temml = temmlPkg.default ?? temmlPkg;
let pass = 0; const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function section(title) { console.log(`\n${title}`); }

// temml 对未定义控制字不抛异常而是产出错误节点，必须一并检查
function latexRenders(tex) {
  try {
    const out = temml.renderToString(tex, { xml: true, throwOnError: true });
    return !/merror|temml-error/.test(out);
  } catch { return false; }
}

// ---------------------------------------------------------------- 公式转换

section('OMML ↔ LaTeX');
{
  const cases = [
    String.raw`T_1 = 9.55 \times 10^6 \frac{P}{n_1}`,
    String.raw`F_r = F_t \tan(\alpha) \cos(\beta)`,
    String.raw`\int_{0}^{1} x e^{2x} dx = \frac{1}{4}e^2 + \frac{1}{4}`,
    String.raw`\sqrt[3]{\sigma_s} + \sqrt{b^2-4ac}`,
    String.raw`\sum_{i=1}^{n} i^2`,
    String.raw`\vec{F} + \bar{x} + \hat{n}`,
    String.raw`\frac{\partial^2 u}{\partial x^2}`,
    String.raw`\begin{matrix} a & b \\ c & d \end{matrix}`,
    String.raw`\sigma_p = \sigma_s (1 + b \ln \lambda)`,
  ];
  let ok = 0;
  for (const tex of cases) {
    const back = ommlToLatex(mml2omml(temml.renderToString(tex, { xml: true, displayMode: true })))[0];
    if (back && latexRenders(back)) ok++;
    else console.log(`       ↳ 回环失败: ${tex} → ${back}`);
  }
  check('九个工程/数学公式 OMML 回环后仍可渲染', ok === cases.length, `${ok}/${cases.length}`);

  // 单字符参数不加花括号会产出 \vecF 这种未定义控制字，这里锁住该回归
  const vec = ommlToLatex(mml2omml(temml.renderToString(String.raw`\vec{F}`, { xml: true, displayMode: true })))[0];
  check('重音命令的参数带花括号（不产出 \\vecF）', /\{F\}/.test(vec), vec);

  // 函数名必须还原成命令，否则 F_t 与 tan 会粘连
  const fn = ommlToLatex(mml2omml(temml.renderToString(String.raw`F_t \tan\alpha`, { xml: true, displayMode: true })))[0];
  check('函数名还原为 \\tan 而非裸 tan', /\\tan/.test(fn) && !/t\s*tan/.test(fn), fn);

  check('非法 LaTeX 转 OMML 返回 null（而非抛错）', latexToOmml('\\frac{') === null);
  check('合法 LaTeX 转出的 OMML 含 oMath 节点', (latexToOmml('\\frac{a}{b}') || '').includes('oMath'));
}

section('行内/行间公式切分');
{
  const parts = splitInlineMath('由 $F_t=2T/d$ 得 $$T=9.55\\times10^6$$ 完成。');
  check('切出 5 段（文/行内/文/行间/文）', parts.length === 5, String(parts.length));
  check('行内公式标记为非 display', parts[1].kind === 'math' && parts[1].display === false);
  check('行间公式标记为 display', parts[3].kind === 'math' && parts[3].display === true);
  // 同一行的两个 $ 配成公式是预期行为（提示词要求模型用 $ 包裹公式）；
  // 要保证的是不跨行乱配，否则两段无关文字会被吞进一个"公式"
  check('$ 不跨行配对', splitInlineMath('价格 $5\n和 $8').every((p) => p.kind === 'text'));
  check('同行 $ 正常配对', splitInlineMath('设 $x=1$ 则').some((p) => p.kind === 'math'));

  // 摘录里已转义的美元符号不能被重新当成公式分隔符，
  // 否则一段普通文本会被切成一堆非法 LaTeX（曾导致"13 个公式全部转换失败"）
  const escaped = splitInlineMath(' \\$T_1\\$ 是源码');
  check('\\$ 转义视为普通文本', escaped.length === 1 && escaped[0].kind === 'text');
  check('\\$ 还原为字面美元符号', escaped[0].value.includes('$T_1$'));
  const al = splitInlineMath('$$\\begin{aligned} a &= 1 \\\\ b &= 2 \\end{aligned}$$');
  check('公式内的 LaTeX 换行 \\\\ 不破坏配对', al.length === 1 && al[0].kind === 'math' && al[0].value.includes('aligned'));
}

section('SVG 清洗');
{
  const evil = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" onload="alert(1)">'
    + '<script>fetch("/steal")</' + 'script>'
    + '<rect x="1" y="1" width="10" height="10" fill="red" onclick="evil()"/>'
    + '<image href="http://x.com/a.png"/><text x="5" y="20" font-size="12">Ft</text></svg>';
  const { svg, removed } = sanitizeSvg(evil);
  check('剥离 <script>', !/script/i.test(svg), svg);
  check('剥离 on* 事件属性', !/onload|onclick/i.test(svg));
  check('剥离外部引用元素', !/image/i.test(svg));
  check('保留合法图元', /<rect/.test(svg) && /<text/.test(svg));
  check('补齐 xmlns', svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  check('上报被剥离的内容', removed.length >= 4, removed.join(','));

  check('内部片段引用 url(#id) 保留',
    (sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><line x1="0" y1="0" x2="5" y2="5" marker-end="url(#a)"/></svg>').svg || '').includes('url(#a)'));
  check('外部 url() 被剥离',
    !(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect fill="url(http://x/y)" width="1" height="1"/></svg>').svg || '').includes('http://x/y'));
  check('非 SVG 输入返回 null', sanitizeSvg('<div>hi</div>').svg === null);
  // 未闭合标签会让 xmldom 抛异常，这里锁住"返回 null 而不是把任务搞挂"
  check('格式错误的 SVG 返回 null 而不抛错',
    sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect>').svg === null);
  check('空输入返回 null', sanitizeSvg('').svg === null && sanitizeSvg(null).svg === null);
}

// ---------------------------------------------------------------- 文档抽取

section('文档抽取');
{
  const docx = await extract(fs.readFileSync('test/fixtures/homework.docx'), 'homework.docx');
  check('docx 抽到 Word 公式对象', docx.equationCount >= 13, `${docx.equationCount} 个`);
  check('docx 抽到图片', docx.images.length === 1, `${docx.images.length} 张`);
  check('docx 公式还原为 LaTeX 并留在原位', /\$[^$]*n\}?_?\{?1/.test(docx.text) && docx.text.includes('r/min'));
  check('docx 保留题号与题干', docx.text.includes('一、齿轮传动受力计算') && docx.text.includes('压力角'));
  check('docx 图片标记写入文本', /\[图1\]/.test(docx.text));
  const recovered = (docx.text.match(/\$[^$\n]+\$/g) || []).map((s) => s.slice(1, -1));
  check('还原出的公式全部可渲染', recovered.length > 0 && recovered.every(latexRenders),
    `${recovered.filter(latexRenders).length}/${recovered.length}`);

  const plain = await extract(fs.readFileSync('test/fixtures/plain.docx'), 'plain.docx');
  check('无公式文档不报错且计数为 0', plain.equationCount === 0 && plain.text.includes('塑性变形'));

  const pdf = await extract(fs.readFileSync('test/fixtures/homework.pdf'), 'homework.pdf');
  check('pdf 读到页数', pdf.pageCount >= 1, `${pdf.pageCount} 页`);
  check('pdf 抽到文字层', pdf.text.includes('齿轮'), `${pdf.text.length} 字`);
  check('pdf 启用视觉通道（小于上限）', pdf.pdfBase64 !== null);

  await extract(Buffer.from('not a zip at all'), 'broken.docx').then(
    () => check('损坏的 docx 报出可读错误', false, '未抛错'),
    (e) => check('损坏的 docx 报出可读错误', e.message.includes('无法解压'), e.message),
  );
  await extract(Buffer.from('x'), 'a.txt').then(
    () => check('拒绝不支持的扩展名', false, '未抛错'),
    (e) => check('拒绝不支持的扩展名', e.message.includes('不支持'), e.message),
  );
  await extract(Buffer.alloc(51 * 1024 * 1024), 'big.pdf').then(
    () => check('拒绝超过体积上限的文件', false, '未抛错'),
    (e) => check('拒绝超过体积上限的文件', e.message.includes('超过'), e.message),
  );
}

// ---------------------------------------------------------------- 渲染

const answerDoc = {
  meta: { title: '渲染测试', subtitle: '子标题', font: 'font-serif-sc' },
  questions: [{
    number: '一', title: '测试题', statement: '已知 $a=1$。',
    blocks: [
      { type: 'text', text: '**步骤一**：代入 $x=2$。' },
      { type: 'equation', latex: 'T_1 = 9.55\\times10^6\\frac{P}{n_1}' },
      { type: 'equation', latex: '\\frac{bad{' },
      { type: 'figure', caption: '图1', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect x="10" y="10" width="100" height="60" fill="none" stroke="#333"/></svg>' },
      { type: 'table', headers: ['量', '值'], rows: [['Ft', '1243.5']] },
      { type: 'answer', text: '$F_t=1243.5\\ \\text{N}$。' },
    ],
  }],
};

section('DOCX 渲染');
{
  const { buffer, stats } = await renderDocx(answerDoc);
  check('产出非空 docx', buffer.length > 5000, `${buffer.length}B`);
  check('合法公式转为 OMML', stats.ommlOk >= 4, `${stats.ommlOk} 个`);
  check('非法公式计入失败并保留源码', stats.ommlFail === 1 && stats.failedLatex.length === 1);
  check('图片已嵌入', stats.figures === 1);

  const files = unzipSync(new Uint8Array(buffer));
  const xml = strFromU8(files['word/document.xml']);
  check('document.xml 含 m:oMath 节点', (xml.match(/<m:oMath[\s>]/g) || []).length >= 4);
  check('不含 <undefined> 残留', !xml.includes('<undefined'));
  check('媒体文件已打包', Object.keys(files).some((n) => n.startsWith('word/media/') && n.endsWith('.png')));
  let xmlOk = true;
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
    const errs = [];
    new DOMParser({ onError: (lvl, m) => { if (lvl !== 'warning') errs.push(m); } })
      .parseFromString(strFromU8(data), 'text/xml');
    if (errs.length) { xmlOk = false; console.log(`       ↳ ${name}: ${errs[0]}`); }
  }
  check('所有 XML 部件格式正确', xmlOk);
}

section('HTML 渲染');
{
  const { html, stats } = renderHtml(answerDoc);
  check('产出完整 HTML 文档', html.startsWith('<!DOCTYPE html>') && html.includes('</html>'));
  check('公式渲染为 MathML', html.includes('<math') && stats.mathOk >= 4, `${stats.mathOk} 个`);
  check('非法公式以可见标记降级', stats.mathFail === 1 && html.includes('eq-fail'));
  // 只允许 w3.org 的命名空间声明，其他外链都会让 PDF 生成依赖网络
  const urls = (html.match(/https?:\/\/[^"' )]+/g) || []).filter((u) => !u.startsWith('http://www.w3.org/'));
  check('HTML 自包含（无外部资源）', urls.length === 0, urls.join(', '));
  check('字体以 data URI 内联', html.includes('url(data:font/woff2;base64,'));
  check('页边距取自配置', html.includes('margin: 25.4mm'));
  check('默认注入溢出重排脚本', html.includes('__eqAdjusted'));
  check('关闭开关后不注入脚本', !renderHtml(answerDoc, { autoLayout: false }).html.includes('__eqAdjusted'));
}

section('PDF 渲染与溢出处理');
{
  const long = (n) => Array.from({ length: n }, (_, i) => `\\frac{a_{${i}}^2+b_{${i}}}{c_{${i}}}`).join(' + ');
  const doc = { meta: { title: '溢出' }, questions: [{ number: '一', blocks: [
    { type: 'equation', latex: 'x = 1' },
    { type: 'equation', latex: long(12) },
    { type: 'equation', latex: long(60) },
  ] }] };
  const { html } = renderHtml(doc);
  const { buffer, adjusted } = await renderPdf(html);
  check('产出合法 PDF', buffer.subarray(0, 5).toString() === '%PDF-', buffer.subarray(0, 8).toString());
  check('正常宽度公式不被改动', !adjusted.some((a) => a.index === 0));
  const scaled = adjusted.find((a) => a.index === 1);
  check('中度超宽公式被缩放', scaled && scaled.scale !== 'wrap' && Number(scaled.scale) < 1, JSON.stringify(scaled));
  check('缩放不低于下限', scaled && Number(scaled.scale) >= 0.6, JSON.stringify(scaled));
  const wrapped = adjusted.find((a) => a.index === 2);
  check('极端超宽公式改为断行', wrapped && wrapped.scale === 'wrap', JSON.stringify(wrapped));
}

// ------------------------------------------------- 求解链路（对接本地模拟 API）

section('求解链路（本地模拟 Messages API）');
{
  // 把 SDK 指到本地模拟服务，这样能真正跑一遍请求序列化、结构化输出解析、
  // 两阶段流程与并发，而不是把 client 整个 stub 掉 —— 参数写错在这里就能发现。
  const seen = [];
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      seen.push(payload);
      const sys = payload.system?.map?.((b) => b.text).join('') || '';
      const out = sys.includes('拆分')
        ? {
          doc_title: '机械设计基础 期末作业',
          questions: [
            { number: '一', title: '齿轮受力', statement: '求 $F_t$。', figure_refs: ['图1'] },
            { number: '二', title: '挤压力', statement: '求 $p_{av}$。', figure_refs: [] },
            { number: '三', title: '定积分', statement: '求 $\\int_0^1 x e^{2x} dx$。', figure_refs: [] },
          ],
        }
        : {
          number: '一', title: '齿轮受力',
          blocks: [
            { type: 'text', text: '由 $T=9.55\\times10^6 P/n$ 得：', latex: null, svg: null, caption: null, headers: null, rows: null },
            { type: 'equation', text: null, latex: 'F_t = \\frac{2T_1}{d_1}', svg: null, caption: null, headers: null, rows: null },
            { type: 'equation', text: null, latex: '$F_r = F_t\\tan\\alpha$', svg: null, caption: null, headers: null, rows: null },
            { type: 'figure', text: null, latex: null, caption: '图1：受力', headers: null, rows: null,
              svg: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60" viewBox="0 0 80 60"><script>bad()</' + 'script><line x1="0" y1="0" x2="40" y2="30" stroke="#333"/></svg>' },
            { type: 'answer', text: '$F_t = 1243.5\\ \\text{N}$。', latex: null, svg: null, caption: null, headers: null, rows: null },
          ],
        };
      const msg = {
        id: 'msg_mock', type: 'message', role: 'assistant', model: payload.model,
        content: [{ type: 'text', text: JSON.stringify(out) }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 900, cache_read_input_tokens: seen.length > 1 ? 900 : 0 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(msg));
    });
  });
  await new Promise((r) => mock.listen(0, r));
  const mockPort = mock.address().port;

  const prevBase = process.env.ANTHROPIC_BASE_URL;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevDry = process.env.SOLVER_DRY_RUN;
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${mockPort}`;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  delete process.env.SOLVER_DRY_RUN;

  try {
    const { solve } = await import('../src/solve/solver.js');
    const extracted = await extract(fs.readFileSync('test/fixtures/homework.docx'), 'homework.docx');
    const logs = [];
    const answer = await solve(extracted, { subject: 'mech_eng', font: 'font-serif-sc', sourceName: 'homework.docx' },
      (m, lvl) => logs.push({ m, lvl }));

    check('发出 1 次拆题 + 3 次解题请求', seen.length === 4, `${seen.length} 次`);
    check('使用 claude-opus-5', seen.every((r) => r.model === 'claude-opus-5'));
    check('启用自适应思考', seen.every((r) => r.thinking?.type === 'adaptive'));
    check('设置了 effort 与结构化输出格式',
      seen.every((r) => r.output_config?.effort && r.output_config?.format));
    check('system 带 cache_control（可缓存前缀）',
      seen.every((r) => r.system?.[0]?.cache_control?.type === 'ephemeral'));
    check('源文档前缀带 cache_control',
      seen.every((r) => r.messages[0].content.some((b) => b.cache_control?.type === 'ephemeral')));
    check('docx 的图片作为 image 块送出',
      seen.every((r) => r.messages[0].content.some((b) => b.type === 'image')));
    check('三道题的 system 完全一致（缓存前缀稳定）',
      new Set(seen.slice(1).map((r) => JSON.stringify(r.system))).size === 1);

    check('产出 3 道题的答卷', answer.questions.length === 3, `${answer.questions.length} 题`);
    check('答卷标题取自模型', answer.meta.title === '机械设计基础 期末作业');
    check('保留原题干', answer.questions[0].statement.includes('F_t'));
    const blocks = answer.questions[0].blocks;
    check('公式块剥掉了多余的 $ 包裹',
      blocks.some((b) => b.type === 'equation' && b.latex === 'F_r = F_t\\tan\\alpha'),
      JSON.stringify(blocks.filter((b) => b.type === 'equation')));
    check('答案块保留', blocks.some((b) => b.type === 'answer'));
    check('日志报告了缓存命中', logs.some((l) => /命中缓存 900/.test(l.m)));

    // 整条渲染链路跑一遍模型产出，确认 SVG 里的 script 被清掉
    const { html, stats: hs } = renderHtml(answer);
    check('模型产出可渲染为 HTML', hs.mathOk > 0 && html.includes('<math'));
    check('模型 SVG 里的 <script> 被清除', !/<script>bad/.test(html) && html.includes('<figure'));
    const { stats: ds } = await renderDocx(answer);
    check('模型产出可渲染为 DOCX 原生公式', ds.ommlOk > 0 && ds.ommlFail === 0, JSON.stringify(ds.failedLatex));
  } finally {
    mock.close();
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevDry !== undefined) process.env.SOLVER_DRY_RUN = prevDry;
  }
}

// ---------------------------------------------------------------- 端到端

section('HTTP 端到端（空跑模式）');
{
  const port = 3400 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), SOLVER_DRY_RUN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://localhost:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`${base}/api/config`)).ok; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    check('服务启动', up);

    const cfg = await (await fetch(`${base}/api/config`)).json();
    check('/api/config 返回科目与字体', cfg.subjects.length === 6 && cfg.fonts.length === 3);

    const body = new FormData();
    body.append('file', new Blob([fs.readFileSync('test/fixtures/homework.docx')]), 'homework.docx');
    body.append('subject', 'mech_eng');
    body.append('font', 'font-serif-sc');
    const res = await fetch(`${base}/api/jobs`, { method: 'POST', body });
    const { jobId } = await res.json();
    check('上传后返回 202 与 jobId', res.status === 202 && !!jobId);

    // 读 SSE 直到 done 或 error
    const ev = await fetch(`${base}/api/jobs/${jobId}/events`);
    const reader = ev.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let done = null; let errored = null; const logs = [];
    while (!done && !errored) {
      const { value, done: fin } = await reader.read();
      if (fin) break;
      buf += dec.decode(value, { stream: true });
      for (const chunk of buf.split('\n\n')) {
        if (!chunk.includes('data:')) continue;
        const type = /event: (\w+)/.exec(chunk)?.[1];
        const data = JSON.parse(/data: (.*)/.exec(chunk)[1]);
        if (type === 'log') logs.push(data.message);
        if (type === 'done') done = data;
        if (type === 'error') errored = data;
      }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
    reader.cancel().catch(() => {});
    check('SSE 推送日志', logs.length >= 3, `${logs.length} 条`);
    check('任务完成（未报错）', !!done && !errored, errored?.message || '');
    check('日志包含抽取结果', logs.some((l) => l.includes('Word 公式')));
    check('日志包含溢出检查结论', logs.some((l) => l.includes('版面溢出检查')));
    check('统计含 Word 原生公式数', done?.stats?.ommlOk > 0, JSON.stringify(done?.stats));

    const prev = await fetch(`${base}/api/jobs/${jobId}/preview`);
    const prevHtml = await prev.text();
    check('预览返回 HTML', prev.ok && prevHtml.includes('<math'));

    const dx = await fetch(`${base}/api/jobs/${jobId}/download/docx`);
    const dxBuf = Buffer.from(await dx.arrayBuffer());
    check('下载 docx 且为 zip 格式', dx.ok && dxBuf[0] === 0x50 && dxBuf[1] === 0x4b, `${dxBuf.length}B`);
    check('docx 带 Content-Disposition', /attachment/.test(dx.headers.get('content-disposition') || ''));

    const pf = await fetch(`${base}/api/jobs/${jobId}/download/pdf`);
    const pfBuf = Buffer.from(await pf.arrayBuffer());
    check('下载 pdf 且为 PDF 格式', pf.ok && pfBuf.subarray(0, 5).toString() === '%PDF-', `${pfBuf.length}B`);

    const bad = new FormData();
    bad.append('file', new Blob(['hello']), 'notes.txt');
    const badRes = await fetch(`${base}/api/jobs`, { method: 'POST', body: bad });
    check('拒绝 .txt 上传', badRes.status === 400);

    const missing = await fetch(`${base}/api/jobs/does-not-exist/download/pdf`);
    check('未知任务返回 404', missing.status === 404);
  } finally {
    child.kill('SIGTERM');
  }
}

await closeBrowser();

console.log(`\n${'─'.repeat(50)}`);
console.log(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
