// 访问站内共用的 i18n 层。
// i18n.js 是传统脚本，顶层 const/function 对模块可见；但为了在 Node 下
// 单独引用这些模块做测试时不炸，这里统一做存在性判断。

/** 取翻译；i18n 未就绪时回退到给定的兜底文案。 */
export function T(key, fallback) {
  if (typeof t === 'function') {
    const v = t(key);
    if (v && v !== key) return v;
  }
  return fallback !== undefined ? fallback : key;
}

/** 当前界面语言。 */
export function lang() {
  return typeof getLang === 'function' ? getLang() : 'zh';
}

/** 带占位符的翻译：T 的 {name} 由 vars 填充。 */
export function TF(key, vars, fallback) {
  const tpl = T(key, fallback);
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}

/**
 * 按数量选"题"的词形。各语言规则不同，不能共用一套：
 *   中文  —— 不变格
 *   英文  —— 只有正好 1 用单数（21 是 "21 questions"，不是 "21 question"）
 *   塞语  —— 1 / 2–4 / 5+ 三种变格，11–14 例外仍用第三种
 */
export function questionWord(n) {
  const l = lang();
  if (l === 'zh') return T('solver.hist.questions', '题');
  if (l === 'en') return n === 1 ? T('solver.hist.question1', 'question') : T('solver.hist.questions', 'questions');
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return T('solver.hist.question1', 'zadatak');
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return T('solver.hist.question24', 'zadatka');
  return T('solver.hist.questions', 'zadataka');
}
