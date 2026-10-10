// 提示词。
//
// 与 Node 版的差别：桥接层没有 system 参数，也没有结构化输出约束，
// 所以 JSON 结构必须在提示词里写清楚，并由 solve.js 自己校验返回结果。

import { SUBJECTS } from './config.js';

// temml/KaTeX 支持的是 LaTeX 的一个子集，写出它不认的命令就会渲染失败。
// 这段约束同时服务于 DOCX 导出：Word 那条路径无法测量宽度，
// 所以靠"每个公式只写一步"从源头避免超宽。
const LATEX_RULES = `
公式书写规则（必须严格遵守，否则公式无法渲染）：
- 只使用 KaTeX / temml 支持的标准 LaTeX 数学命令。
- 禁止 \\begin{align}、\\begin{equation}、\\label、\\ref、\\require、\\newcommand。
  多行对齐用 \\begin{aligned} ... \\end{aligned}。
- 矩阵用 \\begin{matrix} / \\begin{pmatrix} / \\begin{bmatrix}。
- 单位与中文一律用 \\text{...} 包裹，例如 \\text{N}\\cdot\\text{mm}、\\text{MPa}，不要写成斜体变量。
- equation 块里只放纯 LaTeX，不要带 $ 或 $$ 包裹。
- text 块里的行内公式用单个 $...$ 包裹，且不要跨行。
- 每个 equation 块只写一个等式或一个推导步骤。一长串连等要拆成多个 equation 块，
  因为过宽的公式在 A4 纸上会溢出版面。
- 数值计算要写出代入过程，保留合理的有效数字（一般 4 位）。
`.trim();

const SVG_RULES = `
作图规则（确有必要才作图，不要为作图而作图）：
- 输出完整 SVG，必须带 xmlns="http://www.w3.org/2000/svg"，并同时给出 width、height、viewBox。
- 宽度不超过 420，高度不超过 320。
- 只用表现属性：stroke、fill、stroke-width、stroke-dasharray、font-size、text-anchor。
  禁止 <style> 标签、CSS class、外部字体、<foreignObject>、<image>、<script>。
- 箭头用 <polygon> 或 <path> 直接画，不要依赖 <marker> 的 url(#...) 引用。
- 所有受力、尺寸、角度都要用 <text> 标注清楚，坐标要算准，元素必须落在 viewBox 内。
`.trim();

export function splitPrompt(sourceText, hasImages) {
  return `你是理工科试卷解析专家。把下面的文档拆分成一道一道独立的题目。

要求：
- 按原文顺序输出每一道题，题号与原文一致；原文无题号则按出现顺序编号。
- statement 必须保留题干的全部已知条件、数值和单位，不要概括、不要省略。
- 题干中的公式用 $...$ 包裹（LaTeX）。
- ${hasImages ? '文档配图已作为图片一并给出。题目引用了图时，在 figure_refs 里标明（如 ["图1"] 或 ["第2页"]），并在 statement 里说明图中给出的条件。' : '文档没有配图，figure_refs 一律为空数组。'}
- 只做拆分，不要解题。
- 考试说明、姓名栏、分数栏不是题目，忽略。

只输出 JSON，不要任何解释文字，格式：
{"doc_title":"文档标题","questions":[{"number":"题号","title":"20字内概括","statement":"完整题干","figure_refs":[]}]}

文档内容：
${sourceText}`;
}

export function solveOneQuestion(subjectKey, question, opts) {
  const subject = SUBJECTS[subjectKey] || SUBJECTS.other;
  const moduleHint = subject.modules.length ? `本科目常见题型：${subject.modules.join('、')}。` : '';
  const diagramHint = opts.autoDraw && subject.diagrams
    ? SVG_RULES
    : '本次不要输出任何 figure 块，需要图示时用文字描述代替。';
  const refs = question.figure_refs?.length ? `\n本题引用的图：${question.figure_refs.join('、')}（已随附图片）` : '';

  return `你是${subject.name}（${subject.nameEn}）的资深教师，正在为学生写一份详细的解答。
${moduleHint}

解答要求：
- 先写解题思路或所用原理，再写推导，最后给出答案。
- 必须写出完整推导与数值代入过程，不能只给结果。
- 每一步都要说明依据（哪个定理、哪个公式、哪个边界条件）。
- 工程题必须检查单位，答案中要带单位。
- 最后必须有一个 type 为 answer 的块，给出明确的最终答案。
- 条件不足或有歧义时，在 text 块里明确指出并说明补充了什么假设，然后在该假设下解完。
  不要拒答，也不要假装条件齐全。

${LATEX_RULES}

${diagramHint}

只输出 JSON，不要任何解释文字。blocks 按解题顺序排列，每个块只填该类型需要的字段：
{"number":"题号","title":"20字内标题","blocks":[
  {"type":"text","text":"正文，行内公式用 $...$"},
  {"type":"equation","latex":"纯LaTeX，不带$"},
  {"type":"figure","svg":"<svg .../>","caption":"图1：说明"},
  {"type":"table","headers":["列1"],"rows":[["值1"]]},
  {"type":"answer","text":"最终答案"}
]}

现在解答这一道题（题号 ${question.number}），只解这一题：
${question.statement}${refs}`;
}
