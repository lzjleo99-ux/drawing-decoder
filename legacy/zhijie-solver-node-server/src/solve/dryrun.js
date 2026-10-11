// 空跑模式（SOLVER_DRY_RUN=1）：跳过 Claude 调用，用抽取结果直接拼出一份答卷。
//
// 用途有两个，都不是"假装能解题"：
//   1. 没有 API 密钥时也能验证上传、抽取、排版、导出这四段是否正常；
//   2. 检查抽取质量 —— 从 Word 公式还原出的 LaTeX 会原样显示出来，
//      一眼能看出公式有没有抽丢、抽错。
// 产出的文档标题明确写着"空跑"，不会被误当成真答案。

import { SUBJECTS } from '../config.js';

/** 从抽取文本里摘出公式（$...$ / $$...$$），用于展示还原质量。 */
function collectEquations(text) {
  const out = [];
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let m;
  while ((m = re.exec(text)) !== null && out.length < 40) {
    const tex = (m[1] ?? m[2]).trim();
    if (tex) out.push(tex);
  }
  return out;
}

export function dryRunAnswer(extracted, opts, log) {
  const subject = SUBJECTS[opts.subject] || SUBJECTS.other;
  const equations = collectEquations(extracted.text || '');
  log(`空跑模式：跳过模型调用，直接用抽取结果生成文档（抽到 ${equations.length} 个公式）`, 'warn');

  const blocks = [
    {
      type: 'text',
      text: '**本文档由空跑模式生成，不包含任何解题内容。** '
        + '它用于验证上传、文档抽取、公式还原、排版与导出链路是否正常。'
        + '设置环境变量 `ANTHROPIC_API_KEY` 并关闭 `SOLVER_DRY_RUN` 后即可真正求解。',
    },
    {
      type: 'text',
      text: `来源文件：${opts.sourceName}；类型：${extracted.kind}；`
        + `文本长度：${(extracted.text || '').length} 字；`
        + (extracted.kind === 'docx'
          ? `Word 公式对象：${extracted.equationCount} 个；图片：${(extracted.images || []).length} 张。`
          : `页数：${extracted.pageCount}；视觉通道：${extracted.pdfBase64 ? '已启用' : '未启用'}。`),
    },
  ];

  if (equations.length) {
    blocks.push({ type: 'text', text: '**从原文还原出的公式（按出现顺序）：**' });
    for (const tex of equations) blocks.push({ type: 'equation', latex: tex });
  } else {
    blocks.push({ type: 'text', text: '原文中没有检测到公式对象。若原文确实含公式，可能是以图片形式嵌入的。' });
  }

  const excerpt = (extracted.text || '').slice(0, 1200);
  if (excerpt) {
    blocks.push({ type: 'text', text: '**抽取文本摘录（前 1200 字）：**' });
    // 摘录里的 $ 会被当成公式分隔符，先转义掉，否则排版会乱
    blocks.push({ type: 'text', text: excerpt.replace(/\$/g, '\\$').replace(/\*\*/g, '') });
  }

  if (extracted.warnings?.length) {
    blocks.push({ type: 'text', text: '**抽取警告：**' });
    for (const w of extracted.warnings) blocks.push({ type: 'text', text: `· ${w}` });
  }

  blocks.push({ type: 'answer', text: '空跑模式无答案输出。' });

  return {
    meta: {
      title: `${subject.name}抽取结果（空跑，非答案）`,
      subtitle: `空跑模式 · 来源 ${opts.sourceName}`,
      font: opts.font,
      sourceName: opts.sourceName,
      generatedAt: new Date().toISOString(),
      dryRun: true,
    },
    questions: [{ number: '', title: '抽取与排版链路自检', statement: '', blocks }],
  };
}
