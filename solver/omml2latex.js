// OMML (Office Math Markup Language) → LaTeX
//
// 为什么需要这个模块：mammoth 把 Word 的公式整段丢弃，抽取结果里公式位置是空白。
// 对理工科试卷来说公式就是题目本身，丢了等于没抽到题。所以绕过 mammoth，
// 直接从 word/document.xml 里取 m:oMath 节点自己翻译成 LaTeX。
//
// 覆盖范围：分式、上下标、根式、大型运算符(积分/求和/连乘)、定界符、函数名、
// 重音(向量/均值)、上下划线、矩阵、方程组、上下极限、群字符。
// 未识别的元素按"递归其子节点"降级处理，不会抛错或丢内容。

// 浏览器原生 DOMParser，不需要 xmldom

// Unicode 数学字符 → LaTeX 命令。Word 存的是真实字符，LaTeX 需要命令。
const CHAR_MAP = {
  // 希腊字母（小写）
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\varepsilon',
  'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta', 'ϑ': '\\vartheta', 'ι': '\\iota',
  'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi',
  'π': '\\pi', 'ρ': '\\rho', 'σ': '\\sigma', 'ς': '\\varsigma', 'τ': '\\tau',
  'υ': '\\upsilon', 'φ': '\\varphi', 'ϕ': '\\phi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  // 希腊字母（大写）
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda', 'Ξ': '\\Xi',
  'Π': '\\Pi', 'Σ': '\\Sigma', 'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  // 运算符与关系符
  '×': '\\times', '÷': '\\div', '±': '\\pm', '∓': '\\mp', '⋅': '\\cdot', '∘': '\\circ',
  '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv',
  '≅': '\\cong', '∝': '\\propto', '∼': '\\sim', '≪': '\\ll', '≫': '\\gg',
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow',
  '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '↦': '\\mapsto',
  '∞': '\\infty', '∂': '\\partial', '∇': '\\nabla', '√': '\\surd',
  '∈': '\\in', '∉': '\\notin', '⊂': '\\subset', '⊆': '\\subseteq', '⊃': '\\supset',
  '∪': '\\cup', '∩': '\\cap', '∅': '\\emptyset', '∀': '\\forall', '∃': '\\exists',
  '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '°': '^\\circ', '′': "'", '″': "''", '…': '\\dots', '⋯': '\\cdots', '⋮': '\\vdots',
  '∥': '\\parallel', '⊥': '\\perp', '∠': '\\angle', '△': '\\triangle',
  '⟨': '\\langle', '⟩': '\\rangle', '⌊': '\\lfloor', '⌋': '\\rfloor',
  '⌈': '\\lceil', '⌉': '\\rceil', '‖': '\\|',
  ' ': '~', '⁡': '', '⁢': '', '⁣': '', '⁤': '',
  // Unicode 减号与各式连字符归一到 ASCII，避免 LaTeX 源码里混入非 ASCII 字符
  '\u2212': '-', '\u2013': '-', '\u2014': '-', '\u00AD': '-',
};

// 大型运算符字符 → LaTeX
const NARY_MAP = {
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod',
  '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '⨌': '\\iiiint',
  '∮': '\\oint', '∯': '\\oiint', '∰': '\\oiiint',
  '⋃': '\\bigcup', '⋂': '\\bigcap', '⋀': '\\bigwedge', '⋁': '\\bigvee',
  '⨁': '\\bigoplus', '⨂': '\\bigotimes', '⨀': '\\bigodot', '⨄': '\\biguplus',
};

// 重音字符 → LaTeX 命令（Word 用组合变音符存重音）
const ACCENT_MAP = {
  '̂': '\\hat', '̃': '\\tilde', '̄': '\\bar', '̅': '\\overline',
  '̆': '\\breve', '̇': '\\dot', '̈': '\\ddot', '̊': '\\mathring',
  '̌': '\\check', '̀': '\\grave', '́': '\\acute',
  '⃗': '\\vec', '⃖': '\\overleftarrow', '⃛': '\\dddot',
  // 间隔型修饰符与箭头：Word 用组合变音符，但 MathML→OMML 转换常产出这一类，两者都要认
  '\u203E': '\\overline', '\u00AF': '\\bar', '\u02C6': '\\hat', '\u02DC': '\\tilde',
  '\u02D9': '\\dot', '\u00A8': '\\ddot', '\u02C7': '\\check', '\u02D8': '\\breve',
  '\u2192': '\\vec', '\u2190': '\\overleftarrow', '\u2194': '\\overleftrightarrow',
};

// 定界符字符 → LaTeX（\left \right 后面要跟的东西）
const DELIM_MAP = {
  '(': '(', ')': ')', '[': '[', ']': ']',
  '{': '\\{', '}': '\\}', '|': '|', '‖': '\\|',
  '⟨': '\\langle', '⟩': '\\rangle',
  '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil',
  '': '.', '/': '/',
};

const GROUP_CHR_MAP = {
  '⏞': '\\overbrace', '⏟': '\\underbrace',
  '⏜': '\\overparen', '⏝': '\\underparen',
  '←': '\\overleftarrow', '→': '\\overrightarrow',
};

/** 取 OMML 属性值，忽略命名空间前缀差异。 */
function attr(el, name) {
  if (!el || !el.attributes) return null;
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.localName === name || a.name === `m:${name}` || a.name === name) return a.value;
  }
  return null;
}

/** 取某个子属性元素（如 m:fPr/m:type）的 m:val 值。 */
function propVal(el, propTag, valTag) {
  const pr = child(el, propTag);
  if (!pr) return null;
  const v = child(pr, valTag);
  return v ? (attr(v, 'val') ?? '') : null;
}

function child(el, localName) {
  if (!el) return null;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.localName === localName) return n;
  }
  return null;
}

function children(el, localName) {
  const out = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.localName === localName) out.push(n);
  }
  return out;
}

/** 取元素下所有文本节点的原始内容，不做任何映射（用于识别重音字符）。 */
function rawText(el) {
  let s = '';
  const visit = (n) => {
    if (n.nodeType === 3) s += n.nodeValue;
    else if (n.nodeType === 1) for (let c = n.firstChild; c; c = c.nextSibling) visit(c);
  };
  if (el) visit(el);
  return s;
}

/** 把 Word 文本里的 Unicode 数学符号换成 LaTeX，并转义 LaTeX 特殊字符。 */
function mapText(s) {
  let out = '';
  for (const ch of s) {
    if (Object.prototype.hasOwnProperty.call(CHAR_MAP, ch)) {
      const cmd = CHAR_MAP[ch];
      // 命令后补空格，避免 \alphax 这种粘连
      out += /\\[a-zA-Z]+$/.test(cmd) ? cmd + ' ' : cmd;
    } else if ('#$%&_'.includes(ch)) {
      out += '\\' + ch;
    } else if (ch === '{' || ch === '}') {
      out += '\\' + ch;
    } else if (ch === '\\') {
      out += '\\backslash ';
    } else if (ch === '~') {
      out += '\\sim ';
    } else if (ch === '^') {
      out += '\\hat{}';
    } else {
      out += ch;
    }
  }
  return out;
}

// Word 常把函数名存成普通文本 run（而非 m:func），直接拼接会得到 F_ttan 这种粘连，
// 并且丢失直立体。按词边界还原成 LaTeX 命令。长名在前，避免 arcsin 被 sin 抢先匹配。
const FUNC_NAMES = ['arcsin', 'arccos', 'arctan', 'arccot', 'sinh', 'cosh', 'tanh', 'coth',
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'ln', 'log', 'lg', 'exp',
  'lim', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'gcd', 'arg', 'deg'];

// 前置字符不能是反斜杠或字母：避免匹配 \cos 里的 cos，或 using 里的 sin
const FUNC_RE = new RegExp(`(^|[^\\\\A-Za-z])(${FUNC_NAMES.join('|')})(?![A-Za-z])`, 'g');

function applyFunctionNames(s) {
  return s.replace(FUNC_RE, (_m, pre, fn) => `${pre}\\${fn} `);
}

/**
 * 始终包一层花括号。
 * 曾经对单字符省略花括号（x^2 而非 x^{2}），但那会让 \vec + F 拼成 \vecF ——
 * 一个未定义的控制字，TeX 不会报错而是静默渲染成错误节点。多余的花括号无害，省略有害。
 */
function brace(s) {
  const t = s.trim();
  return t.length === 0 ? '{}' : `{${t}}`;
}

/** 遍历一个元素的所有子节点并拼接 LaTeX。 */
function walkChildren(el) {
  let out = '';
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out += walk(n);
    else if (n.nodeType === 3 && el.localName === 't') out += mapText(n.nodeValue);
  }
  return out;
}

/** 核心：把一个 OMML 元素翻译成 LaTeX。 */
function walk(el) {
  switch (el.localName) {
    case 'oMath':
    case 'oMathPara':
    case 'e':
    case 'num':
    case 'den':
    case 'sup':
    case 'sub':
    case 'deg':
    case 'lim':
    case 'fName':
    case 'box':
    case 'phant':
      return walkChildren(el);

    case 't': {
      let s = '';
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) s += n.nodeValue;
      }
      return mapText(s);
    }

    case 'r': {
      const text = walkChildren(el);
      // m:nor 表示"普通文本"（非斜体变量），用 \mathrm 保留原样
      const isNormal = !!child(child(el, 'rPr'), 'nor');
      if (isNormal && text.trim()) return `\\mathrm{${text}}`;
      const sty = propVal(el, 'rPr', 'sty');
      if (sty === 'b') return `\\mathbf{${applyFunctionNames(text)}}`;
      if (sty === 'p' && text.trim()) return `\\mathrm{${text}}`;
      return applyFunctionNames(text);
    }

    case 'f': {
      const type = propVal(el, 'fPr', 'type');
      const num = walkChildren(child(el, 'num'));
      const den = walkChildren(child(el, 'den'));
      if (type === 'lin') return `${brace(num)}/${brace(den)}`;
      if (type === 'noBar') return `\\binom${brace(num)}${brace(den)}`;
      if (type === 'skw') return `{}^{${num}}/_{${den}}`;
      return `\\frac{${num.trim()}}{${den.trim()}}`;
    }

    case 'sSup':
      return `${brace(walkChildren(child(el, 'e')))}^${brace(walkChildren(child(el, 'sup')))}`;

    case 'sSub':
      return `${brace(walkChildren(child(el, 'e')))}_${brace(walkChildren(child(el, 'sub')))}`;

    case 'sSubSup':
      return `${brace(walkChildren(child(el, 'e')))}_${brace(walkChildren(child(el, 'sub')))}^${brace(walkChildren(child(el, 'sup')))}`;

    case 'sPre':
      return `{}_${brace(walkChildren(child(el, 'sub')))}^${brace(walkChildren(child(el, 'sup')))}${brace(walkChildren(child(el, 'e')))}`;

    case 'rad': {
      const degHide = propVal(el, 'radPr', 'degHide');
      const deg = walkChildren(child(el, 'deg'));
      const e = walkChildren(child(el, 'e'));
      if (degHide === '1' || degHide === 'on' || !deg.trim()) return `\\sqrt${brace(e)}`;
      return `\\sqrt[${deg}]${brace(e)}`;
    }

    case 'nary': {
      const chr = propVal(el, 'naryPr', 'chr') ?? '∫';
      const op = NARY_MAP[chr] || '\\int';
      const subHide = propVal(el, 'naryPr', 'subHide');
      const supHide = propVal(el, 'naryPr', 'supHide');
      const limLoc = propVal(el, 'naryPr', 'limLoc');
      const sub = walkChildren(child(el, 'sub'));
      const sup = walkChildren(child(el, 'sup'));
      let s = op;
      // limLoc=undOvr 表示限位在上下方（如 \sum\limits），subSup 表示在右侧
      if (limLoc === 'undOvr') s += '\\limits';
      if (!(subHide === '1' || subHide === 'on') && sub.trim()) s += `_${brace(sub)}`;
      if (!(supHide === '1' || supHide === 'on') && sup.trim()) s += `^${brace(sup)}`;
      return `${s} ${walkChildren(child(el, 'e'))}`;
    }

    case 'd': {
      const beg = propVal(el, 'dPr', 'begChr');
      const end = propVal(el, 'dPr', 'endChr');
      const sep = propVal(el, 'dPr', 'sepChr');
      const L = DELIM_MAP[beg ?? '('] ?? '(';
      const R = DELIM_MAP[end ?? ')'] ?? ')';
      const parts = children(el, 'e').map(walkChildren);
      const S = sep ? (DELIM_MAP[sep] ?? sep) : '|';
      // 多个 m:e 表示被分隔符分开的多段（如 \left( a \middle| b \right)）
      const body = parts.length > 1 ? parts.join(` \\middle${S} `) : (parts[0] ?? '');
      return `\\left${L} ${body} \\right${R}`;
    }

    case 'func': {
      const name = walkChildren(child(el, 'fName')).trim();
      const arg = walkChildren(child(el, 'e'));
      // 已知函数名用标准命令，未知的用 \operatorname 保持直立体
      const known = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
        'sinh', 'cosh', 'tanh', 'coth', 'ln', 'log', 'lg', 'exp', 'lim', 'max', 'min',
        'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd', 'arg'];
      const plain = name.replace(/\\mathrm\{([^}]*)\}/g, '$1').replace(/\\/g, '').trim();
      if (known.includes(plain)) return `\\${plain}${arg ? ` ${brace(arg)}` : ''}`;
      // lim 带下标的情况：fName 本身是 limLow 结构，已经被递归处理过
      return `${name}${arg ? `\\left( ${arg} \\right)` : ''}`;
    }

    case 'acc': {
      const chr = propVal(el, 'accPr', 'chr') ?? '̂';
      const cmd = ACCENT_MAP[chr] || '\\hat';
      return `${cmd}${brace(walkChildren(child(el, 'e')))}`;
    }

    case 'bar': {
      const pos = propVal(el, 'barPr', 'pos');
      const cmd = pos === 'bot' ? '\\underline' : '\\overline';
      return `${cmd}${brace(walkChildren(child(el, 'e')))}`;
    }

    case 'groupChr': {
      const chr = propVal(el, 'groupChrPr', 'chr') ?? '⏟';
      const cmd = GROUP_CHR_MAP[chr] || '\\underbrace';
      return `${cmd}${brace(walkChildren(child(el, 'e')))}`;
    }

    case 'limLow': {
      const raw = rawText(child(el, 'lim')).trim();
      const base = brace(walkChildren(child(el, 'e')));
      // 下方是重音字符（如下划线）时用重音命令，语义比 \\underset 准确
      if (ACCENT_MAP[raw]) return `\\underline${base}`;
      return `\\underset${brace(walkChildren(child(el, 'lim')))}${base}`;
    }

    case 'limUpp': {
      const raw = rawText(child(el, 'lim')).trim();
      const base = brace(walkChildren(child(el, 'e')));
      // MathML→OMML 会把 \\vec/\\bar/\\hat 降级成 limUpp + 修饰符字符，这里还原成重音命令
      if (ACCENT_MAP[raw]) return `${ACCENT_MAP[raw]}${base}`;
      return `\\overset${brace(walkChildren(child(el, 'lim')))}${base}`;
    }

    case 'm': {
      // 矩阵：m:mr 是行，行内 m:e 是单元格
      const rows = children(el, 'mr').map((mr) => children(mr, 'e').map(walkChildren).join(' & '));
      return `\\begin{matrix} ${rows.join(' \\\\ ')} \\end{matrix}`;
    }

    case 'eqArr': {
      // 方程组/多行对齐
      const rows = children(el, 'e').map(walkChildren);
      return `\\begin{aligned} ${rows.join(' \\\\ ')} \\end{aligned}`;
    }

    case 'borderBox':
      return `\\boxed${brace(walkChildren(child(el, 'e')))}`;

    // 纯属性容器，不产出内容
    case 'rPr': case 'fPr': case 'radPr': case 'naryPr': case 'dPr':
    case 'accPr': case 'barPr': case 'groupChrPr': case 'mPr': case 'eqArrPr':
    case 'funcPr': case 'limLowPr': case 'limUppPr': case 'sSupPr': case 'sSubPr':
    case 'sSubSupPr': case 'sPrePr': case 'boxPr': case 'borderBoxPr': case 'phantPr':
    case 'ctrlPr': case 'argPr':
      return '';

    default:
      // 未知元素：不丢内容，继续递归
      return walkChildren(el);
  }
}

/** 清理：压缩空白、去掉冗余空格。 */
function tidy(latex) {
  return latex
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*([_^])\s*/g, '$1')
    .replace(/\{\s+/g, '{')
    .replace(/\s+\}/g, '}')
    .trim();
}

/**
 * 把单个 m:oMath 元素转成 LaTeX。
 * @param {Element} oMathEl
 * @returns {string}
 */
export function ommlElementToLatex(oMathEl) {
  return tidy(walk(oMathEl));
}

/**
 * 把一段 OMML XML 字符串转成 LaTeX（用于测试与独立调用）。
 * @param {string} xml 含 m:oMath 的 XML
 * @returns {string[]} 每个 oMath 一条 LaTeX
 */
export function ommlToLatex(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const out = [];
  const visit = (node) => {
    if (node.nodeType === 1) {
      if (node.localName === 'oMath') {
        out.push(ommlElementToLatex(node));
        return; // 不递归进已处理的公式
      }
      for (let n = node.firstChild; n; n = n.nextSibling) visit(n);
    }
  };
  visit(doc.documentElement);
  return out;
}
