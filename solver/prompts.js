// 提示词。
//
// 两件事由界面语言决定：
//   1. 答卷正文的语言（中/英/塞），由 solver.ansLang 指令控制；
//   2. 科目名与常见题型，用当前语言给模型，避免中英混杂。
//
// 桥接层没有 system 参数，也没有结构化输出约束，所以 JSON 结构必须在提示词里
// 写清楚，并由 solve.js 自己校验返回结果。

import { SUBJECTS } from './config.js';
import { T } from './ui.js';
import { methodIds, pickMethod, methodBlock } from './methods.js';

/**
 * 是否把解法卡片注入提示词。
 *
 * 默认关闭 —— 这是实测结论，不是偏好。用 Apex 的 Qwen3.8-27B 做配对对比
 * （同一份提示词，只把卡片那一段删掉，其余完全相同）：
 *   统计·区间估计   无卡片 51.3s/推理 6107   有卡片 71.4s/推理 9463
 *   同题复测        无卡片 91.6s/推理 12280  有卡片 113.8s/推理 13466
 *   机械·轴强度(难) 两者都是推理约 1.8 万字、正文 0 字、撞上 max_tokens
 * 卡片只增加开销，难题上也救不了场；真正的瓶颈是 token 预算（见 solve.js）。
 *
 * 卡片库本身保留：39 张卡片、110 条公式都过了渲染校验，
 * 想重新启用（或改成只注入一行提示再做 A/B）把这里改 true 即可。
 */
const INJECT_METHOD_CARDS = false;

// temml/KaTeX 支持的是 LaTeX 的一个子集，写出它不认的命令就会渲染失败。
// 这段约束同时服务于 DOCX 导出：Word 那条路径无法测量宽度，
// 所以靠"每个公式只写一步"从源头避免超宽。
const LATEX_RULES = `
Formula rules (strict — violations fail to render):
- Use only standard LaTeX math commands supported by KaTeX / temml.
- Forbidden: \\begin{align}, \\begin{equation}, \\label, \\ref, \\require, \\newcommand.
  Use \\begin{aligned} ... \\end{aligned} for multi-line alignment.
- Matrices: \\begin{matrix} / \\begin{pmatrix} / \\begin{bmatrix}.
- Wrap all units and words inside math in \\text{...}, e.g. \\text{N}\\cdot\\text{mm}, \\text{MPa}.
  Never leave a unit as an italic variable.
- An "equation" block contains pure LaTeX only — no $ or $$ wrappers.
- Inline formulas inside a "text" block use single $...$ and must not span lines.
- One equation block = one equation or one derivation step. Split long chains
  (a = b = c = d) into several equation blocks; over-wide formulas overflow an A4 page.
- Show the substitution of numbers, and keep a sensible number of significant figures (usually 4).
`.trim();

const SVG_RULES = `
Diagram rules (only draw when a diagram genuinely helps):
- Output complete SVG with xmlns="http://www.w3.org/2000/svg" plus width, height and viewBox.
- Width <= 420, height <= 320.
- Presentation attributes only: stroke, fill, stroke-width, stroke-dasharray, font-size, text-anchor.
  Forbidden: <style>, CSS classes, external fonts, <foreignObject>, <image>, <script>.
- Draw arrowheads with <polygon> or <path> directly; do not rely on <marker> url(#...) references.
- Label every force, dimension and angle with <text>. Compute coordinates so that
  all elements fall inside the viewBox.
`.trim();

export function splitPrompt(sourceText, hasImages, subjectKey) {
  const ids = INJECT_METHOD_CARDS ? methodIds(subjectKey) : [];
  const typeRule = ids.length
    ? `- Tag each question with "type", choosing the single best match from this list:\n  ${ids.join(', ')}\n  Use "" if none of them fits. This only routes the question to a standard method; do not solve anything.`
    : '- Leave "type" as an empty string.';

  return `You are an expert at parsing science and engineering exam papers.
Split the document below into individual questions.

Rules:
- Output every question in the original order; keep the original question numbers.
  If the source has no numbers, number them by order of appearance.
- "statement" must preserve every given condition, value and unit from the original.
  Do not summarise, do not omit. Keep the original wording and language here.
- Wrap formulas in the statement with $...$ (LaTeX).
- ${hasImages
    ? 'Figures from the document are attached as images. When a question refers to a figure, list it in figure_refs (e.g. ["图1"] or ["page 2"]) and describe in the statement what the figure provides.'
    : 'The document has no figures; figure_refs must always be an empty array.'}
- Split only. Do not solve anything.
- Exam instructions, name fields and score boxes are not questions — ignore them.

${typeRule}

Output JSON only, no prose:
{"doc_title":"...","questions":[{"number":"...","title":"<=20 chars","statement":"...","figure_refs":[],"type":"..."}]}

Document:
${sourceText}`;
}

export function solveOneQuestion(subjectKey, question, opts) {
  const subject = SUBJECTS[subjectKey] || SUBJECTS.other;
  const subjectName = T(subject.i18n, subject.en);
  const modules = T(subject.mod, '');
  const moduleHint = modules ? `Typical topics in this subject: ${modules}.` : '';
  // 答卷语言指令放在开头和结尾两个最显著的位置，中间夹着格式约束
  const langRule = T('solver.ansLang', '用简体中文作答。');
  const diagramHint = opts.autoDraw && subject.diagrams
    ? SVG_RULES
    : 'Do not output any figure block this time; describe diagrams in words instead.';
  const refs = question.figure_refs?.length
    ? `\nFigures referenced by this question: ${question.figure_refs.join(', ')} (attached as images)`
    : '';

  // 只注入这一题用得上的那张解法卡片。给出标准方法后模型不必自己摸索路线，
  // 推理量明显下降，解法也更贴合教材。匹配不到就退回通用提示词。
  const method = INJECT_METHOD_CARDS ? pickMethod(subjectKey, question.type, question.statement) : null;
  const methodHint = method ? `\n${methodBlock(method)}\n` : '';

  return `You are an experienced teacher of ${subjectName} (${subject.en}), writing a worked solution for a student.
${moduleHint}

**LANGUAGE: ${langRule}**

Requirements:
- State the approach or governing principle first, then the derivation, then the answer.
- Show the complete derivation and numeric substitution — never jump straight to a result.
- Justify each step (which theorem, which formula, which boundary condition).
- Engineering problems: check units, and include units in the answer.
- The last block must be type "answer" with the explicit final result.
- If the data is insufficient or ambiguous, say so in a text block, state the assumption
  you are adding, then finish the solution under that assumption. Never refuse, and never
  pretend the data is complete.
- "statement" in your output is the question restated in the answer language above.

${methodHint}
${LATEX_RULES}

${diagramHint}

Output JSON only, no prose. Fill only the fields each block type needs:
{"number":"...","title":"<=20 chars","statement":"the question, restated","blocks":[
  {"type":"text","text":"prose, inline formulas as $...$"},
  {"type":"equation","latex":"pure LaTeX, no $"},
  {"type":"figure","svg":"<svg .../>","caption":"Fig 1: ..."},
  {"type":"table","headers":["col"],"rows":[["value"]]},
  {"type":"answer","text":"final answer"}
]}

**${langRule}**

Now solve this one question (number ${question.number}) and only this one:
${question.statement}${refs}`;
}
