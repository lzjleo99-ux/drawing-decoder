// HTTP 服务：上传 → 抽取 → 求解 → 渲染，日志通过 SSE 实时推给前端。

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SUBJECTS, FONTS, DEFAULT_FONT, UPLOAD, LAYOUT, MODEL } from './src/config.js';
import { extract } from './src/extract/index.js';
import { solve } from './src/solve/solver.js';
import { renderHtml } from './src/render/html.js';
import { renderDocx } from './src/render/docx.js';
import { renderPdf, closeBrowser } from './src/render/pdf.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD.maxBytes, files: 1 },
});

// 任务存在内存里。单机单进程的小工具不值得引入数据库，
// 但要记得这意味着重启后历史任务丢失（下载链接失效）。
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

function newJob() {
  const job = {
    id: randomUUID(),
    status: 'pending',
    log: [],
    listeners: new Set(),
    createdAt: Date.now(),
    answerDoc: null, html: null, docx: null, pdf: null,
    stats: {}, warnings: [], error: null,
  };
  jobs.set(job.id, job);
  return job;
}

function emit(job, event, payload) {
  const entry = { event, ...payload, t: new Date().toISOString() };
  if (event === 'log') job.log.push(entry);
  for (const res of job.listeners) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(entry)}\n\n`);
  }
}

function logger(job) {
  return (message, level = 'info') => emit(job, 'log', { message, level });
}

/** 后台跑完整流程。任何一步失败都记在任务上并通知前端。 */
async function runJob(job, file, opts) {
  const log = logger(job);
  job.status = 'running';
  try {
    log(`收到文件 ${file.originalname}（${(file.buffer.length / 1048576).toFixed(2)}MB）`);

    log('正在解析文档…');
    const extracted = await extract(file.buffer, file.originalname);
    job.warnings.push(...extracted.warnings);
    for (const w of extracted.warnings) log(w, 'warn');
    if (extracted.kind === 'docx') {
      log(`抽取完成：${extracted.text.length} 字，${extracted.equationCount} 个 Word 公式，${extracted.images.length} 张图`);
    } else {
      log(`抽取完成：${extracted.pageCount} 页，${extracted.text.length} 字${extracted.pdfBase64 ? '，已启用视觉识别通道' : '，仅文字层'}`);
    }

    job.answerDoc = await solve(extracted, opts, log);

    log('正在排版…');
    const { html, stats: htmlStats } = renderHtml(job.answerDoc, { autoLayout: opts.autoLayout });
    job.html = html;

    const { buffer: docxBuf, stats: docxStats } = await renderDocx(job.answerDoc);
    job.docx = docxBuf;
    log(`Word 答卷已生成：${docxStats.ommlOk} 个公式转为 Word 原生公式对象（可编辑），${docxStats.figures} 张图`);
    if (docxStats.ommlFail) {
      log(`${docxStats.ommlFail} 个公式无法转为 Word 公式，已在文档中保留 LaTeX 源码：${docxStats.failedLatex.join(' | ')}`, 'warn');
    }

    const { buffer: pdfBuf, adjusted } = await renderPdf(html);
    job.pdf = pdfBuf;
    const scaled = adjusted.filter((a) => a.scale !== 'wrap').length;
    const wrapped = adjusted.filter((a) => a.scale === 'wrap').length;
    if (adjusted.length) {
      log(`版面溢出检查：${scaled} 个公式已缩放适配，${wrapped} 个公式改为断行处理`, 'warn');
    } else {
      log('版面溢出检查：全部公式宽度正常，无需重排');
    }

    job.stats = {
      questions: job.answerDoc.questions.length,
      mathTotal: htmlStats.mathOk + htmlStats.mathFail,
      mathFail: htmlStats.mathFail,
      ommlOk: docxStats.ommlOk,
      ommlFail: docxStats.ommlFail,
      figures: docxStats.figures,
      overflowScaled: scaled,
      overflowWrapped: wrapped,
      docxBytes: docxBuf.length,
      pdfBytes: pdfBuf.length,
    };
    job.status = 'done';
    log('答卷生成完毕，可以下载。', 'ok');
    emit(job, 'done', { stats: job.stats, warnings: job.warnings });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    emit(job, 'error', { message: e.message });
  }
}

app.use(express.static(path.join(here, 'public')));

// 前端的科目与字体列表从这里取，避免和 config.js 各写一份
app.get('/api/config', (_req, res) => {
  res.json({
    subjects: Object.entries(SUBJECTS).map(([id, s]) => ({
      id, name: s.name, nameEn: s.nameEn, modules: s.modules, diagrams: s.diagrams,
    })),
    fonts: Object.entries(FONTS).map(([id, f]) => ({ id, label: f.label })),
    defaultFont: DEFAULT_FONT,
    limits: { maxBytes: UPLOAD.maxBytes, allowedExt: UPLOAD.allowedExt },
    layout: LAYOUT,
    model: MODEL.id,
  });
});

app.post('/api/jobs', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到文件' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!UPLOAD.allowedExt.includes(ext)) {
    return res.status(400).json({ error: `不支持的文件类型 ${ext || '(无扩展名)'}，仅支持 ${UPLOAD.allowedExt.join(' / ')}` });
  }
  const job = newJob();
  const opts = {
    subject: SUBJECTS[req.body.subject] ? req.body.subject : 'other',
    font: FONTS[req.body.font] ? req.body.font : DEFAULT_FONT,
    sourceName: req.file.originalname,
    // 复选框以字符串形式提交，只有显式 'false' 才算关闭
    autoLayout: req.body.autoLayout !== 'false',
    autoDraw: req.body.autoDraw !== 'false',
  };
  // 不等任务跑完就返回，前端靠 SSE 看进度
  runJob(job, req.file, opts);
  res.status(202).json({ jobId: job.id });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // 补发连接建立之前已经产生的日志，否则前端会丢掉开头几行
  for (const entry of job.log) {
    res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  }
  if (job.status === 'done') res.write(`event: done\ndata: ${JSON.stringify({ stats: job.stats, warnings: job.warnings })}\n\n`);
  if (job.status === 'error') res.write(`event: error\ndata: ${JSON.stringify({ message: job.error })}\n\n`);

  job.listeners.add(res);
  req.on('close', () => job.listeners.delete(res));
});

app.get('/api/jobs/:id/preview', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.html) return res.status(404).send('预览尚未生成');
  res.type('html').send(job.html);
});

app.get('/api/jobs/:id/download/:format', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' });
  const { format } = req.params;
  const base = (job.answerDoc?.meta?.title || '答卷').replace(/[\/\\?%*:|"<>]/g, '_');

  if (format === 'docx' && job.docx) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base)}.docx`);
    return res.send(job.docx);
  }
  if (format === 'pdf' && job.pdf) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base)}.pdf`);
    return res.send(job.pdf);
  }
  return res.status(404).json({ error: '文件尚未生成或格式不支持' });
});

// multer 的体积超限等错误要翻译成中文再返回
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `文件超过 ${UPLOAD.maxBytes / 1048576}MB 上限`
      : `上传失败：${err.message}`;
    return res.status(413).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS && job.listeners.size === 0) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`智解系统已启动： http://localhost:${port}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('警告：未设置 ANTHROPIC_API_KEY，求解会失败。请先 export ANTHROPIC_API_KEY=...');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeBrowser();
    server.close(() => process.exit(0));
  });
}
