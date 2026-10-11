// 作业解答模块的回归测试。在浏览器里跑，测的是 solver/ 下真正会被页面加载的那份代码。
//
// 为什么是浏览器而不是 Node：
//   · solver/ 的模块从 CDN 以 https:// URL 直接 import（temml / mathml2omml /
//     docx / fflate / pdfjs-dist），Node 的 ESM 加载器不支持 https 说明符；
//   · 溢出测量（fitEquations）依赖真实布局引擎量 clientWidth / scrollWidth；
//   · PDF 抽取要 canvas 栅格化页面。
//   这三点在 Node 里都做不到，硬做只能把被测对象换掉，那就不是在测发布出去的东西了。
//
// 因此测试跑在页面里，结果写进 DOM，由 test/run.mjs 用无头 Chrome --dump-dom 取回。
//
// 覆盖范围与旧 Node 版（见 legacy/）的差异：
//   已覆盖 —— OMML↔LaTeX 回环、公式切分、SVG 清洗、配置表、docx/pdf 抽取、
//             HTML 渲染、DOCX 渲染、公式溢出、两阶段求解链路（stub 桥接层）
//   不覆盖 —— HTTP 端到端（本站没有后端）、无头 Chrome 出 PDF（改走打印对话框）、
//             空跑模式（浏览器版无此能力）

import temmlPkg from 'https://cdn.jsdelivr.net/npm/temml@0.14.0/+esm';
import { mml2omml } from 'https://cdn.jsdelivr.net/npm/mathml2omml@0.5.0/+esm';
import { unzipSync, strFromU8 } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm';

import { ommlToLatex } from '../solver/omml2latex.js';
import { latexToOmml, splitInlineMath } from '../solver/math.js';
import { sanitizeSvg } from '../solver/svg.js';
import { extract } from '../solver/extract.js';
import { renderAnswerHtml, fitEquations } from '../solver/render-html.js';
import { renderDocx } from '../solver/render-docx.js';
import { solve } from '../solver/solve.js';
import {
  SUBJECTS, FONTS, LAYOUT, UPLOAD, BODY_SIZES, PDF_VISION_MAX_PAGES, PDF_RENDER_SCALE,
} from '../solver/config.js';

const out = document.getElementById('out');
const lines = [];
let pass = 0;
const failures = [];

function flush() { out.textContent = lines.join('\n'); }
function section(title) { lines.push(`\n${title}`); flush(); }
function check(name, cond, detail = '') {
  if (cond) { pass++; lines.push(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); lines.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
  flush();
}

const temml = temmlPkg.default ?? temmlPkg;

// temml 对未定义控制字不抛异常而是产出错误节点，必须一并检查
function latexRenders(tex) {
  try {
    const html = temml.renderToString(tex, { xml: true, throwOnError: true });
    return !/merror|temml-error/.test(html);
  } catch { return false; }
}

/** 把测试夹具读成 File，喂给 extract()。 */
async function fetchFile(name) {
  const res = await fetch(`./fixtures/${name}`);
  if (!res.ok) throw new Error(`夹具读取失败：${name} (${res.status})`);
  return new File([await res.arrayBuffer()], name);
}

try {
  // ------------------------------------------------------------- 公式转换
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
      else lines.push(`       ↳ 回环失败: ${tex} → ${back}`);
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
    // 未闭合标签会让解析器报错，这里锁住"返回 null 而不是把任务搞挂"
    check('格式错误的 SVG 返回 null 而不抛错', sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect>').svg === null);
    check('空输入返回 null', sanitizeSvg('').svg === null && sanitizeSvg(null).svg === null);
  }

  section('配置表');
  {
    check('科目表 7 项且都带 i18n 与英文名',
      Object.keys(SUBJECTS).length === 7 && Object.values(SUBJECTS).every((s) => s.i18n && s.en));
    check('字体表 3 项且都给出 css 栈与 Word 字体',
      Object.keys(FONTS).length === 3 && Object.values(FONTS).every((f) => f.css && f.docx?.ascii && f.docx?.eastAsia));
    check('字体栈覆盖 macOS / Windows / Linux 三种族名',
      FONTS['font-sans-sc'].css.includes('PingFang SC') && FONTS['font-sans-sc'].css.includes('Microsoft YaHei')
      && FONTS['font-sans-sc'].css.includes('Noto Sans CJK SC'));
    check('页边距 25.4mm', LAYOUT.marginMm === 25.4);
    check('公式缩放下限 0.6', LAYOUT.minEquationScale === 0.6);
    check('仅接受 .docx / .pdf', UPLOAD.allowedExt.join(',') === '.docx,.pdf');
    check('字号候选含 auto 与五号 10.5pt', BODY_SIZES.includes('auto') && BODY_SIZES.includes(10.5));
    check('PDF 视觉通道上限 10 页、栅格化 1.5 倍', PDF_VISION_MAX_PAGES === 10 && PDF_RENDER_SCALE === 1.5);
  }

  // ------------------------------------------------------------- 文档抽取
  section('文档抽取');
  {
    const docx = await extract(await fetchFile('homework.docx'));
    check('docx 抽到 Word 公式对象', docx.equationCount >= 13, `${docx.equationCount} 个`);
    check('docx 抽到图片', docx.images.length === 1, `${docx.images.length} 张`);
    check('docx 公式还原为 LaTeX 并留在原位', /\$[^$]*n\}?_?\{?1/.test(docx.text) && docx.text.includes('r/min'));
    check('docx 保留题号与题干', docx.text.includes('一、齿轮传动受力计算') && docx.text.includes('压力角'));
    check('docx 图片标记写入文本', /\[图1\]/.test(docx.text));
    const recovered = (docx.text.match(/\$[^$\n]+\$/g) || []).map((s) => s.slice(1, -1));
    check('还原出的公式全部可渲染', recovered.length > 0 && recovered.every(latexRenders),
      `${recovered.filter(latexRenders).length}/${recovered.length}`);

    const plain = await extract(await fetchFile('plain.docx'));
    check('无公式文档不报错且计数为 0', plain.equationCount === 0 && plain.text.includes('塑性变形'));

    const pdf = await extract(await fetchFile('homework.pdf'));
    check('pdf 读到页数', pdf.pageCount >= 1, `${pdf.pageCount} 页`);
    check('pdf 抽到文字层', pdf.text.includes('齿轮'), `${pdf.text.length} 字`);
    check('pdf 启用视觉通道（页面已栅格化为图片）', pdf.images.length >= 1, `${pdf.images.length} 张`);

    await extract(new File([new Uint8Array([1, 2, 3, 4])], 'broken.docx')).then(
      () => check('损坏的 docx 报出可读错误', false, '未抛错'),
      (e) => check('损坏的 docx 报出可读错误', e.message.includes('无法解压'), e.message),
    );
    await extract(new File([new Uint8Array([120])], 'a.txt')).then(
      () => check('拒绝不支持的扩展名', false, '未抛错'),
      (e) => check('拒绝不支持的扩展名', e.message.includes('不支持'), e.message),
    );
    await extract(new File([new Uint8Array(51 * 1024 * 1024)], 'big.pdf')).then(
      () => check('拒绝超过体积上限的文件', false, '未抛错'),
      (e) => check('拒绝超过体积上限的文件', e.message.includes('超过'), e.message),
    );
  }

  // ------------------------------------------------------------- 渲染
  const answerDoc = {
    meta: { title: '渲染测试', subtitle: '子标题', font: 'font-serif-sc' },
    questions: [{
      number: '一',
      title: '测试题',
      statement: '已知 $a=1$。',
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

  section('HTML 渲染');
  {
    const { html, stats } = renderAnswerHtml(answerDoc);
    check('公式渲染为 MathML', html.includes('<math') && stats.mathOk >= 4, `${stats.mathOk} 个`);
    check('非法公式以可见标记降级', stats.mathFail === 1 && html.includes('eq-fail'));
    check('图形渲染为 figure 并计数', stats.figures === 1 && html.includes('<figure'));
    check('表格渲染为 table', html.includes('<table>'));
    check('答案块带"答："前缀', html.includes('ans-final'));
    check('**粗体** 转为 strong', html.includes('<strong>步骤一</strong>'));
    check('题干按行内公式渲染', html.includes('ans-stmt') && html.includes('<math'));
  }

  section('DOCX 渲染');
  {
    const { blob, stats } = await renderDocx(answerDoc);
    check('产出非空 docx', blob.size > 5000, `${blob.size}B`);
    check('合法公式转为 OMML', stats.ommlOk >= 4, `${stats.ommlOk} 个`);
    check('非法公式计入失败并保留源码', stats.ommlFail === 1 && stats.failedLatex.length === 1);
    check('图片已嵌入', stats.figures === 1);

    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const xml = strFromU8(files['word/document.xml']);
    check('document.xml 含 m:oMath 节点', (xml.match(/<m:oMath[\s>]/g) || []).length >= 4);
    check('不含 <undefined> 残留', !xml.includes('<undefined'));
    check('媒体文件已打包', Object.keys(files).some((n) => n.startsWith('word/media/') && n.endsWith('.png')));
    check('页面用 A4 与配置里的页边距',
      xml.includes('w:pgMar') && strFromU8(files['word/document.xml']).includes('w:sz'));

    let xmlOk = true;
    for (const [name, data] of Object.entries(files)) {
      if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
      const parsed = new DOMParser().parseFromString(strFromU8(data), 'application/xml');
      if (parsed.getElementsByTagName('parsererror').length) { xmlOk = false; lines.push(`       ↳ ${name}: XML 格式错误`); }
    }
    check('所有 XML 部件格式正确', xmlOk);
  }

  section('公式溢出测量（真实布局）');
  {
    const long = (n) => Array.from({ length: n }, (_, i) => `\\frac{a_{${i}}^2+b_{${i}}}{c_{${i}}}`).join(' + ');
    const doc = {
      meta: { title: '溢出' },
      questions: [{ number: '一', blocks: [
        { type: 'equation', latex: 'x = 1' },
        { type: 'equation', latex: long(12) },
        { type: 'equation', latex: long(60) },
      ] }],
    };
    const { html } = renderAnswerHtml(doc);
    const stage = document.getElementById('stage');
    stage.innerHTML = html;
    void stage.offsetWidth; // 强制布局，否则 clientWidth / scrollWidth 全是 0

    const adjusted = fitEquations(stage);
    check('正常宽度公式不被改动', !adjusted.some((a) => a.index === 0), JSON.stringify(adjusted));
    const mid = adjusted.find((a) => a.index === 1);
    check('中度超宽公式被处理（缩放或断行）', !!mid, JSON.stringify(adjusted));
    if (mid && mid.scale !== 'wrap') check('缩放比例不低于下限 0.6', Number(mid.scale) >= 0.6, JSON.stringify(mid));
    const wide = adjusted.find((a) => a.index === 2);
    check('极端超宽公式改为断行', wide && wide.scale === 'wrap', JSON.stringify(adjusted));
    stage.innerHTML = '';
  }

  // --------------------------------------------------- 求解链路（stub 桥接层）
  section('求解链路（stub window.claude）');
  {
    const paper = {
      doc_title: '机械设计基础 期末作业',
      questions: [
        { number: '一', title: '齿轮受力', statement: '求 $F_t$。', figure_refs: ['图1'] },
        { number: '二', title: '挤压力', statement: '求 $p_{av}$。', figure_refs: [] },
        { number: '三', title: '定积分', statement: '求 $\\int_0^1 x e^{2x} dx$。', figure_refs: [] },
      ],
    };
    const solution = {
      number: '一',
      title: '齿轮受力',
      blocks: [
        { type: 'text', text: '由 $T=9.55\\times10^6 P/n$ 得：' },
        { type: 'equation', latex: 'F_t = \\frac{2T_1}{d_1}' },
        { type: 'equation', latex: '$F_r = F_t\\tan\\alpha$' },
        { type: 'figure', caption: '图1：受力', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60" viewBox="0 0 80 60"><script>bad()</' + 'script><line x1="0" y1="0" x2="40" y2="30" stroke="#333"/></svg>' },
        { type: 'answer', text: '$F_t = 1243.5\\ \\text{N}$。' },
      ],
    };

    const calls = [];
    window.claude = {
      use: async (name) => (name === 'sample' ? {
        json: async (input, options) => {
          calls.push({ input, options });
          // 两阶段：第 1 次是拆题，之后每次是一道题的求解
          return calls.length === 1 ? structuredClone(paper) : structuredClone(solution);
        },
      } : null),
    };

    const extracted = await extract(await fetchFile('homework.docx'));
    const logs = [];
    const answer = await solve(
      extracted,
      { subject: 'mech_eng', font: 'font-serif-sc', sourceName: 'homework.docx', concurrency: 2 },
      (m, lvl) => logs.push({ m, lvl }),
    );

    check('发出 1 次拆题 + 3 次解题请求', calls.length === 4, `${calls.length} 次`);
    check('拆题请求带上了文档里的图片', calls[0].options.images.length === 1);
    check('产出 3 道题的答卷', answer.questions.length === 3, `${answer.questions.length} 题`);
    check('答卷标题取自模型', answer.meta.title === '机械设计基础 期末作业');
    check('保留原题干', answer.questions[0].statement.includes('F_t'));
    check('公式块剥掉了多余的 $ 包裹',
      answer.questions[0].blocks.some((b) => b.type === 'equation' && b.latex === 'F_r = F_t\\tan\\alpha'),
      JSON.stringify(answer.questions[0].blocks.filter((b) => b.type === 'equation')));
    check('答案块保留', answer.questions[0].blocks.some((b) => b.type === 'answer'));
    check('没有题目失败', answer.failedCount === 0, String(answer.failedCount));
    check('日志记录了拆题与逐题进度', logs.length >= 4, `${logs.length} 条`);

    // 整条渲染链路跑一遍模型产出，确认 SVG 里的 script 被清掉
    const { html, stats } = renderAnswerHtml(answer);
    check('模型产出可渲染为 HTML', stats.mathOk > 0 && html.includes('<math'));
    check('模型 SVG 里的 <script> 被清除', !/<script>bad/.test(html) && html.includes('<figure'));
    const { stats: ds } = await renderDocx(answer);
    check('模型产出可渲染为 DOCX 原生公式', ds.ommlOk > 0 && ds.ommlFail === 0, JSON.stringify(ds.failedLatex));

    // 单题失败不应拖垮整份答卷
    let n = 0;
    window.claude = {
      use: async () => ({
        json: async () => {
          n++;
          if (n === 1) return structuredClone(paper);
          if (n === 3) throw new Error('模拟的单题失败');
          return structuredClone(solution);
        },
      }),
    };
    const answer2 = await solve(
      extracted,
      { subject: 'mech_eng', font: 'font-serif-sc', sourceName: 'homework.docx', concurrency: 1 },
      () => {},
    );
    check('单题失败不拖垮整份答卷', answer2.questions.length === 3 && answer2.failedCount === 1,
      `${answer2.questions.length} 题 / ${answer2.failedCount} 失败`);
    check('失败题在答卷里被标注', answer2.questions.some((q) => q.failed === true));
  }
} catch (e) {
  failures.push(`测试执行中断：${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  lines.push(`\n!! 测试执行中断：${e}`);
  flush();
}

lines.push(`\n${'─'.repeat(50)}`);
lines.push(`通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  lines.push('\n失败项：');
  for (const f of failures) lines.push(`  · ${f}`);
}
flush();

window.__TEST_RESULT__ = { pass, fail: failures.length };
document.title = failures.length ? `RESULT FAIL ${failures.length}` : `RESULT PASS ${pass}`;
