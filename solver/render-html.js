// 答卷 → 页面 HTML。
//
// 与 Node 版的差别：不再生成独立 HTML 文档塞进 iframe，而是直接渲染进页面。
// 打印成 PDF 时用 @media print 只保留答卷区域（样式在 solver.html 里），
// 所以"屏幕所见"和"打印所得"是同一份 DOM，不可能不一致。
//
// 公式走 temml → MathML，由浏览器原生渲染；导出 Word 时同一个 temml 解析结果
// 转成 OMML，两条路径共用前半程。

import { LAYOUT } from './config.js';
import { latexToMathml, normalizeLatex, splitInlineMath } from './math.js';
import { sanitizeSvg } from './svg.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

/**
 * 渲染答卷正文。
 * @returns {{html:string, stats:object}}
 */
export function renderAnswerHtml(answerDoc) {
  const stats = { mathOk: 0, mathFail: 0, failedLatex: [], figures: 0, svgStripped: [], svgRejected: 0 };
  const parts = [];

  parts.push(`<header class="ans-title"><h1>${esc(answerDoc.meta?.title || '作业解答')}</h1>`);
  if (answerDoc.meta?.subtitle) parts.push(`<p class="ans-sub">${esc(answerDoc.meta.subtitle)}</p>`);
  parts.push('</header>');

  for (const q of answerDoc.questions || []) {
    parts.push('<section class="ans-q">');
    const heading = [q.number, q.title].filter(Boolean).join('、');
    if (heading) parts.push(`<h2>${esc(heading)}</h2>`);
    if (q.statement) parts.push(`<p class="ans-stmt">${inlineHtml(q.statement, stats)}</p>`);

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
          parts.push(`<p class="ans-final"><strong>答：</strong>${inlineHtml(block.text || '', stats)}</p>`);
          break;
        default:
          break;
      }
    }
    parts.push('</section>');
  }

  return { html: parts.join('\n'), stats };
}

/**
 * 公式溢出处理：超宽先按比例缩放，缩到下限以下改为断行。
 * 在真实 DOM 上测量，返回实际做了哪些调整 —— 日志里报的是量出来的结果，不是写死的提示语。
 * @param {HTMLElement} root 答卷容器
 * @returns {Array<{index:number, scale:string}>}
 */
export function fitEquations(root) {
  const adjusted = [];
  root.querySelectorAll('.eq').forEach((box, i) => {
    const inner = box.firstElementChild;
    if (!inner) return;
    box.removeAttribute('data-scaled');
    box.classList.remove('eq-overflow');
    inner.style.transform = '';
    box.style.height = '';

    const avail = box.clientWidth;
    const need = inner.scrollWidth;
    if (!avail || !need || need <= avail + 0.5) return;

    const k = avail / need;
    if (k >= LAYOUT.minEquationScale) {
      inner.style.transformOrigin = 'left top';
      inner.style.transform = `scale(${k.toFixed(4)})`;
      // 缩放不改变占位高度，手动补偿，否则后面的段落会压上来
      box.style.height = `${inner.getBoundingClientRect().height}px`;
      box.setAttribute('data-scaled', k.toFixed(3));
      adjusted.push({ index: i, scale: k.toFixed(3) });
    } else {
      box.classList.add('eq-overflow');
      box.setAttribute('data-scaled', 'wrap');
      adjusted.push({ index: i, scale: 'wrap' });
    }
  });
  return adjusted;
}
