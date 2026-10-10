// 作业解答页的交互层。
//
// Key、模型、厂商全部交给站内共用的 local-bridge.js —— 和图纸解译台用的是
// 同一份 localStorage，所以用户在任一页填过 Key，另一页直接就能用。
// 本文件只负责：收集参数 → 抽取 → 求解 → 渲染 → 导出 → 存历史。

import { SUBJECTS, FONTS, DEFAULT_FONT, UPLOAD, LAYOUT, BODY_SIZES } from './config.js';
import { extract } from './extract.js';
import { solve } from './solve.js';
import { renderAnswerHtml, fitEquations } from './render-html.js';
import { renderDocx } from './render-docx.js';
import { loadHistory, saveToHistory, removeFromHistory, clearHistory, getFromHistory, HISTORY_CAP } from './history.js';
import { T, TF, questionWord } from './ui.js';

const $ = (id) => document.getElementById(id);

const el = {
  subject: $('subjectSel'), subjectHint: $('subjectHint'), font: $('fontSel'),
  size: $('sizeSel'), sizeHint: $('sizeHint'), tier: $('tierSel'),
  autoLayout: $('autoLayout'), autoDraw: $('autoDraw'),
  drop: $('drop'), fileInput: $('fileInput'), fileChip: $('fileChip'), fileName: $('fileName'),
  clearFile: $('clearFile'), formErr: $('formErr'), runBtn: $('runBtn'),
  tabPreview: $('tabPreview'), tabLog: $('tabLog'),
  emptyHint: $('emptyHint'), previewWrap: $('previewWrap'), sheetScroll: $('sheetScroll'),
  sheetScale: $('sheetScale'), sheet: $('ansSheet'), logView: $('logView'),
  ansDl: $('ansDl'), ansStat: $('ansStat'), dlDocx: $('dlDocx'), dlPdf: $('dlPdf'), pdfHint: $('pdfHint'),
  histList: $('histList'), histClear: $('histClear'), histCap: $('histCap'),
  langSel: $('langSel'),
};

const FONT_CLASS = { 'font-sans-sc': 'f-sans', 'font-serif-sc': 'f-serif', 'font-mono': 'f-mono' };

let file = null;
let answerDoc = null;
let detectedPt = null;   // 从原卷里量出来的正文字号
let busy = false;

// ---------------- 下拉框（全部走 i18n，切语言后要重填） ----------------

const TIERS = ['quick', 'default', 'complex'];

function fillSelects() {
  const keep = { s: el.subject.value, f: el.font.value, z: el.size.value, t: el.tier.value };

  el.subject.innerHTML = Object.entries(SUBJECTS)
    .map(([id, s]) => `<option value="${id}">${T(s.i18n, s.en)}</option>`).join('');
  el.subject.value = SUBJECTS[keep.s] ? keep.s : 'mech_eng';

  el.font.innerHTML = Object.entries(FONTS)
    .map(([id, v]) => `<option value="${id}">${T(v.i18n, id)}</option>`).join('');
  el.font.value = FONTS[keep.f] ? keep.f : DEFAULT_FONT;

  el.size.innerHTML = BODY_SIZES.map((v) => v === 'auto'
    ? `<option value="auto">${T('solver.size.auto', '跟随原卷')}</option>`
    : `<option value="${v}">${v}pt</option>`).join('');
  el.size.value = keep.z || 'auto';

  el.tier.innerHTML = TIERS.map((k) => `<option value="${k}">${T('solver.tier.' + k, k)}</option>`).join('');
  el.tier.value = keep.t || 'default';

  updateSubjectHint();
  updateSizeHint();
}

function updateSubjectHint() {
  const s = SUBJECTS[el.subject.value];
  if (!s) return;
  const mods = T(s.mod, '');
  const diag = T(s.diagrams ? 'solver.diagYes' : 'solver.diagNo', '');
  el.subjectHint.textContent = [mods, diag].filter(Boolean).join(' · ');
}

function updateSizeHint() {
  if (el.size.value !== 'auto') { el.sizeHint.textContent = ''; return; }
  el.sizeHint.textContent = detectedPt
    ? `${T('solver.size.detected', '原卷字号')}: ${detectedPt}pt`
    : '';
}

/** 当前应使用的正文字号。auto 时用量出来的，量不到退回默认。 */
function resolveBodyPt() {
  if (el.size.value === 'auto') return detectedPt || LAYOUT.bodyPt;
  return Number(el.size.value) || LAYOUT.bodyPt;
}

function applySheetStyle() {
  el.sheet.className = 'ans-sheet ' + (FONT_CLASS[el.font.value] || 'f-sans');
  el.sheet.style.fontSize = `${resolveBodyPt()}pt`;
}

// ---------------- 语言切换（本页没有 app.js，自己接管） ----------------

function initLangSel() {
  if (!el.langSel || typeof LANGS === 'undefined') return;
  el.langSel.innerHTML = LANGS.map((l) => `<option value="${l}">${LANG_NAMES[l]}</option>`).join('');
  el.langSel.value = getLang();
  el.langSel.addEventListener('change', () => {
    setLang(el.langSel.value);
    applyI18n();
    fillSelects();
    renderHistoryList();
    // 已生成的答卷内容是模型按当时语言写的，不会凭空翻译；
    // 但"答："这类界面文案要跟着变，所以重渲染一次。
    if (answerDoc) paintAnswer(answerDoc, { silent: true });
    window.__refreshBridgeI18n?.();
  });
}

// ---------------- 文件 ----------------

function showErr(msg) { el.formErr.textContent = msg; el.formErr.hidden = false; }
function clearErr() { el.formErr.hidden = true; el.formErr.textContent = ''; }

function pickFile(f) {
  clearErr();
  const name = f?.name || '';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  const reject = (msg) => { file = null; el.fileChip.hidden = true; el.runBtn.disabled = true; showErr(msg); };

  if (!UPLOAD.allowedExt.includes(ext)) {
    return reject(`${T('solver.limits', '')} — ${ext || '?'}`);
  }
  if (f.size > UPLOAD.maxBytes) {
    return reject(`${(f.size / 1048576).toFixed(1)}MB > ${UPLOAD.maxBytes / 1048576}MB`);
  }
  if (!f.size) return reject('0 B');

  file = f;
  el.fileName.textContent = `${name}（${(f.size / 1048576).toFixed(2)}MB）`;
  el.fileChip.hidden = false;
  el.runBtn.disabled = busy;
}

// ---------------- 日志与标签页 ----------------

function log(msg, level = 'info') {
  const p = document.createElement('p');
  p.className = level;
  p.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  el.logView.appendChild(p);
  el.logView.scrollTop = el.logView.scrollHeight;
}

function showTab(which) {
  const preview = which === 'preview';
  el.tabPreview.setAttribute('aria-pressed', String(preview));
  el.tabLog.setAttribute('aria-pressed', String(!preview));
  el.logView.hidden = preview;
  el.previewWrap.hidden = !preview || !answerDoc;
  el.emptyHint.hidden = !preview || !!answerDoc;
  if (preview) scalePreview();
}

// ---------------- 预览缩放：纸张按 A4 实宽渲染，整体缩放到面板宽度 ----------------

function scalePreview() {
  if (!answerDoc || el.previewWrap.hidden) return;
  const natural = el.sheet.offsetWidth;
  if (!natural) return;
  const k = Math.min(1, (el.sheetScroll.clientWidth - 28) / natural);
  el.sheetScale.style.transform = `scale(${k})`;
  el.sheetScale.style.width = `${natural * k}px`;
  el.sheetScale.style.height = `${el.sheet.offsetHeight * k}px`;
}

window.addEventListener('resize', scalePreview);

// ---------------- 渲染答卷 ----------------

function paintAnswer(doc, { silent = false } = {}) {
  const { html, stats } = renderAnswerHtml(doc);
  applySheetStyle();
  el.sheet.innerHTML = html;
  el.previewWrap.hidden = false;
  el.emptyHint.hidden = true;

  const adjusted = el.autoLayout.checked ? fitEquations(el.sheet) : [];
  const scaled = adjusted.filter((a) => a.scale !== 'wrap').length;
  const wrapped = adjusted.length - scaled;
  scalePreview();

  if (!silent) {
    log(adjusted.length
      ? TF('slog.overflow', { scaled, wrapped })
      : T('slog.overflowNone'), adjusted.length ? 'warn' : 'info');
    if (stats.mathFail) log(TF('slog.mathFail', { n: stats.mathFail }), 'warn');
    if (stats.svgRejected) log(TF('slog.svgRejected', { n: stats.svgRejected }), 'warn');
  }

  el.ansStat.textContent = [
    `${doc.questions.length} ${questionWord(doc.questions.length)}`,
    `${resolveBodyPt()}pt`,
    stats.figures ? `${stats.figures} fig` : null,
    scaled ? `${scaled} scaled` : null,
    doc.failedCount ? `${doc.failedCount} failed` : null,
  ].filter(Boolean).join(' · ');
  el.ansDl.hidden = false;
  el.pdfHint.hidden = false;
  return stats;
}

// ---------------- 历史记录 ----------------

function renderHistoryList() {
  const list = loadHistory();
  el.histCap.textContent = `${list.length}/${HISTORY_CAP} · ${T('solver.hist.cap', '')}`;
  if (!list.length) {
    el.histList.innerHTML = `<li class="empty">${T('solver.hist.empty', '还没有解答记录')}</li>`;
    return;
  }
  el.histList.innerHTML = list.map((h) => {
    const when = new Date(h.at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const title = (h.title || h.sourceName || '—').replace(/[<>&"]/g, '');
    return `<li><button type="button" class="open" data-id="${h.id}">`
      + `<span class="ht">${title}</span>`
      + `<span class="hd">${when} · ${h.count} ${questionWord(h.count)}</span>`
      + `</button><button type="button" class="del" data-del="${h.id}" title="${T('solver.hist.del', '删除')}">×</button></li>`;
  }).join('');
}

el.histList.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { removeFromHistory(del.getAttribute('data-del')); renderHistoryList(); return; }
  const open = e.target.closest('[data-id]');
  if (!open) return;
  const entry = getFromHistory(open.getAttribute('data-id'));
  if (!entry?.doc) return;
  answerDoc = entry.doc;
  if (answerDoc.meta?.font && FONTS[answerDoc.meta.font]) el.font.value = answerDoc.meta.font;
  if (answerDoc.meta?.bodyPt) { detectedPt = answerDoc.meta.bodyPt; el.size.value = 'auto'; updateSizeHint(); }
  paintAnswer(answerDoc, { silent: true });
  showTab('preview');
  log(`${T('solver.hist.restored')}: ${entry.title}${entry.figuresDropped ? T('slog.figuresDropped') : ''}`, 'ok');
});

el.histClear.addEventListener('click', () => {
  if (!loadHistory().length) return;
  if (!confirm(T('solver.hist.confirmClear', '确定清空全部解答历史？'))) return;
  clearHistory();
  renderHistoryList();
});

// ---------------- 主流程 ----------------

function setBusy(v) {
  busy = v;
  el.runBtn.disabled = v || !file;
  el.runBtn.textContent = T(v ? 'solver.running' : 'solver.run', v ? '…' : 'Solve');
  el.drop.style.pointerEvents = v ? 'none' : '';
  el.drop.style.opacity = v ? '.55' : '';
}

async function run() {
  if (!file || busy) return;
  const hasKey = (() => {
    try {
      return ['mdd.local.apikey', 'mdd.local.dskey', 'mdd.local.zpkey', 'mdd.local.apexkey']
        .some((k) => (localStorage.getItem(k) || '').trim());
    } catch { return true; }
  })();
  if (!hasKey) { showErr(T('solver.needKey', '请先填写 API Key')); return; }

  clearErr();
  setBusy(true);
  el.logView.innerHTML = '';
  el.ansDl.hidden = true;
  el.pdfHint.hidden = true;
  answerDoc = null;
  showTab('log');

  try {
    log(`${file.name}（${(file.size / 1048576).toFixed(2)}MB）`);
    const extracted = await extract(file, log);
    for (const w of extracted.warnings || []) log(w, 'warn');

    detectedPt = extracted.bodyPt || null;
    updateSizeHint();
    if (el.size.value === 'auto') {
      log(detectedPt ? TF('slog.sizeDetected', { pt: detectedPt }) : T('solver.size.unknown'),
        detectedPt ? 'ok' : 'warn');
    }

    log(extracted.kind === 'docx'
      ? TF('slog.extractDocx', { chars: extracted.text.length, eq: extracted.equationCount, img: extracted.images.length })
      : TF('slog.extractPdf', { pages: extracted.pageCount, chars: extracted.text.length, img: extracted.images.length }), 'ok');

    answerDoc = await solve(extracted, {
      subject: el.subject.value,
      font: el.font.value,
      bodyPt: resolveBodyPt(),
      sourceName: file.name,
      autoDraw: el.autoDraw.checked,
      tier: el.tier.value,
      concurrency: 2,
    }, log);

    log(T('slog.layout'));
    // 必须先把预览显示出来再测量：隐藏容器里 clientWidth 恒为 0，
    // 量不出溢出却会报告"一切正常"——假的通过比失败更糟
    showTab('preview');
    await (document.fonts?.ready ?? Promise.resolve());
    paintAnswer(answerDoc);

    const { total } = saveToHistory(answerDoc);
    renderHistoryList();
    log(`${T('solver.hist.saved', '已存入历史记录')}（${total}/${HISTORY_CAP}）`, 'ok');
    log(T('slog.done'), 'ok');
  } catch (e) {
    log(e.message, 'error');
    showErr(e.message);
    showTab('log');
  } finally {
    setBusy(false);
  }
}

// ---------------- 导出 ----------------

async function downloadDocx() {
  if (!answerDoc) return;
  el.dlDocx.disabled = true;
  try {
    answerDoc.meta.bodyPt = resolveBodyPt();
    answerDoc.meta.font = el.font.value;
    const { blob, stats } = await renderDocx(answerDoc);
    log(TF('slog.docxOk', { ok: stats.ommlOk })
      + (stats.ommlFail ? TF('slog.docxKept', { n: stats.ommlFail }) : ''), 'ok');
    const name = (answerDoc.meta.title || 'answer').replace(/[\\/:*?"<>|]/g, '_') + '.docx';
    const downloads = await window.claude?.use?.('downloads');
    if (downloads) await downloads.save({ data: blob, filename: name });
    else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 20000);
    }
  } catch (e) {
    log(TF('slog.docxFail', { msg: e.message }), 'error');
    showErr(`Word: ${e.message}`);
  } finally {
    el.dlDocx.disabled = false;
  }
}

// ---------------- 事件绑定 ----------------

el.drop.addEventListener('click', () => el.fileInput.click());
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
});
el.fileInput.addEventListener('change', (e) => { if (e.target.files[0]) pickFile(e.target.files[0]); });
['dragover', 'dragenter'].forEach((ev) => el.drop.addEventListener(ev, (e) => {
  e.preventDefault(); el.drop.classList.add('hot');
}));
['dragleave', 'dragend', 'drop'].forEach((ev) => el.drop.addEventListener(ev, () => el.drop.classList.remove('hot')));
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
});
el.clearFile.addEventListener('click', () => {
  file = null; el.fileInput.value = ''; el.fileChip.hidden = true; el.runBtn.disabled = true; clearErr();
});
el.runBtn.addEventListener('click', run);
el.subject.addEventListener('change', updateSubjectHint);

// 字体与字号改了立刻反映在预览上，并重新测量溢出（字号变了宽度就变了）
for (const control of [el.font, el.size]) {
  control.addEventListener('change', () => {
    updateSizeHint();
    if (!answerDoc) return;
    answerDoc.meta.font = el.font.value;
    answerDoc.meta.bodyPt = resolveBodyPt();
    applySheetStyle();
    if (el.autoLayout.checked) fitEquations(el.sheet);
    scalePreview();
    el.ansStat.textContent = el.ansStat.textContent.replace(/\d+(\.\d+)?pt/, `${resolveBodyPt()}pt`);
  });
}
el.autoLayout.addEventListener('change', () => {
  if (!answerDoc) return;
  paintAnswer(answerDoc, { silent: true });
});
el.tabPreview.addEventListener('click', () => showTab('preview'));
el.tabLog.addEventListener('click', () => showTab('log'));
el.dlDocx.addEventListener('click', downloadDocx);
el.dlPdf.addEventListener('click', () => { if (answerDoc) window.print(); });

fillSelects();
initLangSel();
renderHistoryList();
if (typeof applyI18n === 'function') applyI18n();
el.logView.innerHTML = `<p>${T('solver.logIdle', '// idle')}</p>`;
