// 调模型解题。走站内统一的桥接层 window.claude，因此：
//   · 用的是用户自己在顶栏填的 Key（和图纸解译台同一份，存在同一个 localStorage）
//   · 支持顶栏选择的任意厂商模型（Anthropic / DeepSeek / 智谱 / Apex）
//   · 不经过任何服务器，请求从浏览器直连厂商
//
// 两阶段：先拆题，再逐题求解。不一次性出整份答卷的原因：
//   1. 单次输出过长会触到 max_tokens 被截断，整份作废；
//   2. 逐题可以并发，也可以只重试失败的那一题。

import { SUBJECTS } from './config.js';
import { splitPrompt, solveOneQuestion } from './prompts.js';

/** 桥接层没有结构化输出约束，返回结果必须自己校验。 */
function requireShape(obj, check, label) {
  if (!obj || typeof obj !== 'object' || !check(obj)) {
    throw new Error(`${label}：模型返回的结构不符合约定`);
  }
  return obj;
}

/** 规范化模型产出的块：丢掉空块，修掉常见的 LaTeX 包裹问题。 */
function normalizeBlocks(blocks) {
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || !b.type) continue;
    switch (b.type) {
      case 'text':
      case 'answer':
        if (b.text && String(b.text).trim()) out.push({ type: b.type, text: String(b.text).trim() });
        break;
      case 'equation': {
        // 模型有时仍会带上 $ 包裹，统一剥掉，否则会变成"公式里套公式"
        let tex = String(b.latex || '').trim();
        tex = tex.replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1').trim();
        if (tex) out.push({ type: 'equation', latex: tex });
        break;
      }
      case 'figure':
        if (b.svg && String(b.svg).trim().startsWith('<svg')) {
          out.push({ type: 'figure', svg: String(b.svg).trim(), caption: String(b.caption || '').trim() });
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

/** 有上限的并发执行，避免一次打满速率限制。 */
async function pooled(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

function describeError(e) {
  if (e && e.code === 'invalid_json') return '模型没有按要求返回 JSON（可换一个模型重试，或把文档拆小一些）';
  if (e && e.message) return e.message;
  return String(e);
}

/**
 * 解析并求解整份文档。
 * @param {object} extracted 抽取结果
 * @param {{subject:string,font:string,sourceName:string,autoDraw:boolean,tier:string,concurrency:number}} opts
 * @param {(msg:string, level?:string)=>void} log
 */
export async function solve(extracted, opts, log) {
  const sample = await window.claude.use('sample');
  if (!sample) throw new Error('桥接层未就绪，请刷新页面重试');

  const subjectKey = SUBJECTS[opts.subject] ? opts.subject : 'other';
  const subject = SUBJECTS[subjectKey];
  const images = (extracted.images || []).map((i) => i.blob).filter(Boolean);
  const tier = opts.tier || 'default';

  // ---- 第一阶段：拆题 ----
  log(`正在识别题目结构${images.length ? `（含 ${images.length} 张图）` : ''}…`);
  let paper;
  try {
    paper = await sample.json(splitPrompt(extracted.text || '(无文字内容)', images.length > 0), { images, tier });
  } catch (e) {
    throw new Error(`拆题失败：${describeError(e)}`);
  }
  requireShape(paper, (o) => Array.isArray(o.questions), '拆题');
  const questions = paper.questions.filter((q) => q && q.statement);
  if (!questions.length) {
    throw new Error('没有识别出任何题目。请确认上传的是作业或试卷，且不是空白文档。');
  }
  log(`识别到 ${questions.length} 道题`, 'ok');

  // ---- 第二阶段：逐题求解 ----
  // 只给引用了图的题目重发图片：桥接层没有缓存，每题都带图会成倍增加成本
  const solveOne = async (q, idx) => {
    const needsImages = Array.isArray(q.figure_refs) && q.figure_refs.length > 0;
    try {
      const raw = await sample.json(solveOneQuestion(subjectKey, q, { autoDraw: opts.autoDraw }), {
        images: needsImages ? images : [],
        tier,
      });
      requireShape(raw, (o) => Array.isArray(o.blocks), `第 ${q.number} 题`);
      log(`第 ${q.number} 题完成`, 'ok');
      return {
        number: String(raw.number || q.number),
        title: String(raw.title || q.title || ''),
        statement: q.statement,
        blocks: normalizeBlocks(raw.blocks),
      };
    } catch (e) {
      log(`第 ${q.number} 题失败：${describeError(e)}`, 'error');
      // 单题失败不拖垮整份答卷，把失败原因写进答卷对应位置
      return {
        number: String(q.number),
        title: String(q.title || ''),
        statement: q.statement,
        blocks: [{ type: 'text', text: `**本题求解失败：**${describeError(e)}` }],
        failed: true,
      };
    }
  };

  log(`开始求解（并发 ${opts.concurrency}，投入档位 ${tier}）…`);
  const solved = await pooled(questions, opts.concurrency || 2, solveOne);
  const failedCount = solved.filter((q) => q.failed).length;
  if (failedCount) log(`${failedCount} 道题求解失败，已在答卷中标出`, 'warn');

  return {
    meta: {
      title: String(paper.doc_title || `${subject.name}作业解答`),
      subtitle: `${subject.name} · 共 ${solved.length} 题`,
      font: opts.font,
      sourceName: opts.sourceName,
      generatedAt: new Date().toISOString(),
    },
    questions: solved,
    failedCount,
  };
}
