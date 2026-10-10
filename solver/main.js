// 作业解答页的交互层。
//
// Key、模型、厂商全部交给站内共用的 local-bridge.js —— 和图纸解译台用的是
// 同一份 localStorage，所以用户在任一页填过 Key，另一页直接就能用。
// 本文件只负责：收集参数 → 抽取 → 求解 → 渲染 → 导出。

import { SUBJECTS, FONTS, DEFAULT_FONT, UPLOAD } from './config.js';
import { extract } from './extract.js';
import { solve } from './solve.js';
import { renderAnswerHtml, fitEquations } from './render-html.js';
import { renderDocx } from './render-docx.js';

const $ = (id) => document.getElementById(id);
const T = (k) => (typeof t === 'function' ? t(k) : k);

const el = {
  subject: $('subjectSel'), subjectHint: $('subjectHint'), font: $('fontSel'), tier: $('tierSel'),
  autoLayout: $('autoLayout'), autoDraw: $('autoDraw'),
  drop: $('drop'), fileInput: $('fileInput'), fileChip: $('fileChip'), fileName: $('fileName'),
  clearFile: $('clearFile'), formErr: $('formErr'), runBtn: $('runBtn'),
  tabPreview: $('tabPreview'), tabLog: $('tabLog'),
  emptyHint: $('emptyHint'), previewWrap: $('previewWrap'), sheetScroll: $('sheetScroll'),
  sheetScale: $('sheetScale'), sheet: $('ansSheet'), logView: $('logView'),
  ansDl: $('ansDl'), ansStat: $('ansStat'), dlDocx: $('dlDocx'), dlPdf: $('dlPdf'), pdfHint: $('pdfHint'),
  langSel: $('langSel'),
};

let file = null;
let answerDoc = null;
let busy = false;

// ---------------- 下拉框 ----------------

const TIERS = ['quick', 'default', 'complex'];

function fillSelects() {
  const subj = el.subject.value || 'mech_eng';
  el.subject.innerHTML = Object.entries(SUBJECTS)
    .map(([id, s]) => `<option value="${id}">${s.name}</option>`).join('');
  el.subject.value = SUBJECTS[subj] ? subj : 'mech_eng';

  const f = el.font.value || DEFAULT_FONT;
  el.font.innerHTML = Object.entries(FONTS)
    .map(([id, v]) => `<option value="${id}">${v.label}</option>`).join('');
  el.font.value = FONTS[f] ? f : DEFAULT_FONT;

  const tier = el.tier.value || 'default';
  el.tier.innerHTML = TIERS.map((k) => `<option value="${k}">${T('solver.tier.' + k)}</option>`).join('');
  el.tier.value = tier;

  updateSubjectHint();
}

function updateSubjectHint() {
  const s = SUBJECTS[el.subject.value];
  if (!s) return;
  const bits = [];
  if (s.modules.length) bits.push(s.modules.join('、'));
  bits.push(s.diagrams ? '支持自动作图' : '一般不需作图');
  el.subjectHint.textContent = bits.join(' · ');
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
  if (!UPLOAD.allowedExt.includes(ext)) {
    file = null; el.fileChip.hidden = true; el.runBtn.disabled = true;
    return showErr(`不支持的文件类型 ${ext || '(无扩展名)'}，仅支持 ${UPLOAD.allowedExt.join(' / ')}`);
  }
  if (f.size > UPLOAD.maxBytes) {
    file = null; el.fileChip.hidden = true; el.runBtn.disabled = true;
    return showErr(`文件 ${(f.size / 1048576).toFixed(1)}MB 超过 ${UPLOAD.maxBytes / 1048576}MB 上限`);
  }
  if (!f.size) {
    file = null; el.runBtn.disabled = true;
    return showErr('文件为空');
  }
  file = f;
  el.fileName.textContent = `${name}（${(f.size / 1048576).toFixed(2)}MB）`;
  el.fileChip.hidden = false;
  el.runBtn.disabled = busy;
}

// ---------------- 日志与标签页 ----------------

function log(msg, level = 'info') {
  const p = document.createElement('p');
  p.className = level;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  p.textContent = `[${time}] ${msg}`;
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
  const avail = el.sheetScroll.clientWidth - 28;
  const k = Math.min(1, avail / natural);
  el.sheetScale.style.transform = `scale(${k})`;
  el.sheetScale.style.width = `${natural * k}px`;
  el.sheetScale.style.height = `${el.sheet.offsetHeight * k}px`;
}

window.addEventListener('resize', scalePreview);

// ---------------- 主流程 ----------------

function setBusy(v) {
  busy = v;
  el.runBtn.disabled = v || !file;
  el.runBtn.textContent = T(v ? 'solver.running' : 'solver.run');
  el.drop.style.pointerEvents = v ? 'none' : '';
  el.drop.style.opacity = v ? '.55' : '';
}

async function run() {
  if (!file || busy) return;
  // Key 由共用桥接层管理，这里只做个友好提示
  const hasKey = (() => {
    try {
      return ['mdd.local.apikey', 'mdd.local.dskey', 'mdd.local.zpkey', 'mdd.local.apexkey']
        .some((k) => (localStorage.getItem(k) || '').trim());
    } catch { return true; }
  })();
  if (!hasKey) { showErr(T('solver.needKey')); return; }

  clearErr();
  setBusy(true);
  el.logView.innerHTML = '';
  el.ansDl.hidden = true;
  el.pdfHint.hidden = true;
  answerDoc = null;
  showTab('log');

  try {
    log(`读取 ${file.name}（${(file.size / 1048576).toFixed(2)}MB）`);
    const extracted = await extract(file, log);
    for (const w of extracted.warnings || []) log(w, 'warn');
    log(extracted.kind === 'docx'
      ? `抽取完成：${extracted.text.length} 字，${extracted.equationCount} 个 Word 公式，${extracted.images.length} 张图`
      : `抽取完成：${extracted.pageCount} 页，${extracted.text.length} 字，${extracted.images.length} 页送入识别`, 'ok');

    answerDoc = await solve(extracted, {
      subject: el.subject.value,
      font: el.font.value,
      sourceName: file.name,
      autoDraw: el.autoDraw.checked,
      tier: el.tier.value,
      concurrency: 2,
    }, log);

    log('正在排版…');
    const { html, stats } = renderAnswerHtml(answerDoc);
    el.sheet.className = 'ans-sheet ' + ({ 'font-sans-sc': 'f-sans', 'font-serif-sc': 'f-serif', 'font-mono': 'f-mono' }[el.font.value] || 'f-sans');
    el.sheet.innerHTML = html;

    // 必须先把预览显示出来再测量：隐藏容器里 clientWidth 恒为 0，
    // 量不出溢出却会报告"一切正常"——假的通过比失败更糟
    showTab('preview');
    await (document.fonts?.ready ?? Promise.resolve());

    const adjusted = el.autoLayout.checked ? fitEquations(el.sheet) : [];
    const scaled = adjusted.filter((a) => a.scale !== 'wrap').length;
    const wrapped = adjusted.length - scaled;
    log(adjusted.length
      ? `版面溢出检查：${scaled} 个公式已缩放，${wrapped} 个改为断行`
      : '版面溢出检查：全部公式宽度正常', adjusted.length ? 'warn' : 'info');
    if (stats.mathFail) log(`${stats.mathFail} 个公式无法渲染，已在答卷中保留 LaTeX 源码`, 'warn');
    if (stats.svgRejected) log(`${stats.svgRejected} 张图形格式不合规，已略过`, 'warn');

    el.ansStat.textContent = [
      `${answerDoc.questions.length} 题`,
      stats.figures ? `${stats.figures} 图` : null,
      scaled ? `${scaled} 公式已缩放` : null,
      answerDoc.failedCount ? `${answerDoc.failedCount} 题失败` : null,
    ].filter(Boolean).join(' · ');

    el.ansDl.hidden = false;
    el.pdfHint.hidden = false;
    scalePreview();
    log('完成，可以导出。', 'ok');
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
    const { blob, stats } = await renderDocx(answerDoc);
    log(`Word 已生成：${stats.ommlOk} 个原生公式对象（可在 Word 里直接编辑）${stats.ommlFail ? `，${stats.ommlFail} 个保留为 LaTeX 源码` : ''}`, 'ok');
    const name = (answerDoc.meta.title || '答卷').replace(/[\\/:*?"<>|]/g, '_') + '.docx';
    const downloads = await window.claude?.use?.('downloads');
    if (downloads) await downloads.save({ data: blob, filename: name });
    else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 20000);
    }
  } catch (e) {
    log(`Word 生成失败：${e.message}`, 'error');
    showErr(`Word 生成失败：${e.message}`);
  } finally {
    el.dlDocx.disabled = false;
  }
}

function printPdf() {
  if (!answerDoc) return;
  // 打印样式会把除答卷外的一切隐藏，页边距交给 @page
  window.print();
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
el.font.addEventListener('change', () => {
  if (!answerDoc) return;
  el.sheet.className = 'ans-sheet ' + ({ 'font-sans-sc': 'f-sans', 'font-serif-sc': 'f-serif', 'font-mono': 'f-mono' }[el.font.value] || 'f-sans');
  answerDoc.meta.font = el.font.value;
  if (el.autoLayout.checked) fitEquations(el.sheet);
  scalePreview();
});
el.tabPreview.addEventListener('click', () => showTab('preview'));
el.tabLog.addEventListener('click', () => showTab('log'));
el.dlDocx.addEventListener('click', downloadDocx);
el.dlPdf.addEventListener('click', printPdf);

fillSelects();
initLangSel();
if (typeof applyI18n === 'function') applyI18n();
el.logView.innerHTML = `<p>${T('solver.logIdle')}</p>`;
