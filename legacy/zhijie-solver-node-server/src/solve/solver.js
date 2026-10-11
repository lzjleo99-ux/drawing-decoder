// 调用 Claude 解题。
//
// 两阶段：先把文档拆成题目，再逐题求解。
// 为什么不一次性让模型输出整份答卷：
//   1. 单次输出过长容易触到 max_tokens 被截断，整份答卷一起作废；
//   2. 逐题求解可以并发，也可以只重试失败的那一题；
//   3. 每题的输出都在 16k 以内，不必上流式。
//
// 成本上的关键设计：源文档（PDF 字节 / docx 文本+图片）放在每次请求的
// 同一段前缀里并打上 cache_control，于是一份 10 题的试卷只上传一次源文档。
// 为了让缓存真正命中，第一题先单独跑（写入缓存），其余题目再并发。

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { MODEL, SUBJECTS } from '../config.js';
import { PaperSchema, SolutionSchema, normalizeBlocks } from './schema.js';
import { SPLIT_SYSTEM, solveSystem } from './prompts.js';
import { dryRunAnswer } from './dryrun.js';

let client = null;

function getClient() {
  if (client) return client;
  try {
    client = new Anthropic();
  } catch (e) {
    throw new Error(`无法初始化 Claude 客户端：${e.message}。请设置环境变量 ANTHROPIC_API_KEY。`);
  }
  return client;
}

/** 把 SDK 的异常翻译成给用户看的话，按"最具体优先"的顺序判断。 */
function describeApiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'API 密钥无效或已失效，请检查 ANTHROPIC_API_KEY。';
  if (e instanceof Anthropic.NotFoundError) return `模型 ${MODEL.id} 不可用（你的账号可能没有访问权限）。`;
  if (e instanceof Anthropic.RateLimitError) return '触发速率限制。可降低 SOLVER_CONCURRENCY 后重试。';
  if (e instanceof Anthropic.BadRequestError) return `请求被拒绝：${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return `网络连接失败：${e.message}`;
  if (e instanceof Anthropic.APIStatusError) return `API 返回 ${e.status}：${e.message}`;
  return e.message;
}

/**
 * 统一的结构化输出调用。
 * @returns {Promise<{parsed:object, usage:object}>}
 */
async function callParse({ system, content, schema, label }) {
  try {
    const res = await getClient().messages.parse({
      model: MODEL.id,
      max_tokens: MODEL.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: MODEL.effort,
        format: zodOutputFormat(schema),
      },
      // system 作为可缓存前缀；随请求变化的内容一律在 messages 里
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
    });

    // 安全分类器可能拒答，此时是 HTTP 200 但 stop_reason 为 refusal，
    // 必须在读 content 之前判断
    if (res.stop_reason === 'refusal') {
      throw new Error(`${label}：请求被模型安全策略拒绝（${res.stop_details?.category ?? '未说明原因'}）`);
    }
    if (res.stop_reason === 'max_tokens') {
      throw new Error(`${label}：输出超过 ${MODEL.maxTokens} tokens 被截断，请拆分文档后重试`);
    }
    if (!res.parsed_output) {
      throw new Error(`${label}：模型输出不符合约定结构，无法解析`);
    }
    return { parsed: res.parsed_output, usage: res.usage };
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw new Error(`${label}：${describeApiError(e)}`);
    throw e;
  }
}

/**
 * 源文档 → 可缓存的请求前缀。
 * PDF 直接走 document 块（模型能同时看到文字、公式和图形）；
 * docx 走抽取出的文本 + 图片。两者最后一块都打上 cache_control。
 */
function sourcePrefix(extracted) {
  const content = [];

  if (extracted.kind === 'pdf' && extracted.pdfBase64) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: extracted.pdfBase64 },
    });
  }

  for (const img of extracted.images || []) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }

  const header = extracted.kind === 'pdf' && extracted.pdfBase64
    ? '以上是原始 PDF。下面是从中抽取的文字层，仅供参考；如与 PDF 页面不一致，以 PDF 为准：'
    : '以下是从 Word 文档抽取的内容。其中 $...$ 是从 Word 公式对象还原出的 LaTeX，[图N] 对应上面按顺序给出的图片：';

  content.push({ type: 'text', text: `${header}\n\n${extracted.text || '(无文字内容)'}` });
  // 缓存断点打在前缀末尾：此后每题只追加各自的指令，前缀可复用
  content[content.length - 1].cache_control = { type: 'ephemeral' };
  return content;
}

/** 第一阶段：拆题。 */
async function splitQuestions(extracted, log) {
  log('正在识别题目结构…');
  const { parsed, usage } = await callParse({
    system: SPLIT_SYSTEM,
    content: [
      ...sourcePrefix(extracted),
      { type: 'text', text: '请把上面的文档拆分成一道一道独立的题目。' },
    ],
    schema: PaperSchema,
    label: '拆题',
  });
  log(`识别到 ${parsed.questions.length} 道题目（输入 ${usage.input_tokens} tokens，缓存写入 ${usage.cache_creation_input_tokens ?? 0}）`);
  return parsed;
}

/** 第二阶段：单题求解。 */
async function solveOne(extracted, subjectKey, question, index, log, opts = {}) {
  const refs = question.figure_refs?.length ? `\n本题引用的图：${question.figure_refs.join('、')}` : '';
  // 作图开关走 user 消息：system 是缓存前缀，改它会让整份试卷的缓存失效
  const drawRule = opts.autoDraw === false
    ? '\n\n本次不要输出任何 figure 块，用文字描述代替图示。'
    : '';
  const { parsed, usage } = await callParse({
    system: solveSystem(subjectKey),
    content: [
      ...sourcePrefix(extracted),
      {
        type: 'text',
        text: `请解答下面这一道题（题号 ${question.number}）。只解这一题，不要解其他题。\n\n`
          + `题干：\n${question.statement}${refs}${drawRule}`,
      },
    ],
    schema: SolutionSchema,
    label: `第 ${question.number} 题`,
  });
  const cached = usage.cache_read_input_tokens ?? 0;
  log(`第 ${question.number} 题完成（输出 ${usage.output_tokens} tokens，命中缓存 ${cached}）`, 'ok');
  return {
    number: parsed.number || question.number,
    title: parsed.title || question.title,
    statement: question.statement,
    blocks: normalizeBlocks(parsed.blocks),
  };
}

/** 有上限的并发执行，避免一次打满速率限制。 */
async function pooled(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 解析并求解整份文档。
 * @param {object} extracted 抽取结果
 * @param {{subject:string,font:string,sourceName:string}} opts
 * @param {(msg:string, level?:string)=>void} log
 * @returns {Promise<object>} 规范化答卷结构
 */
export async function solve(extracted, opts, log) {
  // 空跑：不调模型，用抽取结果拼文档，便于无密钥时自检整条链路
  if (process.env.SOLVER_DRY_RUN === '1') return dryRunAnswer(extracted, opts, log);

  const subjectKey = SUBJECTS[opts.subject] ? opts.subject : 'other';
  const subject = SUBJECTS[subjectKey];

  const paper = await splitQuestions(extracted, log);
  if (!paper.questions.length) {
    throw new Error('没有从文档中识别出任何题目。请确认上传的是作业或试卷，且不是纯扫描件。');
  }

  const questions = [];
  // 第一题单独跑，把源文档写进缓存，后面的并发请求才能命中
  log(`开始求解（模型 ${MODEL.id}，effort=${MODEL.effort}，并发 ${MODEL.concurrency}）…`);
  questions.push(await solveOne(extracted, subjectKey, paper.questions[0], 0, log, opts));

  const rest = paper.questions.slice(1);
  if (rest.length) {
    const solved = await pooled(rest, MODEL.concurrency, (q, i) =>
      solveOne(extracted, subjectKey, q, i + 1, log, opts));
    questions.push(...solved);
  }

  return {
    meta: {
      title: paper.doc_title || `${subject.name}作业解答`,
      subtitle: `${subject.name} · 共 ${questions.length} 题`,
      font: opts.font,
      sourceName: opts.sourceName,
      generatedAt: new Date().toISOString(),
    },
    questions,
  };
}
