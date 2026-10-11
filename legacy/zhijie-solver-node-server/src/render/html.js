// 答卷 → 自包含 HTML。
//
// 预览和 PDF 用的是同一份 HTML（预览放进 iframe，PDF 送进 Chrome），
// 所以"预览所见"和"PDF 所得"不可能不一致 —— 这是版式一致的另一半，
// 另一半在 render/docx.js（与本文件共用 config.js 的字体与版式表）。
//
// 公式走 temml → MathML，由浏览器原生渲染；与导出 Word 用的是同一个 temml 解析结果，
// 只是最后一步一个转 MathML 一个转 OMML。

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { FONTS, LAYOUT, DEFAULT_FONT } from '../config.js';
import { latexToMathml, normalizeLatex, splitInlineMath } from './math.js';
import { sanitizeSvg } from './svg.js';

const require = createRequire(import.meta.url);

let cachedMathCss = null;

/** temml 的 CSS，并把字体以 data URI 内联，让 HTML 完全自包含（PDF 生成不依赖网络或端口）。 */
function mathCss() {
  if (cachedMathCss) return cachedMathCss;
  const cssPath = require.resolve('temml/dist/Temml-Local.css');
  const fontPath = require.resolve('temml/dist/Temml.woff2');
  const css = fs.readFileSync(cssPath, 'utf8');
  const font = fs.readFileSync(fontPath).toString('base64');
  cachedMathCss = css.replace(
    /url\(['"]?Temml\.woff2['"]?\)/,
    `url(data:font/woff2;base64,${font})`,
  );
  return cachedMathCss;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 行内富文本：公式 → MathML，**粗体** → <strong>。 */
function inlineHtml(text, stats) {
  let out = '';
  for (const part of splitInlineMath(text)) {
    if (part.kind === 'text') {
      out += esc(part.value).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    } else {
      out += mathHtml(part.value, part.display, stats);
    }
  }
  return out;
}

function mathHtml(latex, display, stats) {
  const tex = normalizeLatex(latex);
  if (!tex) return '';
  try {
    const mml = latexToMathml(tex, display);
    stats.mathOk++;
    return mml;
  } catch (e) {
    // 与 DOCX 路径一致：失败就把源码露出来并计数，不假装成功
    stats.mathFail++;
    stats.failedLatex.push(tex);
    return `<code class="eq-fail" title="${esc(e.message)}">${esc(tex)}</code>`;
  }
}

function tableHtml(block) {
  const headers = Array.isArray(block.headers) ? block.headers : [];
  const rows = Array.isArray(block.rows) ? block.rows : [];
  if (!headers.length && !rows.length) return '';
  const head = headers.length
    ? `<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`
    : '';
  const body = rows.map((r) => {
    const cells = Array.isArray(r) ? r : [r];
    return `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;
  }).join('');
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

/** 页内脚本：公式超宽时先缩放、缩不下去再允许横向滚动/断行。 */
const FIT_SCRIPT = `
(function () {
  var MIN = ${LAYOUT.minEquationScale};
  function fit() {
    var adjusted = [];
    document.querySelectorAll('.eq').forEach(function (box, i) {
      var inner = box.firstElementChild;
      if (!inner) return;
      box.removeAttribute('data-scaled');
      inner.style.transform = '';
      inner.style.transformOrigin = 'left top';
      var avail = box.clientWidth;
      var need = inner.scrollWidth;
      if (!avail || !need || need <= avail + 0.5) return;
      var k = avail / need;
      if (k >= MIN) {
        inner.style.transform = 'scale(' + k.toFixed(4) + ')';
        // 缩放不改变占位高度，手动补偿，否则后面的段落会压上来
        box.style.height = (inner.getBoundingClientRect().height) + 'px';
        box.setAttribute('data-scaled', k.toFixed(3));
      } else {
        box.classList.add('eq-overflow');
        box.setAttribute('data-scaled', 'wrap');
      }
      adjusted.push({ index: i, scale: box.getAttribute('data-scaled') });
    });
    window.__eqAdjusted = adjusted;
    document.documentElement.setAttribute('data-fit-done', '1');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fit);
  else fit();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
})();
`;

/**
 * 渲染答卷为自包含 HTML。
 * @param {object} answerDoc
 * @param {{autoLayout?:boolean}} options autoLayout=false 时不注入溢出重排脚本
 * @returns {{html:string, stats:object}}
 */
export function renderHtml(answerDoc, options = {}) {
  const autoLayout = options.autoLayout !== false;
  const fontKey = FONTS[answerDoc.meta?.font] ? answerDoc.meta.font : DEFAULT_FONT;
  const fontCss = FONTS[fontKey].css;
  const stats = { mathOk: 0, mathFail: 0, failedLatex: [], figures: 0, svgStripped: [], svgRejected: 0 };

  const parts = [];
  parts.push(`<header class="sheet-title"><h1>${esc(answerDoc.meta?.title || '作业解答')}</h1>`);
  if (answerDoc.meta?.subtitle) parts.push(`<p class="subtitle">${esc(answerDoc.meta.subtitle)}</p>`);
  parts.push('</header>');

  for (const q of answerDoc.questions || []) {
    parts.push('<section class="q">');
    parts.push(`<h2>${esc([q.number, q.title].filter(Boolean).join('、'))}</h2>`);
    if (q.statement) parts.push(`<p class="statement">${inlineHtml(q.statement, stats)}</p>`);

    for (const block of q.blocks || []) {
      switch (block.type) {
        case 'text':
          parts.push(`<p>${inlineHtml(block.text || '', stats)}</p>`);
          break;
        case 'equation':
          // .eq 是溢出测量的锚点，内层元素才是被缩放的对象
          parts.push(`<div class="eq"><div class="eq-inner">${mathHtml(block.latex || '', true, stats)}</div></div>`);
          break;
        case 'figure': {
          // 模型产出的 SVG 是不可信输入，先清洗再注入
          const { svg, removed } = sanitizeSvg(block.svg);
          if (svg) {
            stats.figures++;
            if (removed.length) stats.svgStripped.push(...removed);
            parts.push(`<figure>${svg}${block.caption ? `<figcaption>${esc(block.caption)}</figcaption>` : ''}</figure>`);
          } else {
            stats.svgRejected++;
          }
          break;
        }
        case 'table':
          parts.push(tableHtml(block));
          break;
        case 'answer':
          parts.push(`<p class="answer"><strong>答：</strong>${inlineHtml(block.text || '', stats)}</p>`);
          break;
        default:
          break;
      }
    }
    parts.push('</section>');
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>${esc(answerDoc.meta?.title || '作业解答')}</title>
<style>
${mathCss()}
@page { size: A4; margin: ${LAYOUT.marginMm}mm; }
:root { --body-font: ${fontCss}; --line: ${LAYOUT.lineSpacing}; --ink: #1e293b; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--body-font);
  font-size: ${LAYOUT.bodyPt}pt;
  line-height: var(--line);
  color: var(--ink);
  background: #f1f5f9;
}
.sheet {
  width: 210mm;
  min-height: 297mm;
  padding: ${LAYOUT.marginMm}mm;
  margin: 0 auto;
  background: #fff;
}
.sheet-title { text-align: center; margin-bottom: 1.6em; }
.sheet-title h1 { font-size: 1.5em; margin: 0 0 .3em; }
.subtitle { color: #64748b; font-size: .85em; margin: 0; }
.q { margin-bottom: 1.4em; }
.q h2 { font-size: 1.12em; margin: 1.4em 0 .6em; }
p { margin: 0 0 .6em; text-align: justify; }
.statement { color: #334155; }
.answer { background: #f8fafc; border-left: 3px solid #4f46e5; padding: .5em .8em; }
/* 公式块：overflow hidden 配合脚本缩放；缩放不下去时改成可横向滚动 */
.eq { margin: .8em 0; overflow: hidden; }
.eq-inner { display: inline-block; white-space: nowrap; }
.eq-overflow { overflow-x: auto; }
.eq-overflow .eq-inner { white-space: normal; }
math { font-size: 1.05em; }
.eq-fail {
  font-family: 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: .85em; color: #b45309;
  background: #fffbeb; border: 1px solid #fcd34d; border-radius: 3px; padding: 0 .3em;
}
figure { margin: 1em 0; text-align: center; }
figure svg { max-width: 100%; height: auto; }
figcaption { font-size: .82em; color: #64748b; margin-top: .4em; }
table { border-collapse: collapse; width: 100%; margin: .8em 0; font-size: .92em; }
th, td { border: 1px solid #cbd5e1; padding: .35em .6em; text-align: left; }
th { background: #f1f5f9; }
@media print {
  body { background: #fff; }
  .sheet { width: auto; min-height: 0; padding: 0; margin: 0; }
  .q { break-inside: auto; }
  .q h2 { break-after: avoid; }
  .eq, figure, table { break-inside: avoid; }
}
</style></head>
<body><main class="sheet">${parts.join('\n')}</main>
${autoLayout ? `<script>${FIT_SCRIPT}</script>` : '<!-- 公式溢出自动重排已关闭 -->'}
</body></html>`;

  return { html, stats };
}
