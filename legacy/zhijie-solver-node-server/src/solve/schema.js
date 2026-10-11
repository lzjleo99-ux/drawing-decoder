// 结构化输出的 Zod 模式定义。
//
// 设计要点：解题块用"扁平 + 可空字段"而不是判别联合（discriminated union）。
// 严格 JSON Schema 对 anyOf/oneOf 的支持不稳，扁平结构更可靠；
// 代价是渲染器要自己按 type 取对应字段，这个代价很小。
//
// 更重要的是：把排版交给渲染器、把内容交给模型。模型只产出语义块
// （这是正文/这是公式/这是图），字体、行距、页边距、公式缩放全由
// config.js + 渲染器决定 —— 这是版式一致的前提，模型无法把版式搞乱。

// 必须从 zod/v4 导入：SDK 的 zodOutputFormat 内部用的是 zod v4 的 toJSONSchema，
// 传 v3 的 schema 进去会因为缺少内部字段直接崩掉。zod 3.25 起同时提供 v3 与 v4 两套入口。
import { z } from 'zod/v4';

export const BlockSchema = z.object({
  type: z.enum(['text', 'equation', 'figure', 'table', 'answer'])
    .describe('块类型：text=解题正文(可含行内公式) equation=独立成行的公式 figure=SVG图 table=表格 answer=最终答案'),
  text: z.string().nullable()
    .describe('type 为 text/answer 时的正文。行内公式用 $...$ 包裹，加粗用 **...**。其他类型填 null'),
  latex: z.string().nullable()
    .describe('type 为 equation 时的纯 LaTeX，不要带 $ 包裹。其他类型填 null'),
  svg: z.string().nullable()
    .describe('type 为 figure 时的完整 SVG 源码。其他类型填 null'),
  caption: z.string().nullable()
    .describe('type 为 figure 时的图题，如"图1：齿轮啮合受力分析"。其他类型填 null'),
  headers: z.array(z.string()).nullable()
    .describe('type 为 table 时的表头。其他类型填 null'),
  rows: z.array(z.array(z.string())).nullable()
    .describe('type 为 table 时的表格数据行。其他类型填 null'),
});

export const SolutionSchema = z.object({
  number: z.string().describe('题号，与原题一致'),
  title: z.string().describe('不超过 20 字的题目标题'),
  blocks: z.array(BlockSchema).describe('按解题顺序排列的内容块'),
});

export const QuestionSchema = z.object({
  number: z.string().describe('原题题号，如 "一" "1" "3(b)"；原文无题号则按出现顺序编号'),
  title: z.string().describe('不超过 20 字的题目概括'),
  statement: z.string().describe('完整题干，保留全部已知条件与数值。公式用 $...$ 包裹'),
  figure_refs: z.array(z.string()).describe('本题引用的图片标记，如 ["图1"]；没有则为空数组'),
});

export const PaperSchema = z.object({
  doc_title: z.string().describe('整份文档的标题，如"机械设计基础期末试卷"'),
  questions: z.array(QuestionSchema).describe('按原文顺序排列的题目'),
});

/** 把模型产出的块规范化：去掉空块、修掉常见的 LaTeX 包裹问题。 */
export function normalizeBlocks(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (!b || !b.type) continue;
    switch (b.type) {
      case 'text':
      case 'answer':
        if (b.text && b.text.trim()) out.push({ type: b.type, text: b.text.trim() });
        break;
      case 'equation': {
        // 模型有时仍会带上 $ 包裹，统一剥掉，否则会变成"公式里套公式"
        let tex = (b.latex || '').trim();
        tex = tex.replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1').trim();
        if (tex) out.push({ type: 'equation', latex: tex });
        break;
      }
      case 'figure':
        if (b.svg && b.svg.trim().startsWith('<svg')) {
          out.push({ type: 'figure', svg: b.svg.trim(), caption: (b.caption || '').trim() });
        }
        break;
      case 'table':
        if ((b.headers && b.headers.length) || (b.rows && b.rows.length)) {
          out.push({ type: 'table', headers: b.headers || [], rows: b.rows || [] });
        }
        break;
      default:
        break;
    }
  }
  return out;
}
