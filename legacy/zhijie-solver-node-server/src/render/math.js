// LaTeX → MathML → OMML。
//
// 这是"Word 里得到真正可编辑公式"的关键链路，也是本项目不依赖 pandoc 的原因：
// 本机没有 pandoc / LaTeX / LibreOffice，而 temml + mathml2omml 是纯 JS，
// 产出的 m:oMath 就是 Word 原生公式对象 —— 可以在 Word 里双击编辑，不是图片。

import temmlPkg from 'temml';
import { mml2omml } from 'mathml2omml';

const temml = temmlPkg.default ?? temmlPkg;

// 同一份公式在预览(HTML)和导出(DOCX)里都会用到，缓存避免重复转换
const mathmlCache = new Map();
const ommlCache = new Map();

/** 去掉外层 $ / $$ 包裹并整理空白。 */
export function normalizeLatex(src) {
  let s = String(src ?? '').trim();
  s = s.replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1');
  return s.trim();
}

/**
 * LaTeX → MathML。
 * @returns {string} MathML 字符串
 * @throws temml 的解析错误
 */
export function latexToMathml(latex, display = true) {
  const key = `${display ? 'D' : 'I'}|${latex}`;
  if (mathmlCache.has(key)) return mathmlCache.get(key);
  const mml = temml.renderToString(latex, {
    xml: true,
    displayMode: display,
    throwOnError: true,
  });
  mathmlCache.set(key, mml);
  return mml;
}

/**
 * LaTeX → OMML（Word 原生公式）。
 * 转换失败不抛到调用方，返回 null，由调用方降级成等宽的 LaTeX 源码并计数上报 ——
 * 静默塞一张公式图片会掩盖问题，让人以为一切正常。
 * @returns {string|null} OMML 字符串，失败返回 null
 */
export function latexToOmml(latex, display = true) {
  const key = `${display ? 'D' : 'I'}|${latex}`;
  if (ommlCache.has(key)) return ommlCache.get(key);
  let omml = null;
  try {
    const mml = latexToMathml(latex, display);
    const converted = mml2omml(mml);
    // 转换器在遇到不认识的结构时可能原样返回 MathML，必须校验产物确实是 OMML
    omml = converted && converted.includes('oMath') ? converted : null;
  } catch {
    omml = null;
  }
  ommlCache.set(key, omml);
  return omml;
}

// 反斜杠本身。用 fromCharCode 而不是字面量，避免转义层层叠加时出错。
const BACKSLASH = String.fromCharCode(92);

/** 从 from 开始找配对的结束分隔符；返回 -1 表示没配上。 */
function findClosingDelimiter(src, from, display) {
  for (let j = from; j < src.length; j++) {
    // 反斜杠转义：跳过下一个字符，这样 \$ 与 LaTeX 的换行 \\ 都不会被误判成分隔符
    if (src[j] === BACKSLASH) { j++; continue; }
    if (!display && src[j] === '\n') return -1; // 行内公式不跨行
    if (src[j] === '$') {
      if (!display) return j;
      if (src[j + 1] === '$') return j;
    }
  }
  return -1;
}

/**
 * 把一段可能含行内/行间公式的文本切成 文本段 与 公式段。
 * 解题正文里公式与文字是混排的（"由式 $F_t=2T/d$ 可得"），
 * 两条输出路径都要按同样规则切分，版式才会一致。
 *
 * 用手写扫描而不是正则：必须认得 \$ 转义。正则版本会把已经转义过的美元符号
 * 重新当成公式分隔符，于是一段普通文本被切成一堆非法 LaTeX。
 * @returns {Array<{kind:'text'|'math', value:string, display?:boolean}>}
 */
export function splitInlineMath(text) {
  const src = String(text ?? '');
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ kind: 'text', value: buf }); buf = ''; } };

  let i = 0;
  while (i < src.length) {
    if (src[i] === BACKSLASH && src[i + 1] === '$') { buf += '$'; i += 2; continue; }
    if (src[i] === '$') {
      const display = src[i + 1] === '$';
      const open = display ? 2 : 1;
      const close = findClosingDelimiter(src, i + open, display);
      if (close === -1) { buf += src[i]; i += 1; continue; }
      const value = src.slice(i + open, close).trim();
      if (value) { flush(); out.push({ kind: 'math', value, display }); }
      i = close + open;
      continue;
    }
    buf += src[i];
    i += 1;
  }
  flush();
  return out;
}
