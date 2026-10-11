// 生成测试用的"试卷"文件。
// .docx 用本项目的 DOCX 渲染器生成 —— 它写出的是真正的 OMML 公式对象，
// 因此作为抽取测试的输入是合格的替身（和 Word 存出来的结构一致）。

import fs from 'node:fs';
import { renderDocx } from '../src/render/docx.js';
import { renderHtml } from '../src/render/html.js';
import { renderPdf, closeBrowser } from '../src/render/pdf.js';

const paper = {
  meta: { title: '机械设计基础 期末作业', subtitle: '机械工程学院 · 共 3 题', font: 'font-serif-sc' },
  questions: [
    {
      number: '一', title: '齿轮传动受力计算',
      statement: '某直齿圆柱齿轮传动，主动轮转速 $n_1 = 1440\\ \\text{r/min}$，输入功率 $P = 7.5\\ \\text{kW}$，'
        + '分度圆直径 $d_1 = 80\\ \\text{mm}$，压力角 $\\alpha = 20^\\circ$。求切向力 $F_t$ 与径向力 $F_r$。',
      blocks: [
        { type: 'text', text: '提示：转矩与功率的关系为 $T = 9.55 \\times 10^6 P / n$。' },
        { type: 'figure', caption: '图1：齿轮啮合简图', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="130" viewBox="0 0 200 130"><circle cx="80" cy="65" r="40" fill="none" stroke="#333" stroke-width="2"/><line x1="80" y1="65" x2="150" y2="35" stroke="#333" stroke-width="1.5"/><polygon points="150,35 142,34 145,41" fill="#333"/><text x="152" y="32" font-size="11">Ft</text></svg>' },
      ],
    },
    {
      number: '二', title: '挤压变形抗力',
      statement: '铅块冷挤压，变形程度 $\\ln\\lambda = 1.2$，屈服极限 $\\sigma_s = 30\\ \\text{MPa}$，'
        + '摩擦影响系数 $b = 0.8$。按主应力法求平均单位挤压力 $p_{av}$。',
      blocks: [{ type: 'equation', latex: '\\sigma_p = \\sigma_s (1 + b \\ln \\lambda)' }],
    },
    {
      number: '三', title: '定积分计算',
      statement: '计算定积分 $\\int_{0}^{1} x e^{2x} \\mathrm{d}x$，并写出分部积分的完整过程。',
      blocks: [{ type: 'text', text: '要求保留精确表达式，不取小数近似。' }],
    },
  ],
};

const { buffer, stats } = await renderDocx(paper);
fs.writeFileSync('test/fixtures/homework.docx', buffer);
console.log(`homework.docx: ${buffer.length}B, ${stats.ommlOk} 个 OMML 公式, ${stats.figures} 张图`);

const { html } = renderHtml(paper);
const { buffer: pdf } = await renderPdf(html);
fs.writeFileSync('test/fixtures/homework.pdf', pdf);
console.log(`homework.pdf:  ${pdf.length}B`);

// 一个不含公式的最小 docx，用于验证"没有公式"的分支
const plain = { meta: { title: '纯文字作业' }, questions: [{ number: '一', title: '简答', statement: '请说明金属塑性变形的两种机制。', blocks: [] }] };
const { buffer: plainBuf } = await renderDocx(plain);
fs.writeFileSync('test/fixtures/plain.docx', plainBuf);
console.log(`plain.docx:    ${plainBuf.length}B`);

await closeBrowser();
