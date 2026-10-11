// 前端交互。与后端的约定：
//   POST /api/jobs            → { jobId }
//   GET  /api/jobs/:id/events → SSE：log / done / error
//   GET  /api/jobs/:id/preview        → 答卷 HTML（与 PDF 同源）
//   GET  /api/jobs/:id/download/:fmt  → docx / pdf

const $ = (id) => document.getElementById(id);

const els = {
  subject: $('subjectSelect'), subjectHint: $('subjectHint'), font: $('fontSelect'),
  autoLayout: $('autoLayout'), autoDraw: $('autoDraw'),
  dropZone: $('dropZone'), fileInput: $('fileInput'), fileInfo: $('fileInfo'),
  fileName: $('fileName'), clearFileBtn: $('clearFileBtn'), formError: $('formError'),
  submitBtn: $('submitBtn'), modelBadge: $('modelBadge'), limitHint: $('limitHint'),
  tabPreview: $('tabPreview'), tabLog: $('tabLog'),
  panelPreview: $('panelPreview'), panelLog: $('panelLog'),
  previewPlaceholder: $('previewPlaceholder'), previewWrap: $('previewWrap'),
  previewFrame: $('previewFrame'),
  statusArea: $('statusArea'), statusText: $('statusText'),
  dlDocx: $('dlDocx'), dlPdf: $('dlPdf'),
};

let config = null;
let selectedFile = null;
let currentJob = null;
let eventSource = null;

// ---------- 配置：科目与字体都来自后端，前端不再各写一份 ----------

async function loadConfig() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('无法读取服务端配置');
  config = await res.json();

  els.subject.innerHTML = config.subjects
    .map((s) => `<option value="${s.id}">${s.name}${s.nameEn ? ` (${s.nameEn})` : ''}</option>`)
    .join('');
  els.font.innerHTML = config.fonts
    .map((f) => `<option value="${f.id}"${f.id === config.defaultFont ? ' selected' : ''}>${f.label}</option>`)
    .join('');
  els.modelBadge.textContent = config.model;
  els.limitHint.textContent =
    `支持 ${config.limits.allowedExt.join(' / ')}（最大 ${config.limits.maxBytes / 1048576}MB）`;
  updateSubjectHint();
}

function updateSubjectHint() {
  const s = config?.subjects.find((x) => x.id === els.subject.value);
  if (!s) return;
  const parts = [];
  if (s.modules.length) parts.push(`覆盖：${s.modules.join('、')}`);
  parts.push(s.diagrams ? '支持自动作图' : '一般不需作图');
  els.subjectHint.textContent = parts.join(' · ');
}

// ---------- 文件选择与校验 ----------

function showError(msg) {
  els.formError.textContent = msg;
  els.formError.classList.remove('hidden');
}

function clearError() {
  els.formError.classList.add('hidden');
  els.formError.textContent = '';
}

function handleFile(file) {
  clearError();
  const name = file.name || '';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';

  // 真实校验：原型里这两条限制只写在提示文字里，从不生效
  if (!config.limits.allowedExt.includes(ext)) {
    selectedFile = null;
    els.fileInfo.classList.add('hidden');
    els.submitBtn.disabled = true;
    showError(`不支持的文件类型 ${ext || '(无扩展名)'}，仅支持 ${config.limits.allowedExt.join(' / ')}`);
    return;
  }
  if (file.size > config.limits.maxBytes) {
    selectedFile = null;
    els.fileInfo.classList.add('hidden');
    els.submitBtn.disabled = true;
    showError(`文件 ${(file.size / 1048576).toFixed(1)}MB 超过 ${config.limits.maxBytes / 1048576}MB 上限`);
    return;
  }
  if (file.size === 0) {
    selectedFile = null;
    els.submitBtn.disabled = true;
    showError('文件为空');
    return;
  }

  selectedFile = file;
  els.fileName.textContent = `${name}（${(file.size / 1048576).toFixed(2)}MB）`;
  els.fileInfo.classList.remove('hidden');
  els.submitBtn.disabled = false;
}

function clearFile() {
  selectedFile = null;
  els.fileInput.value = '';
  els.fileInfo.classList.add('hidden');
  els.submitBtn.disabled = true;
  clearError();
}

// ---------- 标签页 ----------

const TAB_ON = 'px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-100 text-indigo-700 transition';
const TAB_OFF = 'px-3 py-1.5 text-xs font-medium rounded-lg text-slate-600 hover:bg-slate-100 transition';

function switchTab(tab) {
  const preview = tab === 'preview';
  els.tabPreview.className = preview ? TAB_ON : TAB_OFF;
  els.tabLog.className = preview ? TAB_OFF : TAB_ON;
  els.panelPreview.classList.toggle('hidden', !preview);
  els.panelLog.classList.toggle('hidden', preview);
  if (preview) scalePreview();
}

// ---------- 日志 ----------

const LEVEL_CLASS = {
  info: 'text-slate-300', ok: 'text-emerald-300',
  warn: 'text-amber-300', error: 'text-rose-400',
};

function resetLog() {
  els.panelLog.innerHTML = '';
}

function appendLog(entry) {
  const time = new Date(entry.t).toLocaleTimeString('zh-CN', { hour12: false });
  const cls = LEVEL_CLASS[entry.level] || LEVEL_CLASS.info;
  const p = document.createElement('p');
  p.className = cls;
  p.textContent = `[${time}] ${entry.message}`;
  els.panelLog.appendChild(p);
  els.panelLog.scrollTop = els.panelLog.scrollHeight;
}

// ---------- 预览缩放：iframe 里是 A4 实宽，整体缩放到面板宽度 ----------

const A4_PX = 794;

function scalePreview() {
  if (els.previewWrap.classList.contains('hidden')) return;
  const avail = els.panelPreview.clientWidth - 48;
  const scale = Math.min(1, avail / A4_PX);
  els.previewFrame.style.transform = `scale(${scale})`;
  els.previewWrap.style.width = `${A4_PX * scale}px`;
  const inner = els.previewFrame.contentDocument?.body?.scrollHeight;
  const h = inner ? inner : 1123;
  els.previewFrame.style.height = `${h}px`;
  els.previewWrap.style.height = `${h * scale}px`;
}

window.addEventListener('resize', scalePreview);

// ---------- 提交与 SSE ----------

function setBusy(busy) {
  els.submitBtn.disabled = busy || !selectedFile;
  els.submitBtn.textContent = busy ? '正在求解，请稍候…' : '立即一键求解并生成文档';
  els.dropZone.classList.toggle('pointer-events-none', busy);
  els.dropZone.classList.toggle('opacity-60', busy);
}

async function startSolving() {
  if (!selectedFile) return;
  clearError();
  setBusy(true);
  resetLog();
  switchTab('log');

  els.previewWrap.classList.add('hidden');
  els.previewPlaceholder.classList.remove('hidden');
  els.statusArea.classList.remove('hidden');
  els.statusText.textContent = '正在处理…';
  els.dlDocx.disabled = true;
  els.dlPdf.disabled = true;

  const body = new FormData();
  body.append('file', selectedFile);
  body.append('subject', els.subject.value);
  body.append('font', els.font.value);
  body.append('autoLayout', String(els.autoLayout.checked));
  body.append('autoDraw', String(els.autoDraw.checked));

  let jobId;
  try {
    const res = await fetch('/api/jobs', { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `提交失败（HTTP ${res.status}）`);
    jobId = data.jobId;
  } catch (e) {
    setBusy(false);
    els.statusArea.classList.add('hidden');
    showError(e.message);
    return;
  }

  currentJob = jobId;
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/jobs/${jobId}/events`);

  eventSource.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));

  eventSource.addEventListener('done', (e) => {
    const { stats, warnings } = JSON.parse(e.data);
    eventSource.close();
    setBusy(false);
    onDone(jobId, stats, warnings);
  });

  eventSource.addEventListener('error', (e) => {
    // 区分业务错误（后端发来的 error 事件）与连接中断
    let msg = '';
    try { msg = JSON.parse(e.data).message; } catch { /* 连接类错误没有 data */ }
    if (msg) {
      appendLog({ t: new Date().toISOString(), level: 'error', message: msg });
      showError(msg);
      els.statusText.textContent = '求解失败';
      eventSource.close();
      setBusy(false);
    } else if (eventSource.readyState === EventSource.CLOSED) {
      setBusy(false);
    }
  });
}

function onDone(jobId, stats, warnings) {
  els.previewPlaceholder.classList.add('hidden');
  els.previewWrap.classList.remove('hidden');
  els.previewFrame.src = `/api/jobs/${jobId}/preview`;
  els.previewFrame.addEventListener('load', scalePreview, { once: true });
  switchTab('preview');

  els.dlDocx.disabled = false;
  els.dlPdf.disabled = false;

  const bits = [
    `${stats.questions} 题`,
    `${stats.ommlOk} 个 Word 原生公式`,
    stats.figures ? `${stats.figures} 张图` : null,
    stats.overflowScaled ? `${stats.overflowScaled} 个公式已缩放` : null,
    stats.overflowWrapped ? `${stats.overflowWrapped} 个公式已断行` : null,
    stats.ommlFail ? `${stats.ommlFail} 个公式转换失败` : null,
  ].filter(Boolean);
  els.statusText.innerHTML =
    `<span class="font-bold text-slate-700">已完成：</span>${bits.join(' · ')}`
    + (warnings?.length ? `<br><span class="text-amber-600">${warnings.length} 条警告，详见求解日志</span>` : '');
}

function download(fmt) {
  if (!currentJob) return;
  // 用隐藏链接触发下载，保留服务端给出的文件名
  const a = document.createElement('a');
  a.href = `/api/jobs/${currentJob}/download/${fmt}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- 事件绑定 ----------

els.dropZone.addEventListener('click', () => els.fileInput.click());
els.dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener('change', (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});
['dragover', 'dragenter'].forEach((ev) => els.dropZone.addEventListener(ev, (e) => {
  e.preventDefault();
  els.dropZone.classList.add('border-indigo-500', 'bg-indigo-50');
}));
['dragleave', 'dragend'].forEach((ev) => els.dropZone.addEventListener(ev, () => {
  els.dropZone.classList.remove('border-indigo-500', 'bg-indigo-50');
}));
els.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropZone.classList.remove('border-indigo-500', 'bg-indigo-50');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

els.clearFileBtn.addEventListener('click', clearFile);
els.submitBtn.addEventListener('click', startSolving);
els.subject.addEventListener('change', updateSubjectHint);
els.tabPreview.addEventListener('click', () => switchTab('preview'));
els.tabLog.addEventListener('click', () => switchTab('log'));
els.dlDocx.addEventListener('click', () => download('docx'));
els.dlPdf.addEventListener('click', () => download('pdf'));

loadConfig().catch((e) => showError(e.message));
