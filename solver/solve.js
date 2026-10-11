// 调模型解题。走站内统一的桥接层 window.claude，因此：
//   · 用的是用户自己在顶栏填的 Key（和图纸解译台同一份，存在同一个 localStorage）
//   · 支持顶栏选择的任意厂商模型（Anthropic / DeepSeek / 智谱 / Apex）
//   · 不经过任何服务器，请求从浏览器直连厂商
//
// 两阶段：先拆题，再逐题求解。不一次性出整份答卷的原因：
//   1. 单次输出过长会触到 max_tokens 被截断，整份作废；
//   2. 逐题可以并发，也可以只重试失败的那一题。

import { SUBJECTS, LAYOUT } from './config.js';
import { T, TF, questionWord } from './ui.js';
import { splitPrompt, solveOneQuestion } from './prompts.js';

/** 桥接层没有结构化输出约束，返回结果必须自己校验。 */
function requireShape(obj, check, label) {
  if (!obj || typeof obj !== 'object' || !check(obj)) {
    throw new Error(TF('serr.shape', { label }));
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
  if (e && e.code === 'invalid_json') return T('serr.badJson');
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
  if (!sample) throw new Error(T('serr.bridge'));

  const subjectKey = SUBJECTS[opts.subject] ? opts.subject : 'other';
  const subject = SUBJECTS[subjectKey];
  const images = (extracted.images || []).map((i) => i.blob).filter(Boolean);
  const tier = opts.tier || 'default';

  // ---- 第一阶段：拆题 ----
  log(images.length ? TF('slog.splittingImg', { n: images.length }) : T('slog.splitting'));
  let paper;
  try {
    paper = await sample.json(splitPrompt(extracted.text || '(empty)', images.length > 0, subjectKey), { images, tier });
  } catch (e) {
    throw new Error(TF('serr.split', { msg: describeError(e) }));
  }
  requireShape(paper, (o) => Array.isArray(o.questions), '拆题');
  const questions = paper.questions.filter((q) => q && q.statement);
  if (!questions.length) {
    throw new Error(T('serr.noQuestions'));
  }
  log(TF('slog.splitDone', { n: questions.length }), 'ok');

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
      log(TF('slog.qDone', { n: q.number }), 'ok');
      return {
        number: String(raw.number || q.number),
        title: String(raw.title || q.title || ''),
        // 用模型按答卷语言重述的题干；缺失才退回原文，避免英文解答配中文题干
        statement: String(raw.statement || q.statement),
        blocks: normalizeBlocks(raw.blocks),
      };
    } catch (e) {
      log(TF('slog.qFail', { n: q.number, msg: describeError(e) }), 'error');
      // 单题失败不拖垮整份答卷，把失败原因写进答卷对应位置
      return {
        number: String(q.number),
        title: String(q.title || ''),
        statement: q.statement,
        blocks: [{ type: 'text', text: `**${TF('slog.qFail', { n: q.number, msg: describeError(e) })}**` }],
        failed: true,
      };
    }
  };

  log(TF('slog.solveStart', { c: opts.concurrency || 2, tier }));
  const solved = await pooled(questions, opts.concurrency || 2, solveOne);
  const failedCount = solved.filter((q) => q.failed).length;
  if (failedCount) log(TF('slog.someFailed', { n: failedCount }), 'warn');

  const subjectName = T(subject.i18n, subject.en);
  return {
    meta: {
      title: String(paper.doc_title || T('solver.docTitleFallback', '作业解答')),
      subtitle: `${subjectName} · ${solved.length} ${questionWord(solved.length)}`,
      font: opts.font,
      bodyPt: opts.bodyPt || LAYOUT.bodyPt,
      subject: subjectKey,
      sourceName: opts.sourceName,
      generatedAt: new Date().toISOString(),
    },
    questions: solved,
    failedCount,
  };
}
