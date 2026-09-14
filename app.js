/* 机械图纸解译台 — 前端逻辑
   能力: claude.use('sample') 做图像/文本分析, claude.use('downloads') 导出 PDF */
'use strict';

/* ============ 基础工具 ============ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const txt = (v) => (v == null ? '' : String(v)).trim();
const has = (v) => Array.isArray(v) ? v.length > 0 : txt(v).length > 0;
const arr = (v) => Array.isArray(v) ? v.filter(x => x != null && x !== '') : [];
const bytesOf = (s) => new TextEncoder().encode(s).length;
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';
const nowStamp = () => {
  const d = new Date(), p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

const scriptCache = new Map();
function loadScript(url) {
  if (scriptCache.has(url)) return scriptCache.get(url);
  const p = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url; s.async = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error(t('err.loadScript') + url));
    document.head.appendChild(s);
  });
  scriptCache.set(url, p); return p;
}
const CDN = {
  html2canvas: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  pdfworker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
};

/* ============ 全局状态 ============ */
const S = {
  sample: null, downloads: null, limits: null,
  src: null,          // 源文件 {kind:'image'|'code', ...}
  report: null,       // {kind, data, mat, qa:[], src:{}, at}
  demo: true,
  tier: 'complex',
  mode: 'eng',        // 'teach' 教学解读 | 'eng' 工程分析
  imagesOK: null,     // null 未知 / true 图片通道可用 / false 不可用
  docClass: 'auto',   // 'auto' | 'drawing' | 'chart'
  abort: null,
  busy: false,
};

/* ============ 能力接入 ============ */
async function boot() {
  bindUI();
  initLangSwitch();
  applyI18n();
  renderHistory();
  showExample();

  const c = window.claude;
  const cap = $('#capState');
  if (!c || typeof c.use !== 'function') {
    cap.className = 'cap off'; cap.innerHTML = '<i></i>' + t('cap.offline');
    $('#runTeach').title = $('#runEng').title = '请在 claude.ai 网页中打开本页面以启用解析';
    return;
  }
  try { S.sample = await c.use('sample'); } catch (e) { S.sample = null; }
  try { S.downloads = await c.use('downloads'); } catch (e) { S.downloads = null; }
  if (S.sample) {
    let probed = null;
    try { probed = await S.sample.limits(); } catch (e) { probed = null; }
    await ensureLimits();
    cap.className = 'cap on';
    const real = probed && probed.images;
    cap.innerHTML = '<i></i>' + t(real ? 'cap.visionReady' : 'cap.textOnly');
    cap.title = real
      ? '单次最多 ' + probed.images.maxCount + ' 张图片，单张上限 ' + fmtSize(probed.images.maxInputBytes) +
        '，提示词上限 ' + (probed.maxPromptBytes || 65536) + ' 字节'
      : '本环境没有返回图片能力信息，解析时仍会尝试发送图片；若被拒绝会自动改走文字通道。';
    const mt = real && probed.images.mediaTypes;
    if (mt) $('#file').setAttribute('accept', mt.join(',') + ',.pdf,.dxf,.txt,.nc,.gcode,.tap,.cnc,.iso,.mpf,.spf,.prg,.src,.mod,.st,.scl,.awl,.il,.lad,.ls,.bas,.for,.asm,.pmc,.plc,.h,.csv,.log,.dat');
  } else {
    cap.className = 'cap off'; cap.innerHTML = '<i></i>' + t('cap.unavailable');
  }
  if (!S.downloads) { $('#pdfBtn').hidden = true; }
  syncRun();
}

function initLangSwitch() {
  const sel = $('#langSel');
  if (!sel) return;
  sel.innerHTML = LANGS.map(l => '<option value="' + l + '">' + LANG_NAMES[l] + '</option>').join('');
  sel.value = getLang();
  sel.addEventListener('change', async () => {
    const target = sel.value;
    setLang(target);
    applyI18n();
    if (typeof window.__refreshBridgeI18n === 'function') window.__refreshBridgeI18n();
    renderHistory();
    renderPresets();
    if (S.report) {
      if (S.demo) showExample();
      else if (S.report.lang !== target) await translateReportContent(target);
      else renderReport();
    }
    syncRun();
  });
}

function syncRun() {
  const ready = !!(S.src && S.sample) && !S.busy;
  $('#runTeach').disabled = !ready;
  $('#runEng').disabled = !ready;
  const canAsk = !!(S.report && !S.demo && S.sample) && !S.busy;
  $('#askBtn').disabled = !canAsk;
  const ta = $('#askInput');
  ta.disabled = !canAsk;
  ta.placeholder = canAsk ? t('ask.placeholder') : (S.sample ? t('ask.needSource') : t('ask.needClaude'));
}

/* ============ 文件读取 ============ */
const CODE_EXT = /\.(txt|nc|gcode|g|tap|cnc|iso|mpf|spf|prg|src|mod|st|scl|awl|il|lad|ls|bas|for|f|asm|pmc|plc|h|cpp|c|pas|csv|log|dat|min|eia|sub|mac|var|json|xml|ini|cfg)$/i;

async function intake(file) {
  if (!file) return;
  const name = file.name || t('file.unnamed');
  const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  try {
    if (ext === '.pdf' || file.type === 'application/pdf') return await intakePDF(file);
    if (ext === '.dxf') return await intakeDXF(file);
    if (ext === '.docx') return await intakeDocx(file);
    if (ext === '.doc') { toast(t('err.oldDoc'), 6000); return; }
    if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?|svg)$/i.test(name)) return await intakeImage(file);
    if (CODE_EXT.test(name) || file.type.startsWith('text/')) return await intakeText(file);
    if (/\.(dwg|sldprt|sldasm|step|stp|iges|igs|stl|x_t|catpart|prt|ipt|3dm)$/i.test(name)) {
      toast(t('toast.unsupportedModel') + ext + t('toast.unsupportedModelTail'), 6000);
      return;
    }
    // 兜底：按文本嗅探
    const head = await file.slice(0, 4096).text();
    const printable = (head.match(/[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFD]/g) || []).length / Math.max(1, head.length);
    if (printable > 0.9) return await intakeText(file);
    toast(t('toast.unknownFileType'), 5000);
  } catch (err) {
    console.error(err);
    toast(t('toast.readFail') + (err && err.message ? err.message : t('toast.unknownError')), 5000);
  }
}

/* ============ DOCX：解析（zip 结构，浏览器原生解压，不依赖第三方库） ============ */
async function unzipEntries(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const entries = new Map();
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const sig = view.getUint32(pos, true);
    if (sig !== 0x04034b50) break; // 本地文件头区结束（后面是中央目录），提前退出
    const method = view.getUint16(pos + 8, true);
    const compSize = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const nameStart = pos + 30;
    const name = new TextDecoder('utf-8').decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    let data = null;
    if (method === 0) { data = raw; }
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error(t('err.docxUnsupported'));
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } // 其他压缩方式（很少见）跳过，不影响其余条目的解析
    if (data) entries.set(name, data);
    pos = dataStart + compSize;
    if (compSize === 0 && nameLen === 0) break; // 防御性退出，避免异常文件死循环
  }
  return entries;
}

function docxXmlToText(xmlBytes) {
  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  let out = xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return out.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
}

async function intakeDocx(file) {
  toast(t('toast.parsingDocx'));
  const buf = await file.arrayBuffer();
  const entries = await unzipEntries(buf);
  const docXml = entries.get('word/document.xml');
  const text = docXml ? docxXmlToText(docXml) : '';
  const mediaNames = Array.from(entries.keys()).filter(n => /^word\/media\//i.test(n) && /\.(png|jpe?g|gif|bmp)$/i.test(n));
  // 挑体积最大的一张图当主视觉入口——文档里通常这就是最重要的插图/数据图
  let best = null, bestSize = 0;
  for (const n of mediaNames) { const d = entries.get(n); if (d.length > bestSize) { best = n; bestSize = d.length; } }

  if (best) {
    const mime = /\.png$/i.test(best) ? 'image/png' : /\.gif$/i.test(best) ? 'image/gif' : /\.bmp$/i.test(best) ? 'image/bmp' : 'image/jpeg';
    const blob = new Blob([entries.get(best)], { type: mime });
    const bmp = await createImageBitmap(blob).catch(() => null);
    if (!bmp) throw new Error(t('err.imageDecode'));
    S.src = {
      kind: 'image', name: file.name, size: file.size, bitmap: bmp, w: bmp.width, h: bmp.height, pages: null,
      vector: sliceBytes(text, 14000),
      note: tf('note.docx', { n: mediaNames.length, chars: text.length }),
    };
    paintSource();
  } else if (text) {
    S.src = { kind: 'code', name: file.name, size: file.size, text: text, lines: text.split(/\r\n|\r|\n/).length, truncated: false, isDocument: true };
    paintSource();
  } else {
    throw new Error(t('err.docxEmpty'));
  }
}

// 部分 SVG（尤其是 CAD/CorelDRAW 导出、宽高用 mm/pt 等物理单位标注的）
// createImageBitmap() 直接解码会失败，退路是走 <img> + canvas 走一遍布局再栅格化。
async function rasterizeSVG(file) {
  const raw = await file.text();
  let w = 0, h = 0;
  const wm = raw.match(/<svg[^>]*\swidth="([\d.]+)(px)?"/i);
  const hm = raw.match(/<svg[^>]*\sheight="([\d.]+)(px)?"/i);
  if (wm && hm) { w = parseFloat(wm[1]); h = parseFloat(hm[1]); }
  if (!w || !h) {
    const vb = raw.match(/viewBox="\s*[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)\s*"/i);
    if (vb) { w = parseFloat(vb[1]); h = parseFloat(vb[2]); }
  }
  if (!w || !h) { w = 1200; h = 900; }
  const maxSide = 2000;
  const scale = Math.min(1, maxSide / Math.max(w, h)) || 1;
  w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'sync';
    const loaded = await new Promise((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    if (!loaded) return null;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return await createImageBitmap(cv).catch(() => null);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function intakeImage(file) {
  let bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp && (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || ''))) {
    bmp = await rasterizeSVG(file).catch(() => null);
  }
  if (!bmp) throw new Error(t('err.imageDecode'));
  S.src = {
    kind: 'image', name: file.name, size: file.size, bitmap: bmp,
    w: bmp.width, h: bmp.height, pages: null, note: '',
  };
  paintSource();
}

async function intakePDF(file) {
  toast(t('toast.parsingPDF'));
  await loadScript(CDN.pdfjs);
  await loadScript(CDN.pdfworker).catch(() => {});
  const lib = window.pdfjsLib;
  if (!lib) throw new Error(t('err.pdfLib'));
  try { lib.GlobalWorkerOptions.workerSrc = CDN.pdfworker; } catch (e) {}
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const total = doc.numPages, n = Math.min(total, 8);
  const pages = [], texts = [];
  for (let i = 1; i <= n; i++) {
    const pg = await doc.getPage(i);
    const base = pg.getViewport({ scale: 1 });
    const scale = Math.min(4, Math.max(1, 1800 / Math.max(base.width, base.height)));
    const vp = pg.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    pages.push(cv);
    try {
      const tc = await pg.getTextContent();
      const t = tc.items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (t) texts.push('【第' + i + '页】' + t);
    } catch (e) {}
  }
  const bmp = await createImageBitmap(pages[0]);
  S.src = {
    kind: 'image', name: file.name, size: file.size, bitmap: bmp,
    w: bmp.width, h: bmp.height, pages, pageIndex: 0, totalPages: total,
    vector: texts.join('\n').slice(0, 12000),
    note: 'PDF 第 1 页' + (total > 1 ? '，共 ' + total + ' 页' : ''),
  };
  paintSource();
}

async function intakeText(file) {
  let raw = await file.arrayBuffer();
  let text = decodeSmart(raw);
  const truncated = text.length > 260000;
  if (truncated) text = text.slice(0, 260000);
  S.src = {
    kind: 'code', name: file.name, size: file.size, text,
    lines: text.split(/\r\n|\r|\n/).length, truncated,
  };
  paintSource();
}

function decodeSmart(buf) {
  const u8 = new Uint8Array(buf);
  let t = new TextDecoder('utf-8').decode(u8);
  const bad = (t.match(/\uFFFD/g) || []).length;
  if (bad > 4 && bad / Math.max(1, t.length) > 0.002) {
    for (const enc of ['gbk', 'big5', 'shift_jis', 'windows-1252']) {
      try {
        const alt = new TextDecoder(enc).decode(u8);
        const altBad = (alt.match(/\uFFFD/g) || []).length;
        if (altBad < bad) { t = alt; break; }
      } catch (e) {}
    }
  }
  return t.replace(/^﻿/, '');
}

/* ============ DXF：解析 + 渲染 ============ */
async function intakeDXF(file) {
  toast(t('toast.parsingDXF'));
  const text = decodeSmart(await file.arrayBuffer());
  const { prims, texts, layers, header } = dxfParse(text);
  if (!prims.length && !texts.length) throw new Error(t('err.dxfEmpty'));
  const cv = dxfRender(prims, texts);
  const bmp = await createImageBitmap(cv);
  const ctxLines = [];
  if (header.length) ctxLines.push('Units/vars: ' + header.join('; '));
  if (layers.length) ctxLines.push('Layers: ' + layers.slice(0, 40).join(', '));
  if (texts.length) ctxLines.push('图面文字（按坐标顺序，来自 DXF 文本实体，比 OCR 可靠）：\n' +
    texts.slice(0, 400).map(t => t.s).join(' | '));
  S.src = {
    kind: 'image', name: file.name, size: file.size, bitmap: bmp, w: cv.width, h: cv.height,
    vector: ctxLines.join('\n').slice(0, 14000),
    note: 'DXF 矢量重绘 · ' + prims.length + ' 图元 / ' + texts.length + ' 文字',
  };
  paintSource();
}

function dxfParse(text) {
  const L = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i < L.length - 1;) {
    const c = parseInt(L[i].trim(), 10);
    if (Number.isNaN(c)) { i++; continue; }
    pairs.push([c, L[i + 1]]); i += 2;
    if (pairs.length > 1200000) break;
  }
  const blocks = {}, ents = [], layers = new Set(), header = [];
  let sec = null, expectName = false, cur = null, list = null, blk = null, hVar = null;
  for (const [c, rawV] of pairs) {
    const v = (rawV == null ? '' : rawV).trim();
    if (c === 0) {
      if (cur && list && cur.type !== '__BLK__') list.push(cur);
      cur = null;
      if (v === 'SECTION') { expectName = true; sec = null; continue; }
      if (v === 'ENDSEC') { sec = null; blk = null; list = null; continue; }
      if (v === 'EOF') break;
      if (sec === 'BLOCKS') {
        if (v === 'BLOCK') { blk = { name: '', base: [0, 0], ents: [] }; list = blk.ents; cur = { type: '__BLK__', g: {} }; continue; }
        if (v === 'ENDBLK') { if (blk && blk.name) blocks[blk.name.toUpperCase()] = blk; blk = null; list = null; continue; }
        if (blk) { cur = { type: v, g: {} }; list = blk.ents; }
        continue;
      }
      if (sec === 'ENTITIES') { cur = { type: v, g: {} }; list = ents; }
      continue;
    }
    if (expectName && c === 2) { sec = v.toUpperCase(); expectName = false; continue; }
    if (sec === 'HEADER') {
      if (c === 9) { hVar = v; continue; }
      if (hVar === '$INSUNITS' && c === 70) { header.push('INSUNITS=' + v); hVar = null; }
      if (hVar === '$MEASUREMENT' && c === 70) { header.push('MEASUREMENT=' + v + (v === '1' ? '(公制)' : '(英制)')); hVar = null; }
      continue;
    }
    if (!cur) continue;
    if (cur.type === '__BLK__') {
      if (c === 2 && blk) blk.name = v;
      if (c === 10 && blk) blk.base[0] = parseFloat(v) || 0;
      if (c === 20 && blk) blk.base[1] = parseFloat(v) || 0;
      continue;
    }
    if (c === 8) layers.add(v);
    (cur.g[c] = cur.g[c] || []).push(v);
  }
  if (cur && list && cur.type !== '__BLK__') list.push(cur);

  const prims = [], texts = [];
  dxfWalk(ents, blocks, [1, 0, 0, 1, 0, 0], prims, texts, 0);
  return { prims, texts, layers: Array.from(layers), header };
}

const mMul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const mApp = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function dxfClean(s) {
  return String(s || '')
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;\\]*;/g, '')
    .replace(/[{}]/g, '').replace(/%%[dD]/g, '°').replace(/%%[cC]/g, 'Ø').replace(/%%[pP]/g, '±')
    .replace(/\s+/g, ' ').trim();
}

function dxfWalk(ents, blocks, m, prims, texts, depth) {
  const num = (e, c, d) => { const a = e.g[c]; return a && a.length ? (parseFloat(a[0]) || 0) : (d === undefined ? 0 : d); };
  const push = (pts, closed) => { if (pts.length > 1 && prims.length < 90000) prims.push({ pts, closed: !!closed }); };
  const sampleArc = (cx, cy, r, a0, a1, seg) => {
    const out = []; const n = seg || Math.max(10, Math.min(72, Math.ceil(Math.abs(a1 - a0) / 0.12)));
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; out.push(mApp(m, cx + r * Math.cos(a), cy + r * Math.sin(a))); }
    return out;
  };
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i], T = e.type;
    try {
      if (T === 'LINE') push([mApp(m, num(e, 10), num(e, 20)), mApp(m, num(e, 11), num(e, 21))]);
      else if (T === 'CIRCLE') push(sampleArc(num(e, 10), num(e, 20), num(e, 40), 0, Math.PI * 2, 64), true);
      else if (T === 'ARC') {
        let a0 = num(e, 50) * Math.PI / 180, a1 = num(e, 51) * Math.PI / 180;
        if (a1 <= a0) a1 += Math.PI * 2;
        push(sampleArc(num(e, 10), num(e, 20), num(e, 40), a0, a1));
      } else if (T === 'ELLIPSE') {
        const cx = num(e, 10), cy = num(e, 20), mx = num(e, 11), my = num(e, 21), ratio = num(e, 40, 1);
        const a0 = num(e, 41, 0), a1 = num(e, 42, Math.PI * 2);
        const R = Math.hypot(mx, my), rot = Math.atan2(my, mx), out = [];
        for (let k = 0; k <= 64; k++) {
          const t = a0 + (a1 - a0) * k / 64, x = R * Math.cos(t), y = R * ratio * Math.sin(t);
          out.push(mApp(m, cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)));
        }
        push(out);
      } else if (T === 'LWPOLYLINE' || T === 'SPLINE') {
        const xs = e.g[10] || [], ys = e.g[20] || [], out = [];
        for (let k = 0; k < Math.min(xs.length, ys.length); k++) out.push(mApp(m, parseFloat(xs[k]) || 0, parseFloat(ys[k]) || 0));
        const closed = T === 'LWPOLYLINE' && ((parseInt((e.g[70] || ['0'])[0], 10) || 0) & 1);
        push(out, closed);
      } else if (T === 'POLYLINE') {
        const out = []; let j = i + 1;
        for (; j < ents.length && ents[j].type === 'VERTEX'; j++) out.push(mApp(m, num(ents[j], 10), num(ents[j], 20)));
        if (j < ents.length && ents[j].type === 'SEQEND') j++;
        const closed = (parseInt((e.g[70] || ['0'])[0], 10) || 0) & 1;
        push(out, closed); i = j - 1;
      } else if (T === 'SOLID' || T === '3DFACE') {
        const p = [[10, 20], [11, 21], [13, 23], [12, 22]].map(([a, b]) => mApp(m, num(e, a), num(e, b)));
        push(p, true);
      } else if (T === 'POINT') {
        const p = mApp(m, num(e, 10), num(e, 20));
        push([[p[0] - 2, p[1]], [p[0] + 2, p[1]]]); push([[p[0], p[1] - 2], [p[0], p[1] + 2]]);
      } else if (T === 'TEXT' || T === 'MTEXT' || T === 'ATTRIB') {
        const s = dxfClean(((e.g[1] || []).join('') + (e.g[3] || []).join('')));
        if (s) {
          const x = num(e, 11) || num(e, 10), y = num(e, 21) || num(e, 20);
          const p = mApp(m, x, y);
          const scl = Math.hypot(m[0], m[1]) || 1;
          texts.push({ s, x: p[0], y: p[1], h: (num(e, 40, 2.5) || 2.5) * scl, rot: num(e, 50) });
        }
      } else if (T === 'DIMENSION') {
        const s = dxfClean((e.g[1] || []).join(''));
        if (s && s !== '<>') { const p = mApp(m, num(e, 11), num(e, 21)); texts.push({ s, x: p[0], y: p[1], h: 2.5, rot: 0 }); }
      } else if (T === 'INSERT' && depth < 4) {
        const bn = txt((e.g[2] || [''])[0]).toUpperCase(), b = blocks[bn];
        if (b) {
          const sx = num(e, 41, 1) || 1, sy = num(e, 42, 1) || 1, rot = num(e, 50) * Math.PI / 180;
          const cos = Math.cos(rot), sin = Math.sin(rot);
          const local = mMul([cos, sin, -sin, cos, num(e, 10), num(e, 20)], [sx, 0, 0, sy, -b.base[0] * sx, -b.base[1] * sy]);
          dxfWalk(b.ents, blocks, mMul(m, local), prims, texts, depth + 1);
        }
      }
    } catch (err) { /* 单个图元失败不影响整图 */ }
  }
}

function dxfRender(prims, texts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of prims) for (const [x, y] of p.pts) {
    if (!isFinite(x) || !isFinite(y)) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  for (const t of texts) { if (t.x < x0) x0 = t.x; if (t.x > x1) x1 = t.x; if (t.y < y0) y0 = t.y; if (t.y > y1) y1 = t.y; }
  if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 100; y1 = 100; }
  const w = Math.max(1e-6, x1 - x0), h = Math.max(1e-6, y1 - y0);
  const MAX = 2000, pad = 24;
  const k = Math.min((MAX - pad * 2) / w, (MAX - pad * 2) / h);
  const cv = document.createElement('canvas');
  cv.width = Math.max(320, Math.round(w * k + pad * 2));
  cv.height = Math.max(240, Math.round(h * k + pad * 2));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
  const TX = (x) => pad + (x - x0) * k, TY = (y) => cv.height - pad - (y - y0) * k;
  ctx.strokeStyle = '#101010'; ctx.lineWidth = 1; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  for (const p of prims) {
    const pts = p.pts;
    ctx.moveTo(TX(pts[0][0]), TY(pts[0][1]));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(TX(pts[i][0]), TY(pts[i][1]));
    if (p.closed) ctx.closePath();
  }
  ctx.stroke();
  ctx.fillStyle = '#101010'; ctx.textBaseline = 'alphabetic';
  for (const t of texts) {
    const fs = Math.max(7, Math.min(64, t.h * k));
    ctx.save(); ctx.translate(TX(t.x), TY(t.y));
    if (t.rot) ctx.rotate(-t.rot * Math.PI / 180);
    ctx.font = fs + 'px "Noto Sans SC", sans-serif';
    ctx.fillText(t.s.slice(0, 120), 0, 0);
    ctx.restore();
  }
  return cv;
}

/* ============ 源文件面板 ============ */
function paintSource() {
  const box = $('#srcBox'), meta = $('#srcMeta'), s = S.src;
  if (!s) return;
  $('#srcKind').textContent = TX(s.kind === 'code' ? '代码 / 文本' : '图纸');
  box.innerHTML = '';
  if (s.kind === 'image') {
    const cv = document.createElement('canvas');
    const k = Math.min(1, 520 / Math.max(s.w, s.h));
    cv.width = Math.round(s.w * k); cv.height = Math.round(s.h * k);
    cv.style.maxHeight = '220px'; cv.style.maxWidth = '100%'; cv.style.width = 'auto'; cv.style.height = 'auto';
    cv.getContext('2d').drawImage(s.bitmap, 0, 0, cv.width, cv.height);
    box.appendChild(cv);
  } else {
    const pre = document.createElement('pre');
    pre.textContent = s.text.split(/\r\n|\r|\n/).slice(0, 14).join('\n');
    box.appendChild(pre);
  }
  const rows = [['文件', s.name], ['大小', fmtSize(s.size)]];
  if (s.kind === 'image') {
    rows.push(['像素', s.w + ' × ' + s.h]);
    if (s.note) rows.push(['来源', s.note]);
  } else {
    rows.push(['行数', s.lines.toLocaleString()]);
    if (s.truncated) rows.push(['注意', t('meta.truncated')]);
  }
  meta.innerHTML = rows.map(([k, v]) => '<dt>' + esc(TX(k)) + '</dt><dd>' + esc(v) + '</dd>').join('');
  const oldStrip = document.getElementById('pageStrip');
  if (oldStrip) oldStrip.remove();
  if (s.pages && s.pages.length > 1) {
    const wrapEl = document.createElement('div');
    wrapEl.id = 'pageStrip';
    wrapEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-top:10px';
    s.pages.forEach((cv, i) => {
      const b = document.createElement('button');
      b.className = 'btn ghost sm'; b.textContent = 'P' + (i + 1);
      b.style.padding = '3px 9px';
      if (i === s.pageIndex) { b.style.borderColor = 'var(--accent)'; b.style.color = 'var(--accent)'; }
      b.onclick = async () => {
        s.pageIndex = i; s.bitmap = await createImageBitmap(cv);
        s.w = cv.width; s.h = cv.height;
        s.note = 'PDF 第 ' + (i + 1) + ' 页，共 ' + s.totalPages + ' 页';
        paintSource();
      };
      wrapEl.appendChild(b);
    });
    meta.parentElement.appendChild(wrapEl);
  }
  updatePlanPreview();
  syncRun();
}

function updatePlanPreview() {
  if (!S.src || S.src.kind !== 'image') { showPlan(''); return; }
  const maxCount = Math.max(1, (S.limits && S.limits.images && S.limits.images.maxCount) || 4);
  const budget = $('#optTile') && $('#optTile').checked ? maxCount - 1 : 0;
  showPlan(planInfo(S.src.w, S.src.h, budget).text);
}

/* ============ 图像预处理：增强 · 锐化 · 分块精读 ============ */
const TARGET_PX = 1150000;   // 平台会把每张图压到约 1.2 MP，这是单张图能承载的细节上限

function bitmapToCanvas(bmp, w, h) {
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w)); cv.height = Math.max(1, Math.round(h));
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  return cv;
}

// 灰度 + 分位数对比度拉伸 + 轻度伽马：让发黄的蓝图、翻拍件里的细线变实
function enhance(cv) {
  const ctx = cv.getContext('2d'), d = ctx.getImageData(0, 0, cv.width, cv.height), p = d.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < p.length; i += 4) {
    const g = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) | 0;
    p[i] = p[i + 1] = p[i + 2] = g; hist[g]++;
  }
  const total = p.length / 4; let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > total * 0.015) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > total * 0.015) { hi = i; break; } }
  const span = Math.max(1, hi - lo), lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const n = Math.max(0, Math.min(1, (v - lo) / span));
    lut[v] = Math.pow(n, 1.15) * 255;          // 伽马 >1：把中间调压深，线条更黑
  }
  for (let i = 0; i < p.length; i += 4) { const v = lut[p[i]]; p[i] = p[i + 1] = p[i + 2] = v; }
  ctx.putImageData(d, 0, 0);
  return cv;
}

// 3×3 反锐化掩模：抵消重采样带来的发虚，保住尺寸数字的笔画和角标的引线
function sharpen(cv, amount) {
  const w = cv.width, h = cv.height;
  if (w < 3 || h < 3 || !amount) return cv;
  const ctx = cv.getContext('2d'), img = ctx.getImageData(0, 0, w, h), out = img.data;
  const src = new Uint8ClampedArray(out), a = amount, c = 1 + 4 * a, row = w * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * row + x * 4;
      for (let ch = 0; ch < 3; ch++) {
        out[i + ch] = c * src[i + ch] - a * (src[i - 4 + ch] + src[i + 4 + ch] + src[i - row + ch] + src[i + row + ch]);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

async function toBlob(cv) {
  // 线稿优先 PNG 无损：JPEG 的振铃会啃掉细线和小字
  const png = await new Promise(r => cv.toBlob(r, 'image/png'));
  if (png && png.size <= 4500000) return png;
  return await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.95));
}

// 在可用张数内，挑一个最贴合图纸长宽比、又能让每块尽量接近原生分辨率的网格
function tilePlan(w, h, budget) {
  if (budget < 1) return null;
  const need = Math.ceil((w * h) / TARGET_PX);
  if (need <= 1) return null;
  const n = Math.min(need, budget);
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    for (let rows = 1; cols * rows <= n; rows++) {
      const aspectErr = Math.abs(Math.log((cols / rows) / (w / h)));
      const cover = (w / cols) * (h / rows);
      const over = Math.max(0, Math.log(cover / TARGET_PX));
      const score = aspectErr * 0.8 + over * 2.2 - Math.log(cols * rows) * 0.18;
      if (!best || score < best.score) best = { cols: cols, rows: rows, score: score, cover: cover };
    }
  }
  return best;
}

function planInfo(w, h, budget) {
  const ovScale = Math.min(1, Math.sqrt(TARGET_PX / (w * h)));
  const plan = tilePlan(w, h, budget);
  if (!plan) {
    return { plan: null, text: tf('plan.noTile', { w: w, h: h, reason: t(ovScale >= 0.99 ? 'plan.belowLimit' : 'plan.tileOff') }) };
  }
  const tileScale = Math.min(2.2, Math.sqrt(TARGET_PX / plan.cover));
  const mag = tileScale / ovScale;
  const native = plan.cover <= TARGET_PX * 1.02;
  return {
    plan: plan,
    text: tf('plan.tiles', { c: plan.cols, r: plan.rows, n: plan.cols * plan.rows + 1 }) + '\n' +
      tf('plan.mag', { m: mag.toFixed(1) }) + t(native ? 'plan.native' : 'plan.limited'),
  };
}

async function prepareImages() {
  const s = S.src, out = [], labels = [];
  const lim = S.limits && S.limits.images;
  const maxCount = Math.max(1, (lim && lim.maxCount) || 4);
  const doEnhance = $('#optEnhance').checked;

  const k = Math.min(1, Math.sqrt(TARGET_PX / (s.w * s.h)));
  let overview = bitmapToCanvas(s.bitmap, s.w * k, s.h * k);
  if (doEnhance) overview = enhance(overview);
  if (k < 0.98) overview = sharpen(overview, 0.35);
  out.push(await toBlob(overview));
  labels.push('Image 1 = full overview (for overall layout and view relationships)');

  const budget = $('#optTile').checked ? maxCount - 1 : 0;
  const info = planInfo(s.w, s.h, budget);
  if (info.plan) {
    const cols = info.plan.cols, rows = info.plan.rows, ov = 0.08;
    let n = 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tw = s.w / cols, th = s.h / rows;
        const sx = Math.max(0, tw * c - tw * ov), sy = Math.max(0, th * r - th * ov);
        const sw = Math.min(s.w - sx, tw * (1 + ov * 2)), sh = Math.min(s.h - sy, th * (1 + ov * 2));
        const scale = Math.min(2.2, Math.sqrt(TARGET_PX / (sw * sh)));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(sw * scale)); cv.height = Math.max(1, Math.round(sh * scale));
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(s.bitmap, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
        if (doEnhance) enhance(cv);
        sharpen(cv, scale > 1.05 ? 0.55 : 0.4);
        out.push(await toBlob(cv));
        n++;
        labels.push('第 ' + n + ' 张 = 局部块 [第 ' + (r + 1) + ' 行 / 第 ' + (c + 1) + ' 列]，覆盖整图的横向 ' +
          Math.round(c * 100 / cols) + '~' + Math.round((c + 1) * 100 / cols) + '%、纵向 ' +
          Math.round(r * 100 / rows) + '~' + Math.round((r + 1) * 100 / rows) + '%，相邻块之间有重叠');
      }
    }
  }
  return { blobs: out, note: labels.join('\n'), planText: info.text, count: out.length };
}

/* ============ 提示词 ============ */
const OUTPUT_LANG = {
  zh: '全部用简体中文；牌号、标准号、指令、符号（如 Ø、⌀、⊥、Ra、H7/k6）保留原文写法。',
  en: 'Write everything in English — every single string value, including short table cells, sample/series/legend labels, line-style names and one- or two-word field values, not just the longer prose fields. Keep material grades, standard numbers, G-code/PLC instructions and symbols (e.g. Ø, ⌀, ⊥, Ra, H7/k6) in their original form.',
  sr: 'Sve piši na srpskom jeziku (latinica) — svaka string vrednost, uključujući kratke ćelije tabela, oznake uzoraka/serija/legende, nazive stilova linija i jedno- ili dvočlane vrednosti polja, ne samo duže opisne delove. Oznake materijala, brojeve standarda, instrukcije i simbole (npr. Ø, ⌀, ⊥, Ra, H7/k6) zadrži u izvornom obliku.',
};
function RULES() {
  const lang = (typeof getLang === 'function') ? getLang() : 'zh';
  return [
    '输出要求（务必遵守）：',
    '1. 只输出一个合法 JSON 对象：第一个字符是 { ，最后一个字符是 } ，不要 markdown 代码块，不要任何解释文字。',
    '2. ' + (OUTPUT_LANG[lang] || OUTPUT_LANG.zh),
    '3. 严禁编造。图上没有或看不清的内容写 "未标注" 或 "不可辨"，并写入 uncertainties 数组。',
    '4. 由推理得到而非图面直接标注的结论，文字以 "推测：" 开头。',
    '5. 数组没有内容就给 []，不要填占位符。字段尽量填满但宁缺毋滥。',
  ].join('\n');
}

/* --- 0. 内容分流：图纸 / 图表 / 原理图 / 代码 --- */
function classifyPrompt() {
  return [
    '判断这张图属于下面哪一类。只输出 JSON，不要任何其他文字。',
    'drawing = 机械工程图纸：有视图投影、尺寸标注、公差、标题栏、剖面线之类的制图要素。',
    'chart = 数据图表：有坐标轴、曲线、柱形、散点、图例，表达的是数据关系（如应力应变曲线、S-N 曲线、性能曲线、试验数据图）。',
    'schematic = 原理或系统图：液压气动回路、电气原理、控制框图、工艺流程框图，用符号和连线表达系统关系，一般没有尺寸标注。',
    'photo = 实物照片或三维模型渲染图。',
    'code = 程序代码的截图或照片（如机床屏幕、打印稿）。',
    'irrelevant = 跟机械工程、材料科学完全无关的内容（人物、风景、动物、表情包、网页截图、与工程无关的日常照片等）。',
    'JSON 结构：{"class":"drawing|chart|schematic|photo|code|irrelevant","docType":"更具体的类型名","reason":"一句话判断依据","hasDimensions":true/false,"hasAxes":true/false}',
  ].join('\n');
}

/* --- 1. 全图文字转写 --- */
function transcribePrompt(imgNote, alsoClassify) {
  return [
    '你是工程图纸的文字识别与整理专家。下面是同一份图的多张图片：',
    imgNote,
    '',
    '任务：把图面上出现的每一处文字、数字、符号，完整、原样地抄录下来。逐块扫描，不要遗漏，也绝不编造。',
    '需要覆盖：标题栏的全部栏目与内容、明细栏与件号气泡、所有尺寸数字与极限偏差、形位公差框格内的全部格子、',
    '表面粗糙度符号及其数值、基准符号、剖切符号与视图名称、局部放大编号与比例、技术要求的逐条全文、',
    '更改（版本）记录、图幅与比例、焊接符号、螺纹标记、引线注释、印章或水印文字。',
    '',
    '抄录规则：',
    '- 数字与符号保持原样，包括 Ø ⌀ ± ° R C M × / □ ⌖ ⊥ ∥ ⌭ ⌰ 等；分数和上下偏差按 "55 +0.021/+0.002" 的形式写。',
    '- 每一条都要说明它在整图的哪个位置（用局部块编号，如 "第3块(第1行第2列) 左下"）。',
    '- 确实看不清的字符用 ? 占位，并把该条写进 unclear，不要猜一个数字填上去。',
    '- 重叠区域里重复出现的同一条内容只记一次。',
    '',
    RULES(),
    '',
    'JSON 结构：',
    (alsoClassify ? '{"class":"drawing|chart|schematic|photo|code|irrelevant（drawing=工程图纸；chart=有坐标轴的数据图表；schematic=原理/回路/框图；photo=实物照片；code=程序代码截图；irrelevant=跟机械/材料工程完全无关的内容）","docType":"更具体的类型名",' : '{') +
    '"titleBlock":[{"field":"栏目名","value":"原文内容"}],' +
    '"items":[{"zone":"位置","kind":"尺寸|极限偏差|形位公差|粗糙度|基准|视图名|剖切符号|技术要求|件号|标题栏|螺纹|焊接|注释|其他","text":"原样文字"}],' +
    '"technicalNotes":["技术要求逐条原文"],' +
    '"unclear":[{"zone":"位置","what":"看不清的是什么","why":"原因"}],' +
    '"coverage":"对本次转写完整度的自评，一句话"}',
  ].join('\n');
}

/* --- 2A. 工程图纸识读 --- */
const DRAWING_SCHEMA = `{
"docType":"零件图|装配图|部件图|原理示意图|液压气动回路图|电气/控制图|工艺/工装图|三维模型截图|手绘草图|其他",
"confidence":0-100 的整数,识读把握程度,
"titleBlock":{"title":"图名/零件名","drawingNo":"图号","scale":"比例","projection":"第一角法|第三角法|未标注","material":"标题栏材料","quantity":"数量","unit":"单位(mm/inch)","standard":"依据标准(GB/T、ISO、ASME 等)","revision":"版本/更改","org":"单位/设计者","date":"日期"},
"oneLiner":"一句话说清这是什么、用在哪里",
"summary":"4-6 句概述:这张图画的是什么、整体结构、主要技术要求",
"keywords":["6-10 个关键词"],
"views":[{"name":"主视图/俯视图/A-A 剖视/局部放大 I 等","type":"视图类型","describes":"这个视图表达了什么"}],
"components":[{"no":"件号","name":"名称","qty":"数量","material":"材料","function":"作用"}],
"features":[{"name":"结构特征(如 键槽/退刀槽/倒角/油孔/加强筋)","spec":"规格尺寸","purpose":"为什么要有它"}],
"principle":{"designIntent":"设计思路:为什么这样设计,解决了什么问题","workingPrinciple":"工作原理:怎么动、怎么受力、怎么密封/定位","motionFlow":["运动或介质传递链路,按顺序"],"loadPath":["力/扭矩传递路径,按顺序"]},
"dimensions":[{"feature":"部位","nominal":"基本尺寸","tolerance":"公差/极限偏差","fit":"配合代号","note":"用途说明"}],
"gdt":[{"symbol":"形位公差符号名(圆跳动/同轴度/平行度…)","feature":"被测要素","value":"公差值","datum":"基准","meaning":"控制了什么,为什么需要"}],
"surfaces":[{"feature":"部位","roughness":"Ra/Rz 值","process":"对应加工方式"}],
"manufacturing":{"blank":"毛坯形式","processes":["加工工序顺序"],"heatTreatment":"热处理要求","keyDifficulties":["加工难点"],"inspection":["检验项目与量具"]},
"applications":["典型应用场景/所属机器"],
"roleInSystem":"它在整台设备里承担什么作用",
"materialsSeen":["图面出现的全部材料牌号,没有则空数组"],
"risks":[{"level":"高|中|低","item":"问题","why":"原因/后果","suggestion":"建议"}],
"improvements":["设计或工艺改进建议"],
"uncertainties":["看不清、有歧义、需要向设计方确认的点"],
"glossary":[{"term":"图上的符号或术语","meaning":"含义"}]
}`;

function drawingPrompt(imgNote, vector, ocr) {
  return [
    '你是一位有 20 年经验的机械设计与制图专家，熟悉 GB/T、ISO、ASME Y14.5、DIN、JIS 的制图、公差与材料标准，也熟悉机加工、铸锻、焊接与装配工艺。',
    '',
    '我给你的图片：' + imgNote,
    '它们是同一张机械工程图纸：第 1 张是全貌，其余是同一张图的高分辨率局部块，用来看清细小的尺寸数字、公差框格和角标。',
    vector ? '\n从源文件中直接提取的矢量文字（比图像识别可靠，优先采信）：\n"""\n' + vector + '\n"""' : '',
    ocr ? '\n已完成的全图文字转写结果（第一轮逐块抄录所得，请以它为准来填写尺寸、公差与技术要求，不要另行猜测数字）：\n"""\n' + ocr + '\n"""' : '',
    '',
    '任务：像给新人讲图一样，把这张图彻底读懂——它是什么图、表达了什么设计思路、每个结构起什么作用、技术要求意味着什么、这东西用在哪里。',
    '',
    RULES(),
    '',
    '按下面的 JSON 结构输出（键名原样保留，值用中文）：',
    DRAWING_SCHEMA,
  ].filter(Boolean).join('\n');
}

/* --- 2B. 数据图表解读 --- */
const CHART_SCHEMA = `{
"docType":"应力-应变曲线|S-N 疲劳曲线|硬度分布曲线|性能/特性曲线|泵与风机特性曲线|柱状图|散点图|饼图|趋势图|试验数据图|列线图/诺模图|其他",
"confidence":0-100 的整数,
"titleBlock":{"title":"图表标题","source":"数据来源/试验条件/出处","standard":"依据标准","date":"日期"},
"oneLiner":"一句话说清这张图在表达什么关系",
"summary":"4-6 句概述:变量关系、总体形态、最重要的结论",
"keywords":["关键词"],
"axes":[{"axis":"X|Y|Y2","quantity":"物理量","symbol":"符号","unit":"单位","range":"量程","scale":"线性|对数","note":"刻度或断轴等说明"}],
"series":[{"name":"系列名","style":"线型/颜色/标记","condition":"对应工况或试样","meaning":"代表什么"}],
"readings":[{"point":"关注点(如 屈服点/拐点/峰值/交点)","x":"横坐标读数","y":"纵坐标读数","how":"怎么读出来的","note":"工程含义"}],
"dataTable":[{"series":"系列","x":"横坐标","y":"纵坐标"}],
"trends":["总体趋势与分段特征"],
"inflections":[{"where":"位置","what":"发生了什么","why":"物理机理"}],
"engineeringMeaning":"这张图在工程上说明了什么问题",
"howToUse":["工程师应该怎么用这张图做判断或选型"],
"derivedQuantities":[{"name":"可导出的量(如 弹性模量/屈服强度/疲劳极限/效率)","value":"估算值","how":"推算方法"}],
"materialsSeen":["图中涉及的材料牌号或试样,没有则空数组"],
"quality":[{"issue":"图表本身的问题(缺单位、坐标轴截断、样本量不明、无误差棒等)","impact":"会导致什么误读"}],
"risks":[{"level":"高|中|低","item":"使用这张图时的风险","why":"原因","suggestion":"建议"}],
"uncertainties":["读数误差、看不清的刻度、需要原始数据核对的点"],
"glossary":[{"term":"术语或符号","meaning":"含义"}]
}`;

function chartPrompt(imgNote, vector, ocr) {
  return [
    '你是工程数据分析与试验报告专家，熟悉材料试验曲线、机械性能曲线、疲劳与可靠性数据的读法。',
    '',
    '我给你的图片：' + imgNote,
    '它们是同一张工程图表：第 1 张是全貌，其余是高分辨率局部块，用于看清坐标刻度、图例和数据点标注。',
    vector ? '\n源文件中提取的文字：\n"""\n' + vector + '\n"""' : '',
    ocr ? '\n已完成的图面文字转写：\n"""\n' + ocr + '\n"""' : '',
    '',
    '任务：读懂这张图表——两个轴各是什么量、有几条曲线分别代表什么工况、曲线形状说明了什么物理过程、关键点的数值是多少、工程上应该怎么用它。',
    'readings 与 dataTable 里的数值必须按坐标刻度实际读出并注明是估读；读不准就写区间，不要给假精度。',
    '',
    RULES(),
    '',
    'JSON 结构：',
    CHART_SCHEMA,
  ].filter(Boolean).join('\n');
}

/* --- 3. 材料与性能专项 --- */
function materialPrompt(d, kind) {
  const mats = arr(d.materialsSeen).concat([txt(d.titleBlock && d.titleBlock.material)]).filter(has);
  const uniq = Array.from(new Set(mats.map(txt))).filter(x => x && x !== '未标注' && x !== '不可辨');
  const ctxLines = kind === 'chart'
    ? ['图表主题：' + txt(d.oneLiner), '涉及的量：' + arr(d.axes).map(a => txt(a.quantity) + '(' + txt(a.unit) + ')').join('、'),
       '试验条件：' + txt(d.titleBlock && d.titleBlock.source)]
    : ['零件：' + (txt(d.oneLiner) || txt(d.summary).slice(0, 120)),
       '工作原理：' + txt(d.principle && d.principle.workingPrinciple).slice(0, 300),
       '受力路径：' + arr(d.principle && d.principle.loadPath).join(' → ').slice(0, 200),
       '热处理要求：' + txt(d.manufacturing && d.manufacturing.heatTreatment),
       '加工工序：' + arr(d.manufacturing && d.manufacturing.processes).join('、').slice(0, 200)];
  return [
    '你是材料工程与失效分析专家，熟悉 GB/T、ISO、ASTM/AISI、DIN/EN、JIS 的金属与工程塑料牌号体系。',
    '',
    '场景：一份工程资料的分析结论如下——',
  ].concat(ctxLines.filter(has)).concat([
    uniq.length ? '涉及的材料：' + uniq.join('、') : '资料未标注材料，请根据功能、工艺与行业惯例推荐 1-2 种最可能的材料，并在 whyChosen 中说明这是推荐而非原文标注。',
    '',
    '任务：给出这些材料的工程数据与选材解读。数值给标准规定值或工程典型值，并在 condition 中写明状态/试样条件；拿不准的写 "需查证材料标准或供方质保书"，不要编造精确数字。',
    '',
    RULES(),
    '',
    'JSON 结构：',
    `{"materials":[{
"grade":"牌号","standard":"所属标准号","category":"类别(优质碳素结构钢/合金结构钢/铸铁/不锈钢/铝合金/工程塑料…)",
"equivalents":[{"system":"AISI/SAE|DIN/EN|JIS|ISO|UNS","grade":"对应牌号"}],
"composition":[{"element":"元素","range":"含量范围 %"}],
"mechanical":[{"property":"性能名(抗拉强度 Rm/屈服强度 ReL/断后伸长率 A/冲击吸收能量 KU2/硬度…)","value":"数值","unit":"单位","condition":"热处理状态与试样尺寸"}],
"physical":[{"property":"密度/弹性模量/热导率/线膨胀系数/比热","value":"数值","unit":"单位","condition":"条件"}],
"heatTreatment":{"route":"推荐热处理路线与温度","hardness":"目标硬度","note":"注意事项"},
"processability":{"machinability":"切削加工性","weldability":"焊接性","formability":"冷热成形性","corrosion":"耐蚀性与表面防护建议"},
"whyChosen":"为什么这个零件用它:结合受力、尺寸、成本、工艺",
"cautions":["使用/加工注意事项,如脱碳、回火脆性、氢脆、应力集中"],
"alternatives":[{"grade":"替代牌号","tradeoff":"换了之后哪里更好、哪里变差、需要改什么"}]
}],
"failureModes":[{"mode":"可能的失效模式","where":"最可能发生的部位","why":"机理","control":"控制措施"}],
"strengthNotes":["强度/刚度/疲劳的定性判断与需要校核的项目"],
"sourceNote":"数据性质说明与查证提示"}`,
  ]).filter(Boolean).join('\n');
}

/* --- 4. 模式附加分析：教学解读 / 工程分析 --- */
const TEACH_SCHEMA = `{
"audience":"这份讲解适合谁看(如 机械专业大二学生/新入职工艺员)",
"readingOrder":[{"step":"第 1 步","where":"看图上的哪个部位","how":"具体怎么看、看什么","why":"这一步解决什么问题"}],
"keySymbols":[{"symbol":"图上的符号或代号","readAs":"怎么念/怎么写","meaning":"含义","example":"这张图上的实例","standard":"出自哪个标准"}],
"concepts":[{"topic":"背后的知识点","explain":"用通俗语言讲清楚","onThisDrawing":"在这张图上体现在哪里"}],
"misreadings":[{"trap":"新手容易读错或忽略的地方","why":"为什么容易错","correct":"正确的理解"}],
"quiz":[{"q":"自测问题","a":"参考答案","point":"考查的知识点"}],
"prerequisites":["读懂这张图需要先掌握的基础知识"],
"furtherReading":["可以延伸学习的标准条款或主题"]
}`;

const ENG_SCHEMA = `{
"optimizations":[{"target":"优化对象(结构/公差/工艺/材料/成本)","current":"现状与问题","proposal":"具体改进方案","benefit":"收益,尽量定量","cost":"代价与副作用","effort":"高|中|低","priority":"高|中|低"}],
"dfm":[{"issue":"可制造性/可装配性问题","impact":"影响","fix":"建议"}],
"toleranceStack":[{"chain":"涉及的尺寸链或配合","concern":"关注点(累积偏差/干涉/间隙)","action":"建议的校核或调整"}],
"calculations":[{"item":"需要做的计算或校核","formula":"公式或方法","input":"需要的输入数据","criterion":"判据"}],
"verification":{"objective":"验证目标","specimens":"试件/样件与数量","equipment":["设备、工装与量具"],
 "steps":[{"no":1,"action":"操作步骤","condition":"参数与工况","record":"记录项","criterion":"合格判据"}],
 "measurements":[{"item":"测量项目","method":"方法与量具","tolerance":"允收范围"}],
 "safety":["试验安全与风险控制措施"],
 "schedule":"大致周期与人力估计"},
"costNotes":["成本、批量与交期方面的判断"],
"standardsToCheck":[{"standard":"需要核对的标准号","clause":"关注条款","why":"为什么"}],
"openIssues":["推进前必须先定下来的问题"]
}`;

function extraPrompt(mode, kind, data, ocr) {
  const what = kind === 'chart' ? '工程图表' : kind === 'code' ? '设备程序' : '机械工程图纸';
  const base = [
    '下面是一份' + what + '的结构化分析结果（JSON）：',
    '"""', sliceBytes(JSON.stringify(data), 30000), '"""',
    ocr ? '\n图面文字转写（原样抄录）：\n"""\n' + sliceBytes(ocr, 12000) + '\n"""' : '',
    '',
  ];
  if (mode === 'teach') {
    return base.concat([
      '你现在的身份是机械制图课的授课老师。任务：只做解读和讲解，不要提改进方案、不要提优化建议、不要设计试验。',
      '把"怎么一步步看懂这份' + what + '"讲清楚：按什么顺序看、每个符号怎么念怎么理解、背后的原理是什么、新手在哪里最容易看错。',
      '语言要通俗，多用类比，但术语必须准确，并指明出自哪个标准。所有例子都必须取自这份资料本身。',
      '', RULES(), '', 'JSON 结构：', TEACH_SCHEMA,
    ]).filter(Boolean).join('\n');
  }
  return base.concat([
    '你现在的身份是产品工程师 + 工艺工程师 + 试验工程师。任务：在已有解读之上，给出可落地的工程判断。',
    '要求：优化建议必须具体到"改什么、改成什么、带来什么收益、代价是什么"，能给数量级就给数量级，不要泛泛而谈"建议优化结构"。',
    '验证流程要写成能直接交给试验室执行的步骤：试件、工装、设备、加载条件、测点、记录项、合格判据、安全措施。',
    kind === 'code' ? '对程序类资料，验证流程指的是空运行、单段试运行、干涉与行程校验、试切与首件检验的完整流程。' : '',
    '', RULES(), '', 'JSON 结构：', ENG_SCHEMA,
  ]).filter(Boolean).join('\n');
}


/* --- 5. 老设备程序 --- */
const CODE_SCHEMA = `{
"language":"语言/格式(如 ISO 6983 G 代码、IEC 61131-3 ST、S7 STL/AWL、梯形图助记符、ABB RAPID、KUKA KRL、FANUC Karel/TP、APT、BASIC、汇编…)",
"dialect":"方言/版本","controller":"推测的控制系统或机床品牌型号","confidence":0-100 整数,
"oneLiner":"一句话说清这段程序是干什么的",
"summary":"4-6 句概述:程序目标、加工/控制对象、整体流程",
"env":{"units":"单位制","coordinateSystems":["用到的坐标系/工件零点"],"planes":"加工平面/插补平面","modes":["模态指令,如 G90/G21/G17"],"machineType":"设备类型(三轴铣/车/加工中心/机器人/PLC 产线…)","runtime":"运行环境或扫描周期"},
"structure":[{"range":"行号或段号范围","name":"段落名","purpose":"这一段在做什么"}],
"resources":{
 "tools":[{"id":"刀号/工位","desc":"刀具或执行机构","params":"转速/进给/补偿号等"}],
 "variables":[{"name":"变量/宏/寄存器","meaning":"含义","default":"默认或典型值"}],
 "io":[{"addr":"地址(I0.0/Q4.1/M100…)","name":"符号名","type":"输入|输出|中间|定时器|计数器","meaning":"作用"}],
 "subprograms":[{"id":"子程序号/例程名","purpose":"用途"}]},
"lineNotes":[{"loc":"行号/段号","code":"原始代码片段(原样,不要翻译)","note":"逐句解释:这一行让机器做了什么、为什么"}],
"process":["按时间顺序的动作/工序流程"],
"materialHints":["程序中能反映的工件材料、切削参数合理性判断,没有则空数组"],
"risks":[{"level":"高|中|低","item":"风险点","why":"后果","suggestion":"修改建议"}],
"modernization":["移植、现代化、可维护性建议(如换用新控制器、加安全联锁、参数化改造)"],
"uncertainties":["需要向设备方/原作者确认的问题"],
"glossary":[{"term":"指令或缩写","meaning":"含义"}]
}`;

function codePrompt(code, digest) {
  return [
    '你是工业控制与数控编程专家，读得懂各种老机床、老 PLC、机器人控制器上的程序：ISO 6983 G/M 代码（FANUC、SIEMENS 840D、Heidenhain、Okuma、Haas、广数/华中）、宏程序、APT；IEC 61131-3 的 ST/IL/LD/SFC、西门子 S7 AWL/SCL、三菱与欧姆龙梯形图助记符、AB PLC-5/SLC；机器人语言 ABB RAPID、KUKA KRL、FANUC TP/Karel、安川 INFORM；以及早年的 BASIC、Fortran、Z80/8051 汇编。',
    '',
    digest ? '这段程序很长，已按顺序分段预读，下面是各段摘要（JSON）：\n' + JSON.stringify(digest).slice(0, 26000) + '\n\n下面是程序开头部分原文：' : '下面是完整程序原文：',
    '"""',
    code,
    '"""',
    '',
    '任务：判定它是什么语言/什么控制系统的程序，讲清它到底在做什么、按什么顺序动作、每个关键指令的含义，并指出安全隐患与现代化改造建议。lineNotes 至少覆盖 10-25 个关键行（优先：模态设置、换刀、循环、补偿、进给转速、跳转/子程序调用、安全联锁、急停、输出动作）。',
    '',
    RULES(),
    '',
    'JSON 结构：',
    CODE_SCHEMA,
  ].filter(Boolean).join('\n');
}

function chunkPrompt(i, n, part, startLine) {
  return [
    '这是一段工业设备程序的第 ' + (i + 1) + '/' + n + ' 部分（从第 ' + startLine + ' 行开始）。只做结构化预读摘要，不要完整分析。',
    '"""', part, '"""', '',
    RULES(), '',
    'JSON 结构：{"range":"行号范围","language":"猜测的语言","purpose":"这一段做什么","ops":["关键动作/指令要点"],"symbols":[{"name":"变量或地址","meaning":"含义"}],"risks":["风险点"]}',
  ].join('\n');
}

/* ============ 调用封装 ============ */
function repairJSON(s) {
  let inStr = false, esc2 = false, stack = [], safe = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc2) { esc2 = false; continue; }
      if (ch === '\\') { esc2 = true; continue; }
      if (ch === '"') { inStr = false; safe = i; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') { stack.pop(); safe = i; }
    else if (/[0-9a-z]/i.test(ch)) safe = i;
  }
  let out = s.slice(0, safe + 1).replace(/\s*,\s*$/, '');
  out = out.replace(/\s*,?\s*"[^"\\]*"\s*:\s*$/, '');
  while (stack.length) out += stack.pop();
  try { return JSON.parse(out); } catch (e) { return null; }
}
function salvageJSON(t) {
  if (!t) return null;
  let s = String(t).trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const i = s.indexOf('{');
  if (i < 0) return null;
  s = s.slice(i);
  try { return JSON.parse(s); } catch (e) {}
  const j = s.lastIndexOf('}');
  if (j > 0) { try { return JSON.parse(s.slice(0, j + 1)); } catch (e) {} }
  return repairJSON(s);
}

async function askJSON(prompt, opts) {
  const o = Object.assign({ modelTier: S.tier, signal: S.abort ? S.abort.signal : undefined }, opts || {});
  try {
    return await S.sample.json(prompt, o);
  } catch (err) {
    const code = err && err.code;
    if (code === 'cancelled') throw err;
    if (code === 'invalid_json' || code === 'empty_completion' || code === 'max_tokens') {
      const sal = salvageJSON(err && err.text);
      if (sal) return sal;
      const r = await S.sample(prompt + '\n\n【纠正】上一次的输出不是合法 JSON。请重新输出，第一个字符必须是 { ，最后一个字符必须是 }，中间不得有任何解释文字或代码块标记。内容可以更精简。',
        Object.assign({}, o, { cache: false }));
      const sal2 = salvageJSON(r && r.text);
      if (sal2) return sal2;
    }
    throw err;
  }
}

const ERR_MSG = {
  zh: {
    not_granted: '你拒绝了 Claude 调用授权。刷新页面后在弹窗中允许，即可开始解析。',
    rate_limited: '调用太频繁或用量达到上限，请稍等片刻再试。',
    images_unavailable: '这个环境不允许页面发送图片。请在 claude.ai 网页版打开本页面再试；若原件是 PDF 或 DXF，本工具会自动改走文字通道。',
    image_rejected: '图片被拒绝：可能超过尺寸限制或格式不受支持，请换成 PNG/JPG 并控制在 20 MB 以内。',
    input_too_long: '内容超出单次输入上限，请缩小图片或拆分代码文件。',
    cancelled: '已中止解析。',
    invalid_request: '请求参数有误，请刷新页面重试。',
    overloaded: '服务繁忙，请稍后重试。',
    no_anthropic_key: '还没有填 Anthropic API Key。在页面顶部输入以 sk-ant- 开头的密钥后再试。',
    no_deepseek_key: '还没有填 DeepSeek API Key。在页面顶部输入后再试，或把模型换回 Claude。',
    default: '解析失败，请重试',
  },
  en: {
    not_granted: 'You declined the Claude authorization prompt. Refresh the page and allow it to start analyzing.',
    rate_limited: 'Too many requests or usage limit reached — wait a moment and try again.',
    images_unavailable: 'This environment won’t let the page send images. Try opening this page in claude.ai on the web; PDF/DXF sources will automatically fall back to text.',
    image_rejected: 'Image rejected: it may be too large or an unsupported format. Use PNG/JPG under 20 MB.',
    input_too_long: 'Content exceeds the single-request limit — shrink the image or split the code file.',
    cancelled: 'Analysis stopped.',
    invalid_request: 'Bad request parameters — refresh the page and try again.',
    overloaded: 'Service is busy — try again shortly.',
    no_anthropic_key: 'No Anthropic API key set. Enter one starting with sk-ant- at the top of the page.',
    no_deepseek_key: 'No DeepSeek API key set. Enter one at the top, or switch the model back to Claude.',
    default: 'Analysis failed, please retry',
  },
  sr: {
    not_granted: 'Odbio si dozvolu za pozivanje Claude-a. Osveži stranicu i dozvoli je da bi analiza mogla da počne.',
    rate_limited: 'Previše zahteva ili je dostignut limit — sačekaj trenutak pa pokušaj ponovo.',
    images_unavailable: 'Ovo okruženje ne dozvoljava slanje slika. Probaj da otvoriš stranicu na claude.ai u pregledaču; PDF/DXF izvori će automatski preći na tekstualni kanal.',
    image_rejected: 'Slika je odbijena: verovatno je prevelika ili format nije podržan. Koristi PNG/JPG do 20 MB.',
    input_too_long: 'Sadržaj prevazilazi limit po zahtevu — smanji sliku ili podeli fajl sa kodom.',
    cancelled: 'Analiza je prekinuta.',
    invalid_request: 'Neispravni parametri zahteva — osveži stranicu i pokušaj ponovo.',
    overloaded: 'Servis je zauzet — pokušaj ponovo za koji trenutak.',
    no_anthropic_key: 'Anthropic API ključ nije unet. Unesi ključ koji počinje sa sk-ant- na vrhu stranice.',
    no_deepseek_key: 'DeepSeek API ključ nije unet. Unesi ga na vrhu ili vrati model na Claude.',
    default: 'Analiza nije uspela, pokušaj ponovo',
  },
};
const errMsg = (e) => {
  const dict = ERR_MSG[getLang()] || ERR_MSG.zh;
  return (e && dict[e.code]) || (e && e.message) || dict.default;
};

/* ============ 进度 ============ */
let stepEls = [];
function showProgress(names) {
  const ul = $('#steps'); ul.innerHTML = '';
  stepEls = names.map((n) => {
    const li = document.createElement('li');
    li.innerHTML = '<i></i><span>' + esc(n) + '</span>';
    ul.appendChild(li); return li;
  });
  $('#progPanel').hidden = false;
  $('#barFill').style.width = '0%';
  $('#ticker').textContent = '';
}
function setStep(i, state) {
  stepEls.forEach((el, k) => {
    if (k < i) { el.className = 'done'; }
    else if (k === i) { el.className = state || 'run'; }
  });
  $('#barFill').style.width = Math.round((i / Math.max(1, stepEls.length)) * 100) + '%';
}
function endProgress(ok) {
  $('#barFill').style.width = '100%';
  stepEls.forEach(el => { if (el.className === 'run') el.className = ok ? 'done' : 'fail'; });
  if (ok) setTimeout(() => { $('#progPanel').hidden = true; }, 1400);
}
const ticker = (t) => { $('#ticker').textContent = String(t || '').replace(/\s+/g, ' ').slice(-90); };
const onText = ({ text }) => ticker(text);

/* ============ 主流程 ============ */
// 图片通道不一定拿得到 limits：探测失败就按保守默认值放手一试，真不支持会在调用时报错再降级
async function ensureLimits(force) {
  const settled = S.limits && S.limits.images && !S.limits.images.assumed;
  if (settled && !force) return S.limits;
  if (S.sample && typeof S.sample.limits === 'function') {
    try {
      const l = await S.sample.limits();
      if (l) S.limits = Object.assign({ maxPromptBytes: 65536 }, l);
    } catch (e) { /* 探测失败按缺省处理 */ }
  }
  if (!S.limits) S.limits = { maxPromptBytes: 65536 };
  if (!S.limits.images) {
    S.limits.images = { maxCount: 4, maxInputBytes: 20971520, assumed: true,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] };
  }
  return S.limits;
}

// limits 不一定如实报告图片能力：真正可靠的判断是拿一张极小的图实测一次
async function checkImages() {
  if (S.imagesOK === true || S.imagesOK === false) return S.imagesOK;
  if (S.limits && S.limits.images && !S.limits.images.assumed) { S.imagesOK = true; return true; }
  try {
    const cv = document.createElement('canvas');
    cv.width = 96; cv.height = 64;
    const c = cv.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, 96, 64);
    c.fillStyle = '#000000'; c.font = 'bold 36px sans-serif'; c.fillText('AB', 12, 46);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    await S.sample('通道自检。只回答图片里的两个大写字母，不要其他任何字。', {
      images: [blob], modelTier: 'default', cache: true,
      signal: S.abort ? S.abort.signal : undefined,
    });
    S.imagesOK = true;
  } catch (e) {
    const c = e && e.code;
    if (c === 'cancelled') throw e;
    // 只有明确的"本视图不能发图片"才判定不可用；限流、拒绝授权等另说
    S.imagesOK = (c === 'images_unavailable') ? false : true;
    if (c === 'not_granted' || c === 'no_anthropic_key' || c === 'no_deepseek_key') throw e;
  }
  markCap();
  return S.imagesOK;
}

function markCap() {
  const cap = $('#capState');
  if (!cap || !S.sample) return;
  if (S.imagesOK === true) { cap.className = 'cap on'; cap.innerHTML = '<i></i>' + t('cap.visionReady'); }
  else if (S.imagesOK === false) {
    cap.className = 'cap off';
    cap.innerHTML = '<i></i>' + t('cap.imageUnavailable');
    cap.title = t('cap.tipNoImage');
  }
}

async function askVisionJSON(prompt, imgs, opts) {
  try {
    return await askJSON(prompt, Object.assign({ images: imgs }, opts || {}));
  } catch (e) {
    const c = e && e.code;
    if (c === 'image_rejected' && imgs.length > 1) {
      toast(t('toast.tileRejected'), 4000);
      return await askJSON(prompt, Object.assign({ images: imgs.slice(0, 1) }, opts || {}));
    }
    if (c === 'prompt_too_large' && imgs.length > 2) {
      return await askJSON(prompt, Object.assign({ images: imgs.slice(0, Math.ceil(imgs.length / 2)) }, opts || {}));
    }
    if (c === 'images_unavailable') { S.imagesOK = false; markCap(); }
    throw e;
  }
}

function mapClass(c) {
  const v = txt(c).toLowerCase();
  if (v.indexOf('irrelevant') >= 0) return 'irrelevant';
  if (v.indexOf('chart') >= 0) return 'chart';
  if (v.indexOf('code') >= 0) return 'code';
  return 'drawing';
}

function ocrToText(o) {
  if (!o) return '';
  const lines = [];
  if (arr(o.titleBlock).length) lines.push('[标题栏] ' + arr(o.titleBlock).map(t => txt(t.field) + '：' + txt(t.value)).join(' | '));
  arr(o.items).forEach(it => lines.push('[' + txt(it.kind) + ' @ ' + txt(it.zone) + '] ' + txt(it.text)));
  if (arr(o.technicalNotes).length) lines.push('[技术要求]\n' + arr(o.technicalNotes).map((t, i) => (i + 1) + '. ' + txt(t)).join('\n'));
  if (arr(o.unclear).length) lines.push('[不可辨] ' + arr(o.unclear).map(u => txt(u.zone) + '：' + txt(u.what)).join(' / '));
  return lines.join('\n');
}

async function run(mode) {
  if (!S.sample) { toast('当前环境无法调用 Claude，请在 claude.ai 网页中打开本页面。', 5500); return; }
  if (!S.src || S.busy) return;
  S.mode = mode === 'teach' ? 'teach' : 'eng';
  S.busy = true; S.abort = new AbortController(); syncRun();
  $('#reportState').textContent = TX(S.mode === 'teach' ? '教学解读' : '工程分析') + t('reportState.inProgress');
  try {
    if (S.src.kind === 'image') await runVisual();
    else if (S.src.isDocument) await runDocumentText(S.src.text);
    else await runCodeCore(S.src.text, null);
    endProgress(true);
  } catch (e) {
    console.error(e);
    endProgress(false);
    toast(errMsg(e), 7000);
    $('#reportState').textContent = e && e.code === 'cancelled' ? t('reportState.stopped') : t('reportState.failed');
  } finally {
    S.busy = false; S.abort = null; syncRun();
  }
}

async function runVisual() {
  await ensureLimits(true);
  if (!(await checkImages())) return await runNoImageFallback();
  const doOCR = $('#optOCR').checked;
  const wantMat = $('#optMaterial').checked;
  const forced = S.docClass;
  const tier = S.tier, midTier = tier === 'quick' ? 'quick' : 'default';

  const names = [t('step.prep')];
  if (forced === 'auto' && !doOCR) names.push(t('step.classify'));
  if (doOCR) names.push(t(forced === 'auto' ? 'step.classifyOcr' : 'step.ocr'));
  names.push(t('step.main'));
  if (wantMat) names.push(t('step.material'));
  names.push(t(S.mode === 'teach' ? 'step.teach' : 'step.eng'));
  names.push(t('step.summary'));
  showProgress(names);
  let idx = 0;
  const next = () => setStep(idx++);

  next();
  const prep = await prepareImages();
  const max = (S.limits.images && S.limits.images.maxCount) || 1;
  const imgs = prep.blobs.slice(0, max);
  showPlan(prep.planText + (imgs.length < prep.blobs.length ? '\n' + tf('plan.capped', { n: imgs.length }) : ''));

  try {
    let cls = forced, clsNote = null;
    if (forced === 'auto' && !doOCR) {
      next();
      try {
        clsNote = await askVisionJSON(classifyPrompt(), imgs.slice(0, 1), { modelTier: midTier });
        cls = mapClass(clsNote && clsNote.class);
      } catch (e) {
        if (e && (e.code === 'cancelled' || e.code === 'images_unavailable')) throw e;
        cls = 'drawing';
      }
    }

    // 图片里是程序代码：先逐字转写，再走代码分析管线
    if (cls === 'code') {
      const tr = await askVisionJSON(
        '把这些图片里的程序代码逐字转写出来，保持原有行序、缩进、行号与大小写，不要翻译、不要解释、不要补全。' +
        '看不清的字符用 ? 占位。只输出 JSON：{"code":"转写出的完整代码，用 \\n 换行","unclear":["看不清的位置"]}',
        imgs, { modelTier: midTier, onText });
      const code = txt(tr && tr.code);
      if (!code) throw new Error(t('err.noCodeFromImage'));
      S.src.transcribedCode = code;
      return await runCodeCore(code, t('plan.fromImage'));
    }

    let ocrRaw = null, ocrText = '';
    if (doOCR) {
      next(); ticker('');
      try {
        ocrRaw = await askVisionJSON(transcribePrompt(prep.note, forced === 'auto'), imgs, { modelTier: midTier, onText });
        ocrText = sliceBytes(ocrToText(ocrRaw), 24000);
        if (forced === 'auto' && ocrRaw && has(ocrRaw.class)) { cls = mapClass(ocrRaw.class); clsNote = { class: ocrRaw.class, docType: ocrRaw.docType }; }
      } catch (e) {
        if (e && (e.code === 'cancelled' || e.code === 'images_unavailable')) throw e;
        console.warn('文字转写失败', e);
        toast(t('toast.ocrIncomplete'), 4000);
      }
    }

    if (cls === 'irrelevant') { renderIrrelevantNotice(clsNote); return; }
    if (cls === 'auto') cls = 'drawing';   // 分类没给出结果时按工程图纸处理
    next(); ticker('');
    const mainPrompt = cls === 'chart'
      ? chartPrompt(prep.note, S.src.vector, ocrText)
      : drawingPrompt(prep.note, S.src.vector, ocrText);
    const d = await askVisionJSON(mainPrompt, imgs, { modelTier: tier, onText });
    if (clsNote && has(clsNote.docType) && !has(d.docType)) d.docType = clsNote.docType;

    let mat = null;
    if (wantMat) {
      next(); ticker('');
      try { mat = await askJSON(materialPrompt(d, cls), { onText, modelTier: midTier }); }
      catch (e) { if (e && e.code === 'cancelled') throw e; toast(t('toast.materialFail') + errMsg(e), 5000); }
    }

    next(); ticker('');
    let extra = null;
    try { extra = await askJSON(extraPrompt(S.mode, cls, d, ocrText), { onText, modelTier: tier }); }
    catch (e) { if (e && e.code === 'cancelled') throw e; toast(t(S.mode === 'teach' ? 'toast.modeFail.teach' : 'toast.modeFail.eng') + errMsg(e), 5000); }

    next();
    await finishReport(cls, d, mat, { extra: extra, ocr: ocrRaw, planText: prep.planText, cls: clsNote });
    S.report.imgs = imgs.slice(0, 1);
  } catch (e) {
    if (e && e.code === 'images_unavailable') return await runNoImageFallback();
    throw e;
  }
}

// 图片通道不可用时的退路：PDF / DXF 还有矢量文字可用
async function runNoImageFallback() {
  if (!has(S.src.vector)) {
    showProgress([t('step.checkImages')]); setStep(0, 'fail');
    renderNoVisionNotice();
    throw { code: 'images_unavailable',
      message: t('err.noVisionRaster') };
  }
  toast(t('toast.vectorFallback'), 6000);
  showProgress([t('step.vectorRead'), S.mode === 'teach' ? t('step.teach') : t('step.eng'), t('step.summary')]);
  setStep(0);
  const cls = S.docClass === 'chart' ? 'chart' : 'drawing';
  const pr = (cls === 'chart' ? chartPrompt : drawingPrompt)('（本次没有图片，只有下列从源文件中提取的文字信息）', S.src.vector, '');
  const d = await askJSON(pr, { modelTier: S.tier, onText });
  setStep(1); ticker('');
  let extra = null;
  try { extra = await askJSON(extraPrompt(S.mode, cls, d, ''), { onText, modelTier: S.tier }); } catch (e) { if (e && e.code === 'cancelled') throw e; }
  setStep(2);
  await finishReport(cls, d, null, { extra: extra, planText: t('plan.textOnly') });
}

function splitByBytes(text, budget, maxParts) {
  const lines = text.split(/\r\n|\r|\n/), parts = [];
  let buf = [], size = 0, start = 1;
  for (let i = 0; i < lines.length; i++) {
    const b = bytesOf(lines[i]) + 1;
    if (size + b > budget && buf.length) {
      parts.push({ text: buf.join('\n'), start: start });
      if (parts.length >= maxParts) return parts;
      buf = []; size = 0; start = i + 1;
    }
    buf.push(lines[i]); size += b;
  }
  if (buf.length) parts.push({ text: buf.join('\n'), start: start });
  return parts;
}

async function runCodeCore(full, label) {
  await ensureLimits();
  const cap = (S.limits && S.limits.maxPromptBytes) || 65536;
  const budget = cap - 9000;
  const big = bytesOf(full) > budget;
  const parts = big ? splitByBytes(full, budget - 3000, 6) : null;
  const names = (big ? parts.map((p, i) => tf('step.chunk', { i: i + 1, n: parts.length })) : [])
    .concat([t('step.codeMain'), t(S.mode === 'teach' ? 'step.codeTeach' : 'step.codeEng'), t('step.summary')]);
  showProgress(names);
  let idx = 0;
  const next = () => setStep(idx++);

  let digest = null;
  if (big) {
    digest = [];
    for (let i = 0; i < parts.length; i++) {
      next();
      try { digest.push(await askJSON(chunkPrompt(i, parts.length, parts[i].text, parts[i].start), { modelTier: 'default', onText })); }
      catch (e) { if (e && e.code === 'cancelled') throw e; digest.push({ range: '#' + parts[i].start + '+', purpose: '(pre-read failed)' }); }
    }
  }
  next(); ticker('');
  const head = big ? sliceBytes(full, budget - bytesOf(JSON.stringify(digest)) - 2000) : full;
  const d = await askJSON(codePrompt(head, digest), { modelTier: S.tier, onText });

  next(); ticker('');
  let extra = null;
  try { extra = await askJSON(extraPrompt(S.mode, 'code', d, ''), { onText, modelTier: S.tier }); }
  catch (e) { if (e && e.code === 'cancelled') throw e; toast(t(S.mode === 'teach' ? 'toast.modeFail.teach' : 'toast.modeFail.eng') + errMsg(e), 5000); }

  next();
  await finishReport('code', d, null, { extra: extra, planText: label ? t('plan.codeSource') + label : '' });
}

async function runDocumentText(full) {
  await ensureLimits();
  const wantMat = $('#optMaterial').checked;
  const cap = (S.limits && S.limits.maxPromptBytes) || 65536;
  const budget = cap - 9000;
  const big = bytesOf(full) > budget;
  const parts = big ? splitByBytes(full, budget - 3000, 6) : null;
  const names = (big ? parts.map((p, i) => tf('step.chunk', { i: i + 1, n: parts.length })) : [])
    .concat([t('step.main')]).concat(wantMat ? [t('step.material')] : [])
    .concat([t(S.mode === 'teach' ? 'step.teach' : 'step.eng'), t('step.summary')]);
  showProgress(names);
  let idx = 0;
  const next = () => setStep(idx++);

  let digest = null;
  if (big) {
    digest = [];
    for (let i = 0; i < parts.length; i++) {
      next();
      try { digest.push(await askJSON(chunkPrompt(i, parts.length, parts[i].text, parts[i].start), { modelTier: 'default', onText })); }
      catch (e) { if (e && e.code === 'cancelled') throw e; digest.push({ range: '#' + parts[i].start + '+', purpose: '(pre-read failed)' }); }
    }
  }
  next(); ticker('');
  const head = big ? sliceBytes(full, budget - bytesOf(JSON.stringify(digest)) - 2000) : full;
  const vector = digest ? sliceBytes(full, 4000) + '\n\n[分段摘要 JSON]\n' + sliceBytes(JSON.stringify(digest), 8000) : head;
  const d = await askJSON(drawingPrompt('（这是一份 Word 文档转写出的纯文字内容，没有图片，请直接依据文字分析）', vector, ''), { modelTier: S.tier, onText });

  let mat = null;
  if (wantMat) {
    next(); ticker('');
    try { mat = await askJSON(materialPrompt(d, 'drawing'), { onText, modelTier: S.tier === 'quick' ? 'quick' : 'default' }); }
    catch (e) { if (e && e.code === 'cancelled') throw e; toast(t('toast.materialFail') + errMsg(e), 5000); }
  }

  next(); ticker('');
  let extra = null;
  try { extra = await askJSON(extraPrompt(S.mode, 'drawing', d, ''), { onText, modelTier: S.tier }); }
  catch (e) { if (e && e.code === 'cancelled') throw e; toast(t(S.mode === 'teach' ? 'toast.modeFail.teach' : 'toast.modeFail.eng') + errMsg(e), 5000); }

  next();
  await finishReport('drawing', d, mat, { extra: extra, planText: t('plan.textOnly') });
}

function sliceBytes(s, max) {
  if (bytesOf(s) <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bytesOf(s.slice(0, mid)) <= max) lo = mid; else hi = mid - 1; }
  return s.slice(0, lo);
}

// 给"页面发不了图片"的环境留一条可操作的出路
function chatPrompt(mode) {
  const teach = mode === 'teach';
  return [
    '请分析我附上的这张机械工程图纸（如果是数据图表或原理图，请按图表/原理图来读）。',
    '',
    teach ? '请按"教学讲解"的方式输出：' : '请按"工程分析"的方式输出：',
    '1. 这是什么图、画的是什么零件或系统、用在哪里（一句话结论先行）；',
    '2. 标题栏信息：图名、图号、比例、投影法、材料、版本；',
    '3. 视图构成：每个视图/剖视/局部放大分别表达了什么；',
    '4. 逐条抄录图面上的全部尺寸、极限偏差、形位公差框格、表面粗糙度与技术要求，看不清的明确说明，不要猜数字；',
    '5. 设计思路与工作原理：怎么动、怎么受力、怎么定位和密封，力的传递路径；',
    '6. 关键配合与公差的含义，为什么这样选；',
    '7. 材料牌号的等效标准、化学成分、力学与物理性能、热处理路线、工艺性与替代材料；',
    '8. 制造工艺路线、加工难点与检验方法；',
    teach ? '9. 识图教学：按什么顺序看这张图、每个符号怎么读、新手最容易看错的地方、几道自测题；'
          : '9. 优化分析：结构/公差/工艺/材料上可以怎么改，收益与代价分别是什么；',
    teach ? '10. 需要先掌握的基础知识与延伸阅读。'
          : '10. 验证与试验流程：试件、设备工装、逐步操作与工况、记录项、合格判据、安全措施。',
    '',
    '数据不确定时请明确标注"需查证"，不要编造具体数值。',
  ].join('\n');
}

function renderNoVisionNotice() {
  const name = S.src ? S.src.name : t('novision.env');
  const isLocal = typeof window.__MDD_LOCAL_BRIDGE__ !== 'undefined';
  $('#frame').innerHTML =
    '<div class="tblock"><div class="cell wide"><span class="k">' + esc(t('novision.env')) + '</span>' +
    '<span class="v">' + esc(t('novision.title')) + '</span></div></div>' +
    '<section class="sec"><div class="sec-h"><span class="n">01</span><h3>' + esc(t('novision.what')) + '</h3>' +
    '<span class="n-en">Diagnosis</span></div>' +
    '<p class="lead">' + tf('novision.lead', { name: esc(name) }) + '</p>' +
    '<div class="sub">' + esc(t('novision.paths')) + '</div>' +
    '<ol class="flow">' +
    t(isLocal ? 'novision.li1.local' : 'novision.li1.web') +
    t('novision.li2') + t('novision.li3') +
    '</ol>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">' +
    '<button class="btn" id="copyPromptBtn" type="button">' + esc(t('novision.copy')) + '</button>' +
    '<button class="btn ghost" id="backDemoBtn" type="button">' + esc(t('novision.back')) + '</button></div>' +
    '<div class="note-box">' + esc(t('novision.textOk')) + '</div>' +
    '</section>';
  $('#reportState').textContent = t('cap.imageUnavailable');
}

function renderIrrelevantNotice(clsNote) {
  const docType = (clsNote && has(clsNote.docType)) ? clsNote.docType : '';
  const reason = (clsNote && has(clsNote.reason)) ? clsNote.reason : '';
  $('#frame').innerHTML =
    '<div class="tblock"><div class="cell wide"><span class="k">' + esc(t('irrelevant.env')) + '</span>' +
    '<span class="v">' + esc(t('irrelevant.title')) + '</span></div></div>' +
    '<section class="sec"><div class="sec-h"><span class="n">01</span><h3>' + esc(t('irrelevant.what')) + '</h3>' +
    '<span class="n-en">Diagnosis</span></div>' +
    '<p class="lead">' + esc(t('irrelevant.lead')) + '</p>' +
    (docType || reason ? '<div class="note-box">' +
      (docType ? '<b>' + esc(t('irrelevant.identifiedAs')) + '：</b>' + esc(docType) + '　' : '') +
      (reason ? esc(reason) : '') + '</div>' : '') +
    '<div class="sub">' + esc(t('irrelevant.suggest')) + '</div>' +
    '<ul class="bul">' +
    '<li>' + esc(t('irrelevant.li1')) + '</li>' +
    '<li>' + esc(t('irrelevant.li2')) + '</li>' +
    '</ul>' +
    '<div style="margin-top:16px"><button class="btn ghost" id="backDemoBtn" type="button">' + esc(t('novision.back')) + '</button></div>' +
    '</section>';
  S.demo = false;
  $('#reportState').textContent = t('irrelevant.title');
  toast(t('irrelevant.title'), 4500);
}

function showPlan(text) {
  const box = $('#planBox');
  if (!box) return;
  if (!has(text)) { box.hidden = true; return; }
  box.hidden = false; box.textContent = text;
}

// 即使提示词里已经要求"全部用 X 语言"，生成大段结构化 JSON（尤其是表格里一堆相似的行）
// 时模型偶尔还是会漏翻几处，留下夹杂的中文。这里做一次兜底检查：选的不是中文，就扫一遍
// 结果里还有没有残留的中文字符，有的话再喊模型专门翻一次——最多两次，翻不干净也不会死循环。
const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/;
function deepHasCJK(v) {
  if (v == null) return false;
  if (typeof v === 'string') return CJK_RE.test(v);
  if (Array.isArray(v)) return v.some(deepHasCJK);
  if (typeof v === 'object') return Object.values(v).some(deepHasCJK);
  return false;
}
const LANG_FIX_MAX_ATTEMPTS = 2;
async function ensureLanguageCompliance(obj, lang, signal) {
  if (!obj || lang === 'zh' || !deepHasCJK(obj)) return obj;
  const targetName = TRANSLATE_LANG_NAME[lang] || lang;
  let out = obj;
  for (let i = 0; i < LANG_FIX_MAX_ATTEMPTS; i++) {
    try { out = await translateJSONBlob(out, targetName, signal); }
    catch (e) { if (e && e.code === 'cancelled') throw e; break; }
    if (!deepHasCJK(out)) break;
  }
  return out;
}

async function finishReport(kind, data, mat, extras) {
  const ex = extras || {};
  const lang = getLang();
  if (lang !== 'zh') {
    try { data = await ensureLanguageCompliance(data, lang); } catch (e) { if (e && e.code === 'cancelled') throw e; }
    if (mat) { try { mat = await ensureLanguageCompliance(mat, lang); } catch (e) { if (e && e.code === 'cancelled') throw e; } }
    if (ex.extra) { try { ex.extra = await ensureLanguageCompliance(ex.extra, lang); } catch (e) { if (e && e.code === 'cancelled') throw e; } }
  }
  S.report = {
    kind: kind, mode: S.mode, data: data, mat: mat, extra: ex.extra || null, ocr: ex.ocr || null,
    planText: ex.planText || '', clsNote: ex.cls || null, qa: [], at: nowStamp(), lang: lang,
    src: { name: S.src.name, size: S.src.size, note: S.src.note || '', kind: S.src.kind },
  };
  S.demo = false;
  renderReport();
  saveHistory();
  $('#reportState').textContent = TX(S.mode === 'teach' ? '教学解读' : '工程分析') + t('reportState.done') + ' · ' + S.report.at;
  toast(t('toast.analysisDone') + reportTitle());
  $('#sheet').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ============ 已生成报告的语言切换 ============ */
const TRANSLATE_LANG_NAME = { en: 'English', sr: 'Serbian (Latin script)' };

async function translateJSONBlob(obj, targetName, signal) {
  const json = JSON.stringify(obj);
  const prompt = [
    'Translate every natural-language string value in the following JSON into ' + targetName + '.',
    'Rules:',
    '- Keep every key name exactly as-is (do not translate keys).',
    '- Keep numbers, units, standard numbers, material grades, codes, G-code/PLC addresses and symbols (\u00d8, k6, GB/T...) unchanged.',
    '- Keep the JSON structure, array lengths and field presence identical \u2014 only replace the natural-language text inside string values.',
    '- Output only the translated JSON, no explanation, no markdown fences.',
    '',
    'JSON:',
    '"""',
    json,
    '"""',
  ].join('\n');
  return await askJSON(prompt, { modelTier: 'default', signal: signal });
}

async function translateReportContent(targetLang) {
  const r = S.report;
  if (!r || S.demo) return;
  if (r.lang === targetLang) return;
  if (!S.sample) { toast(t('translate.needApi'), 5000); r.lang = targetLang; return; }
  if (targetLang === 'zh') { r.lang = targetLang; renderReport(); return; }

  const targetName = TRANSLATE_LANG_NAME[targetLang] || targetLang;
  const parts = [];
  if (r.data) parts.push('data');
  if (r.mat) parts.push('mat');
  if (r.extra) parts.push('extra');
  if (r.ocr) parts.push('ocr');
  if (r.qa && r.qa.length) parts.push('qa');
  if (!parts.length) { r.lang = targetLang; return; }

  toast(tf('translate.busy', { lang: targetName }));
  const controller = new AbortController();
  const cap = (S.limits && S.limits.maxPromptBytes) || 65536;
  const budget = Math.floor(cap * 0.55);
  let okCount = 0, skipCount = 0, failCount = 0;
  for (const key of parts) {
    const val = r[key];
    const bytes = bytesOf(JSON.stringify(val));
    if (bytes > budget) { skipCount++; continue; }
    try {
      r[key] = await ensureLanguageCompliance(val, targetLang, controller.signal);
      okCount++;
    } catch (e) {
      if (e && e.code === 'cancelled') break;
      failCount++;
    }
  }
  r.lang = targetLang;
  renderReport();
  saveHistory();
  if (failCount || skipCount) toast(t('translate.fail') + (failCount + skipCount) + '/' + parts.length, 6000);
  else toast(tf('translate.done', { lang: targetName }));
}

/* ============ 报告渲染 ============ */
function reportTitle() {
  const r = S.report; if (!r) return t('title.untitled');
  if (r.kind === 'code') return (txt(r.data.language) || '设备程序') + ' · ' + (txt(r.data.controller) || '解析');
  const tb = r.data.titleBlock || {};
  return txt(tb.title) || txt(r.data.oneLiner).slice(0, 26) || (r.kind === 'chart' ? '工程图表' : '机械图纸');
}

const paras = (t) => txt(t).split(/\n+/).filter(has).map(p => '<p class="body-p">' + esc(p) + '</p>').join('');
const lead = (t) => has(t) ? '<p class="lead">' + esc(t) + '</p>' : '';
const sub = (t) => '<div class="sub">' + esc(TX(t)) + '</div>';
const chips = (list) => arr(list).length ? '<div class="chips">' + arr(list).map(c => '<span class="chip">' + esc(c) + '</span>').join('') + '</div>' : '';
const bullets = (list) => arr(list).length ? '<ul class="bul">' + arr(list).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '';
const flow = (list) => arr(list).length ? '<ol class="flow">' + arr(list).map(x => '<li>' + esc(x) + '</li>').join('') + '</ol>' : '';

function tbl(cols, rows) {
  const body = arr(rows).filter(r => r.some(has));
  if (!body.length) return '';
  return '<div class="tw"><table class="tb"><thead><tr>' +
    cols.map(c => '<th' + (c.num ? ' class="num"' : '') + '>' + esc(TX(c.h)) + '</th>').join('') +
    '</tr></thead><tbody>' +
    body.map(r => '<tr>' + r.map((v, i) => '<td' + (cols[i] && cols[i].num ? ' class="num"' : '') + '>' + esc(has(v) ? v : '—') + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

// 键值对表格：第一列是代码里写死的中文标签（不是 AI 数据），也要跟着 TX() 走
function kvTbl(colLabels, rows) {
  return tbl(colLabels.map(h => ({ h: h })), rows.map(r => [TX(r[0])].concat(r.slice(1))));
}

function riskList(list) {
  return arr(list).map(r => {
    const lv = txt(r.level);
    const cls = /高|critical|high/i.test(lv) ? 'high' : /低|low/i.test(lv) ? 'low' : 'mid';
    return '<div class="risk ' + cls + '"><div class="risk-h"><span class="pill ' + cls + '">' + esc(TX(lv || '中')) + '</span>' +
      '<span class="risk-t">' + esc(r.item) + '</span></div>' +
      (has(r.why) ? '<div class="risk-b">' + esc(r.why) + '</div>' : '') +
      (has(r.suggestion) ? '<div class="risk-s">' + esc(r.suggestion) + '</div>' : '') + '</div>';
  }).join('');
}

function propRows(list) {
  return arr(list).map(p => '<div class="prop"><span class="pn">' + esc(p.property || p.element) + '</span>' +
    '<span class="pv">' + esc(has(p.value) ? p.value : p.range) + ' ' + esc(p.unit || '') +
    (has(p.condition) ? '<span class="pc">' + esc(p.condition) + '</span>' : '') + '</span></div>').join('');
}

function matCards(mat) {
  return arr(mat.materials).map(m => {
    const eq = arr(m.equivalents).map(e => esc(e.system) + ' ' + esc(e.grade)).join(' · ');
    const pr = m.processability || {};
    return '<div class="mat">' +
      '<div class="mat-h"><span class="g">' + esc(m.grade) + '</span>' +
      (has(m.standard) ? '<span class="s">' + esc(m.standard) + '</span>' : '') +
      (has(m.category) ? '<span class="c">' + esc(m.category) + '</span>' : '') + '</div>' +
      (eq ? '<div class="body-p" style="font-size:12.5px">' + esc(TX('等效牌号：')) + eq + '</div>' : '') +
      (has(m.whyChosen) ? '<p class="body-p">' + esc(m.whyChosen) + '</p>' : '') +
      '<div class="mgrid">' +
      (arr(m.mechanical).length ? '<div>' + sub('力学性能') + propRows(m.mechanical) + '</div>' : '') +
      (arr(m.physical).length ? '<div>' + sub('物理性能') + propRows(m.physical) + '</div>' : '') +
      (arr(m.composition).length ? '<div>' + sub('化学成分 %') + propRows(m.composition) + '</div>' : '') +
      '</div>' +
      (m.heatTreatment && (has(m.heatTreatment.route) || has(m.heatTreatment.hardness))
        ? sub('热处理') + '<p class="body-p">' + esc(m.heatTreatment.route) +
          (has(m.heatTreatment.hardness) ? '　' + esc(TX('目标硬度：')) + esc(m.heatTreatment.hardness) : '') +
          (has(m.heatTreatment.note) ? '　' + esc(m.heatTreatment.note) : '') + '</p>' : '') +
      (has(pr.machinability) || has(pr.weldability) || has(pr.formability) || has(pr.corrosion)
        ? sub('工艺性') + kvTbl(['项目', '评价'], [
            ['切削加工性', pr.machinability], ['焊接性', pr.weldability],
            ['成形性', pr.formability], ['耐蚀与防护', pr.corrosion]]) : '') +
      (arr(m.cautions).length ? sub('使用注意') + bullets(m.cautions) : '') +
      (arr(m.alternatives).length ? sub('替代材料') + tbl([{ h: '牌号' }, { h: '取舍' }], arr(m.alternatives).map(a => [a.grade, a.tradeoff])) : '') +
      '</div>';
  }).join('');
}

function titleBlock(r) {
  const d = r.data, isCode = r.kind === 'code', isChart = r.kind === 'chart', isDraw = !isCode && !isChart;
  const tb = (isCode ? null : d.titleBlock) || {};
  const name = isCode ? (txt(d.language) || TX('设备程序'))
    : (txt(tb.title) || txt(d.oneLiner).slice(0, 30) || (isChart ? TX('工程图表') : TX('机械图纸')));
  const cells = [];
  const add = (k, v) => { if (has(v) && txt(v) !== '未标注') cells.push('<div class="cell"><span class="k">' + esc(TX(k)) + '</span><span class="v">' + esc(v) + '</span></div>'); };
  add('解析模式', r.mode === 'teach' ? TX('教学解读') : r.mode === 'eng' ? TX('工程分析') : '');
  add('内容类型', isChart ? TX('数据图表') : isCode ? TX('程序代码') : TX('工程图纸'));
  if (isChart) {
    add('图表类型', d.docType); add('数据来源', tb.source); add('依据标准', tb.standard); add('日期', tb.date);
  } else if (isDraw) {
    add('图号', tb.drawingNo); add('比例', tb.scale); add('投影法', tb.projection);
    add('材料', tb.material); add('数量', tb.quantity); add('单位制', tb.unit);
    add('依据标准', tb.standard); add('版本', tb.revision); add('设计单位', tb.org);
    add('图纸日期', tb.date); add('图纸类型', d.docType);
  } else {
    const env = d.env || {};
    add('语言/格式', d.language); add('方言', d.dialect); add('控制系统', d.controller);
    add('设备类型', env.machineType); add('单位制', env.units); add('坐标系', arr(env.coordinateSystems).join(' '));
    add('加工平面', env.planes); add('运行环境', env.runtime);
  }
  add('源文件', r.src && r.src.name);
  add('精读方案', r.planText && r.planText.split('\n')[0]);
  add('解析时间', r.at);
  const cf = Math.max(0, Math.min(100, parseInt(d.confidence, 10) || 0));
  if (cf) cells.push('<div class="cell"><span class="k">' + esc(TX('识读把握')) + '</span><div class="gauge"><span class="track"><i style="width:' + cf + '%"></i></span><b>' + cf + '%</b></div></div>');
  while (cells.length % 4 !== 0) cells.push('<div class="cell"></div>');
  return '<div class="tblock"><div class="cell wide"><span class="k">' + (isCode ? 'Program' : isChart ? 'Chart' : 'Drawing') + ' · ' + esc(TX('标题栏')) + '</span><span class="v">' + esc(name) + '</span></div>' + cells.join('') + '</div>';
}

function drawingSections(d, mat) {
  const P = d.principle || {}, M = d.manufacturing || {};
  const out = [];
  out.push(['概览', 'Conspectus', lead(d.oneLiner) + paras(d.summary) + chips(d.keywords)]);
  out.push(['视图与结构', 'Views & Features',
    (arr(d.views).length ? sub('视图构成') + tbl([{ h: '视图' }, { h: '类型' }, { h: '表达内容' }], arr(d.views).map(v => [v.name, v.type, v.describes])) : '') +
    (arr(d.components).length ? sub('零件/明细') + tbl([{ h: '件号', num: true }, { h: '名称' }, { h: '数量', num: true }, { h: '材料' }, { h: '作用' }], arr(d.components).map(c => [c.no, c.name, c.qty, c.material, c.function])) : '') +
    (arr(d.features).length ? sub('结构特征与用意') + tbl([{ h: '特征' }, { h: '规格', num: true }, { h: '为什么要有它' }], arr(d.features).map(f => [f.name, f.spec, f.purpose])) : '')]);
  out.push(['设计思路与工作原理', 'Design Intent',
    (has(P.designIntent) ? sub('设计思路') + paras(P.designIntent) : '') +
    (has(P.workingPrinciple) ? sub('工作原理') + paras(P.workingPrinciple) : '') +
    (arr(P.motionFlow).length ? sub('运动/介质传递链路') + flow(P.motionFlow) : '') +
    (arr(P.loadPath).length ? sub('力与扭矩传递路径') + flow(P.loadPath) : '')]);
  out.push(['尺寸 · 公差 · 配合', 'Dimensions & Tolerances',
    (arr(d.dimensions).length ? sub('关键尺寸') + tbl([{ h: '部位' }, { h: '基本尺寸', num: true }, { h: '公差', num: true }, { h: '配合', num: true }, { h: '说明' }], arr(d.dimensions).map(x => [x.feature, x.nominal, x.tolerance, x.fit, x.note])) : '') +
    (arr(d.gdt).length ? sub('几何(形位)公差') + tbl([{ h: '项目' }, { h: '被测要素' }, { h: '公差值', num: true }, { h: '基准', num: true }, { h: '控制意图' }], arr(d.gdt).map(x => [x.symbol, x.feature, x.value, x.datum, x.meaning])) : '') +
    (arr(d.surfaces).length ? sub('表面粗糙度') + tbl([{ h: '部位' }, { h: '粗糙度', num: true }, { h: '对应工艺' }], arr(d.surfaces).map(x => [x.feature, x.roughness, x.process])) : '')]);
  const matBody = mat ? matSection(mat)
    : (arr(d.materialsSeen).length ? sub('图面标注材料') + chips(d.materialsSeen) + '<div class="note-box">未执行材料专项分析。勾选左侧「材料与性能专项」后重新解析，可展开等效牌号、力学与物理性能、热处理与替代材料。</div>' : '');
  out.push(['材料与性能', 'Materials', matBody]);
  out.push(['制造工艺与检验', 'Manufacturing',
    (has(M.blank) ? sub('毛坯') + '<p class="body-p">' + esc(M.blank) + '</p>' : '') +
    (arr(M.processes).length ? sub('工序路线') + flow(M.processes) : '') +
    (has(M.heatTreatment) ? sub('热处理') + '<p class="body-p">' + esc(M.heatTreatment) + '</p>' : '') +
    (arr(M.keyDifficulties).length ? sub('加工难点') + bullets(M.keyDifficulties) : '') +
    (arr(M.inspection).length ? sub('检验项目') + bullets(M.inspection) : '')]);
  out.push(['作用与应用场景', 'Function & Use',
    (has(d.roleInSystem) ? paras(d.roleInSystem) : '') + (arr(d.applications).length ? sub('典型应用') + bullets(d.applications) : '')]);
  out.push(['风险 · 改进 · 待确认', 'Review',
    (arr(d.risks).length ? riskList(d.risks) : '') +
    (arr(d.improvements).length ? sub('改进建议') + bullets(d.improvements) : '') +
    (arr(d.uncertainties).length ? sub('需要人工复核') + bullets(d.uncertainties) : '')]);
  out.push(['术语与符号', 'Glossary', glossary(d.glossary)]);
  return out;
}

function codeSections(d) {
  const env = d.env || {}, R = d.resources || {};
  const out = [];
  out.push(['概览', 'Conspectus', lead(d.oneLiner) + paras(d.summary) +
    chips([d.language, d.dialect, d.controller, env.machineType].filter(has))]);
  out.push(['运行环境与模态', 'Runtime',
    kvTbl(['项目', '内容'], [
      ['单位制', env.units], ['坐标系 / 工件零点', arr(env.coordinateSystems).join('、')],
      ['加工/插补平面', env.planes], ['模态指令', arr(env.modes).join('、')],
      ['设备类型', env.machineType], ['运行环境', env.runtime]])]);
  out.push(['程序结构分解', 'Structure',
    tbl([{ h: '段落', num: true }, { h: '名称' }, { h: '作用' }], arr(d.structure).map(s => [s.range, s.name, s.purpose]))]);
  out.push(['资源清单', 'Resources',
    (arr(R.tools).length ? sub('刀具 / 执行机构') + tbl([{ h: '编号', num: true }, { h: '说明' }, { h: '参数', num: true }], arr(R.tools).map(t => [t.id, t.desc, t.params])) : '') +
    (arr(R.io).length ? sub('I/O 与寄存器') + tbl([{ h: '地址', num: true }, { h: '符号' }, { h: '类型' }, { h: '作用' }], arr(R.io).map(t => [t.addr, t.name, t.type, t.meaning])) : '') +
    (arr(R.variables).length ? sub('变量 / 宏') + tbl([{ h: '名称', num: true }, { h: '含义' }, { h: '典型值', num: true }], arr(R.variables).map(t => [t.name, t.meaning, t.default])) : '') +
    (arr(R.subprograms).length ? sub('子程序 / 例程') + tbl([{ h: '编号', num: true }, { h: '用途' }], arr(R.subprograms).map(t => [t.id, t.purpose])) : '')]);
  out.push(['关键代码逐行解读', 'Line Notes',
    arr(d.lineNotes).map(n => '<div class="cn"><div class="loc">' + esc(n.loc) + '</div><div>' +
      (has(n.code) ? '<code>' + esc(n.code) + '</code>' : '') +
      (has(n.note) ? '<div class="note">' + esc(n.note) + '</div>' : '') + '</div></div>').join('')]);
  out.push(['动作流程', 'Sequence', flow(d.process) + (arr(d.materialHints).length ? sub('工件与切削参数线索') + bullets(d.materialHints) : '')]);
  out.push(['风险与安全', 'Risks', riskList(d.risks)]);
  out.push(['现代化与改造建议', 'Modernization', bullets(d.modernization)]);
  out.push(['待向设备方确认', 'Open Questions', bullets(d.uncertainties || d.questions)]);
  out.push(['指令与术语', 'Glossary', glossary(d.glossary)]);
  return out;
}

function chartSections(d, mat) {
  const tb = d.titleBlock || {};
  const out = [];
  out.push(['概览', 'Conspectus', lead(d.oneLiner) + paras(d.summary) + chips(d.keywords) +
    (has(tb.source) ? '<div class="note-box"><b>' + esc(TX('数据来源与试验条件：')) + '</b>' + esc(tb.source) + '</div>' : '')]);
  out.push(['坐标轴与数据系列', 'Axes & Series',
    (arr(d.axes).length ? sub('坐标轴') + tbl([{ h: '轴' }, { h: '物理量' }, { h: '符号', num: true }, { h: '单位', num: true }, { h: '量程', num: true }, { h: '刻度' }, { h: '说明' }],
      arr(d.axes).map(a => [a.axis, a.quantity, a.symbol, a.unit, a.range, a.scale, a.note])) : '') +
    (arr(d.series).length ? sub('数据系列') + tbl([{ h: '系列' }, { h: '样式' }, { h: '对应工况' }, { h: '代表含义' }],
      arr(d.series).map(x => [x.name, x.style, x.condition, x.meaning])) : '')]);
  out.push(['关键读数与数据还原', 'Readings',
    (arr(d.readings).length ? sub('关键点读数') + tbl([{ h: '关注点' }, { h: 'X', num: true }, { h: 'Y', num: true }, { h: '读法' }, { h: '工程含义' }],
      arr(d.readings).map(x => [x.point, x.x, x.y, x.how, x.note])) : '') +
    (arr(d.dataTable).length ? sub('数据点还原（估读）') + tbl([{ h: '系列' }, { h: 'X', num: true }, { h: 'Y', num: true }],
      arr(d.dataTable).map(x => [x.series, x.x, x.y])) : '') +
    (arr(d.derivedQuantities).length ? sub('可导出的工程量') + tbl([{ h: '量' }, { h: '估算值', num: true }, { h: '推算方法' }],
      arr(d.derivedQuantities).map(x => [x.name, x.value, x.how])) : '')]);
  out.push(['趋势与拐点', 'Trends', bullets(d.trends) +
    (arr(d.inflections).length ? sub('拐点与转折') + tbl([{ h: '位置' }, { h: '发生了什么' }, { h: '物理机理' }],
      arr(d.inflections).map(x => [x.where, x.what, x.why])) : '')]);
  out.push(['工程含义与用法', 'Interpretation', paras(d.engineeringMeaning) +
    (arr(d.howToUse).length ? sub('工程上怎么用这张图') + bullets(d.howToUse) : '')]);
  out.push(['材料与性能', 'Materials', mat ? matSection(mat) : (arr(d.materialsSeen).length ? chips(d.materialsSeen) : '')]);
  out.push(['图表质量与使用风险', 'Quality',
    (arr(d.quality).length ? tbl([{ h: '问题' }, { h: '会导致什么误读' }], arr(d.quality).map(x => [x.issue, x.impact])) : '') +
    (arr(d.risks).length ? sub('使用风险') + riskList(d.risks) : '') +
    (arr(d.uncertainties).length ? sub('需要人工复核') + bullets(d.uncertainties) : '')]);
  out.push(['术语与符号', 'Glossary', glossary(d.glossary)]);
  return out;
}

function matSection(mat) {
  return matCards(mat) +
    (arr(mat.failureModes).length ? sub('可能的失效模式') + tbl([{ h: '模式' }, { h: '部位' }, { h: '机理' }, { h: '控制措施' }], arr(mat.failureModes).map(f => [f.mode, f.where, f.why, f.control])) : '') +
    (arr(mat.strengthNotes).length ? sub('强度与校核提示') + bullets(mat.strengthNotes) : '') +
    (has(mat.sourceNote) ? '<div class="note-box"><b>' + esc(TX('数据性质：')) + '</b>' + esc(mat.sourceNote) + '</div>' : '');
}

function lessonList(list) {
  return arr(list).map((x, i) => '<div class="lesson"><div class="ln">' + String(i + 1).padStart(2, '0') + '</div><div>' +
    '<div class="lt">' + esc(x.step || x.where) + (has(x.step) && has(x.where) ? '<span class="lw">' + esc(x.where) + '</span>' : '') + '</div>' +
    (has(x.how) ? '<div class="lb">' + esc(x.how) + '</div>' : '') +
    (has(x.why) ? '<div class="lwhy">' + esc(x.why) + '</div>' : '') + '</div></div>').join('');
}

function teachSections(e) {
  const out = [];
  out.push(['识图教学 · 怎么一步步看懂', 'How To Read',
    (has(e.audience) ? '<div class="note-box"><b>' + esc(TX('适合谁看：')) + '</b>' + esc(e.audience) + '</div>' : '') +
    lessonList(e.readingOrder) +
    (arr(e.keySymbols).length ? sub('符号与代号讲解') + tbl([{ h: '符号', num: true }, { h: '怎么念' }, { h: '含义' }, { h: '本图实例' }, { h: '出处标准', num: true }],
      arr(e.keySymbols).map(x => [x.symbol, x.readAs, x.meaning, x.example, x.standard])) : '')]);
  out.push(['背后的原理与易错点', 'Concepts & Pitfalls',
    arr(e.concepts).map(c => '<div class="mat" style="border-left-color:var(--accent)"><div class="mat-h"><span class="g" style="font-size:15px">' + esc(c.topic) + '</span></div>' +
      (has(c.explain) ? '<p class="body-p">' + esc(c.explain) + '</p>' : '') +
      (has(c.onThisDrawing) ? '<div class="risk-s">' + esc(c.onThisDrawing) + '</div>' : '') + '</div>').join('') +
    (arr(e.misreadings).length ? sub('新手容易读错的地方') + tbl([{ h: '易错点' }, { h: '为什么会错' }, { h: '正确理解' }],
      arr(e.misreadings).map(x => [x.trap, x.why, x.correct])) : '')]);
  out.push(['自测与延伸', 'Self Check',
    arr(e.quiz).map(q => '<div class="qa-item"><div class="qa-q">' + esc(q.q) + '</div><div class="qa-a">' + esc(q.a) +
      (has(q.point) ? '\n（考查：' + esc(q.point) + '）' : '') + '</div></div>').join('') +
    (arr(e.prerequisites).length ? sub('需要先掌握的基础') + bullets(e.prerequisites) : '') +
    (arr(e.furtherReading).length ? sub('延伸学习') + bullets(e.furtherReading) : '')]);
  return out;
}

function engSections(e, kind) {
  const out = [];
  const opt = arr(e.optimizations).map(o => {
    const lv = txt(o.priority || o.effort);
    const cls = /高|high/i.test(lv) ? 'high' : /低|low/i.test(lv) ? 'low' : 'mid';
    return '<div class="risk ' + cls + '"><div class="risk-h"><span class="pill ' + cls + '">' + esc(TX(lv || '中')) + '</span>' +
      '<span class="risk-t">' + esc(o.target) + '</span>' + (has(o.effort) ? '<span class="chip">' + esc(TX('投入')) + ' ' + esc(o.effort) + '</span>' : '') + '</div>' +
      (has(o.current) ? '<div class="risk-b"><b>' + esc(TX('现状：')) + '</b>' + esc(o.current) + '</div>' : '') +
      (has(o.proposal) ? '<div class="risk-s">' + esc(o.proposal) + '</div>' : '') +
      (has(o.benefit) || has(o.cost) ? '<div class="risk-b" style="margin-top:5px">' +
        (has(o.benefit) ? '<b>' + esc(TX('收益：')) + '</b>' + esc(o.benefit) + '　' : '') +
        (has(o.cost) ? '<b>' + esc(TX('代价：')) + '</b>' + esc(o.cost) : '') + '</div>' : '') + '</div>';
  }).join('');
  out.push(['优化分析', 'Optimization', opt +
    (arr(e.dfm).length ? sub(kind === 'code' ? '可维护性问题' : '可制造性 / 可装配性') + tbl([{ h: '问题' }, { h: '影响' }, { h: '建议' }], arr(e.dfm).map(x => [x.issue, x.impact, x.fix])) : '') +
    (arr(e.toleranceStack).length ? sub('尺寸链与配合') + tbl([{ h: '涉及' }, { h: '关注点' }, { h: '建议' }], arr(e.toleranceStack).map(x => [x.chain, x.concern, x.action])) : '') +
    (arr(e.costNotes).length ? sub('成本与批量') + bullets(e.costNotes) : '')]);
  out.push(['校核与计算清单', 'Calculations',
    tbl([{ h: '项目' }, { h: '方法/公式' }, { h: '需要的输入' }, { h: '判据' }], arr(e.calculations).map(x => [x.item, x.formula, x.input, x.criterion]))]);
  const v = e.verification || {};
  out.push([kind === 'code' ? '试运行与验证流程' : '验证与试验流程', 'Verification',
    (has(v.objective) ? '<div class="note-box"><b>' + esc(TX('验证目标：')) + '</b>' + esc(v.objective) + '</div>' : '') +
    (has(v.specimens) || arr(v.equipment).length ? kvTbl(['项目', '内容'], [
      ['试件 / 样件', v.specimens], ['设备与工装', arr(v.equipment).join('、')], ['周期估计', v.schedule]]) : '') +
    (arr(v.steps).length ? sub('执行步骤') + tbl([{ h: '#', num: true }, { h: '操作' }, { h: '参数/工况', num: true }, { h: '记录项' }, { h: '合格判据' }],
      arr(v.steps).map((x, i) => [x.no || (i + 1), x.action, x.condition, x.record, x.criterion])) : '') +
    (arr(v.measurements).length ? sub('测量项与量具') + tbl([{ h: '测量项' }, { h: '方法 / 量具' }, { h: '允收范围', num: true }],
      arr(v.measurements).map(x => [x.item, x.method, x.tolerance])) : '') +
    (arr(v.safety).length ? sub('安全与风险控制') + bullets(v.safety) : '')]);
  out.push(['需核对的标准与待决事项', 'Standards & Open Issues',
    (arr(e.standardsToCheck).length ? tbl([{ h: '标准', num: true }, { h: '关注条款' }, { h: '为什么' }], arr(e.standardsToCheck).map(x => [x.standard, x.clause, x.why])) : '') +
    (arr(e.openIssues).length ? sub('推进前必须定下来的问题') + bullets(e.openIssues) : '')]);
  return out;
}

function ocrSections(o) {
  const items = arr(o.items).slice(0, 320);
  return [['图面文字转写', 'Transcription',
    (arr(o.titleBlock).length ? sub('标题栏原文') + tbl([{ h: '栏目' }, { h: '内容' }], arr(o.titleBlock).map(x => [x.field, x.value])) : '') +
    (items.length ? sub(tf('ocr.itemsCount', { n: arr(o.items).length })) +
      tbl([{ h: '类别' }, { h: '位置' }, { h: '原样文字', num: true }], items.map(x => [x.kind, x.zone, x.text])) : '') +
    (arr(o.technicalNotes).length ? sub('技术要求原文') + flow(o.technicalNotes) : '') +
    (arr(o.unclear).length ? sub('未能辨认') + tbl([{ h: '位置' }, { h: '内容' }, { h: '原因' }], arr(o.unclear).map(x => [x.zone, x.what, x.why])) : '') +
    (has(o.coverage) ? '<div class="note-box"><b>' + esc(TX('转写完整度自评：')) + '</b>' + esc(o.coverage) + '</div>' : '')]];
}

function glossary(g) {
  return arr(g).length ? '<div class="gloss">' + arr(g).map(x => '<div><b>' + esc(x.term) + '</b>' + esc(x.meaning) + '</div>').join('') + '</div>' : '';
}

function qaBlock(qa) {
  if (!arr(qa).length) return '';
  return '<div class="qa">' + sub('追问记录') + arr(qa).map(x =>
    '<div class="qa-item"><div class="qa-q">' + esc(x.q) + '</div><div class="qa-a">' + esc(x.a) + '</div></div>').join('') + '</div>';
}

function buildSections(r) {
  let secs = r.kind === 'chart' ? chartSections(r.data, r.mat)
    : r.kind === 'code' ? codeSections(r.data)
    : drawingSections(r.data, r.mat);
  const extras = r.extra ? (r.mode === 'teach' ? teachSections(r.extra) : engSections(r.extra, r.kind)) : [];
  const tail = r.ocr ? ocrSections(r.ocr) : [];
  const gi = secs.map(x => x[1]).indexOf('Glossary');
  if (r.mode === 'teach') {
    secs = secs.slice(0, 1).concat(extras, secs.slice(1));
    const g2 = secs.map(x => x[1]).indexOf('Glossary');
    secs = g2 < 0 ? secs.concat(tail) : secs.slice(0, g2).concat(tail, secs.slice(g2));
  } else {
    secs = gi < 0 ? secs.concat(extras, tail) : secs.slice(0, gi).concat(extras, tail, secs.slice(gi));
  }
  return secs;
}

function reportHTML(r, forPrint) {
  const secs = buildSections(r).filter(s => has(s[2]));
  const body = secs.map(([cn, en, html], i) =>
    '<section class="sec"><div class="sec-h"><span class="n">' + String(i + 1).padStart(2, '0') +
    '</span><h3>' + esc(TX(cn)) + '</h3><span class="n-en">' + esc(en) + '</span></div>' + html + '</section>').join('');
  const disclaimer = '<div class="note-box">' + t('disclaimer.html') +
    (r.src && r.src.name ? '　' + esc(TX('源文件')) + '：' + esc(r.src.name) : '') + '</div>';
  return (r.demo && !forPrint ? '<div class="demo-flag">' + esc(t('src.example')) + '</div>' : '') +
    titleBlock(r) + body + qaBlock(r.qa) + disclaimer;
}

function renderReport() {
  const r = S.report; if (!r) return;
  r.demo = S.demo;
  $('#frame').innerHTML = reportHTML(r, false);
  renderPresets();
}

function renderPresets() {
  const box = $('#presets');
  const r = S.report, teach = r && r.mode === 'teach';
  const kind = r && r.kind === 'code' ? 'code' : r && r.kind === 'chart' ? 'chart' : 'drawing';
  const rows = PRESETS_I18N[kind + '.' + (teach ? 'teach' : 'eng')] || [];
  const lang = getLang();
  // 追问时始终把中文原文一起带上：这样切了界面语言，实际问题仍精确对应示例报告里的中文分析内容
  box.innerHTML = rows.map(row => {
    const shown = row[lang] || row.zh;
    return '<button type="button" data-q="' + esc(row.zh) + '">' + esc(shown) + '</button>';
  }).join('');
}

/* ============ 示例报告（页面初始状态，非用户数据） ============ */
const EX_I18N = { en: {}, sr: {} };

EX_I18N.en.drawing = {
  docType: 'Part drawing', confidence: 88,
  titleBlock: { title: 'Output Shaft', drawingNo: 'JSD-04-02', scale: '1:2', projection: 'First-angle', material: '40Cr', quantity: '1', unit: 'mm', standard: 'GB/T 1800.2-2020, GB/T 1184-1996', revision: 'B', org: 'Example drawing', date: '—' },
  oneLiner: 'Low-speed output shaft of a two-stage helical gear reducer: carries torque from the large gear through a parallel key to the coupling, while rolling bearings at both ends take the radial load.',
  summary: 'A typical stepped-shaft part drawing, shown with one principal view (axis horizontal), two removed sections and one detail view.\nSeven steps grow from both ends toward the middle, forming shoulders that locate the gear and bearings axially; the largest Ø60 step carries the large gear, the Ø55 steps on either side carry tapered roller bearings, and the Ø45 extension connects to the coupling.\nThe technical requirements focus on three points: 0.025 circular runout of both bearing seats to a common datum, 0.02 keyway symmetry, and Ra0.4 on the seal journal.\nMaterial 40Cr, through-hardened and tempered to HB241–286, delivered ground.',
  keywords: ['Stepped shaft', '40Cr Q&T', 'Parallel key', 'Tapered roller bearing', 'Shoulder location', 'H7/k6', 'Runout 0.025', 'Grinding relief groove'],
  views: [
    { name: 'Principal view (axis horizontal)', type: 'Basic view', describes: 'Axial dimension chain of the seven steps, diameters, chamfers, grinding relief grooves and the threaded end' },
    { name: 'Removed section A–A', type: 'Removed section', describes: 'Keyway 14N9 on the Ø45 coupling step, depth t=5.5' },
    { name: 'Removed section B–B', type: 'Removed section', describes: 'Keyway 18N9 on the Ø60 gear seat, depth t=7.0' },
    { name: 'Detail I, 5:1', type: 'Detail view', describes: 'Shoulder fillet R2 and grinding relief groove 2×0.5' },
  ],
  components: [],
  features: [
    { name: 'Shoulder Ø68', spec: '4mm high', purpose: 'Axial locating face for the gear and bearing inner ring; takes axial force and fixes assembly position' },
    { name: 'Grinding relief groove', spec: '2×0.5', purpose: 'Lets the grinding wheel run out so the root is not left with a step and stress concentration' },
    { name: 'Keyways', spec: '18N9×7.0 / 14N9×5.5', purpose: 'Transmit torque through standard parallel keys; N9 is the tighter tolerance class' },
    { name: 'Center holes', spec: 'B3.15/10 GB/T 145', purpose: 'Common locating datum for turning and grinding, and for re-centering during repair' },
    { name: 'Chamfers', spec: 'C2 / C1.5', purpose: 'Ease pressing on bearings and gear, remove burrs, protect fit surfaces during assembly' },
    { name: 'Fillets', spec: 'R2', purpose: 'Reduce stress concentration at the shoulders — key to fatigue life' },
    { name: 'Lock thread', spec: 'M36×1.5-6g', purpose: 'Round nut with tab washer locks the bearing inner ring' },
  ],
  principle: {
    designIntent: 'The shaft follows the "thick in the middle, thin at the ends" equal-strength layout: bending moment peaks at the gear, so the Ø60 step is largest; stepping down toward both ends lets parts slide on from either side and gives each part its own axial locating face. Fit classes follow the usual convention — k6 for bearing inner rings, r6 for the gear, m6 for the coupling — so torque is carried by interference and key together.',
    workingPrinciple: 'After two gear stages reduce motor speed, torque passes from the large gear hub through the 18N9 key into the Ø60 step. The shaft sits in tapered roller bearings at both ends: radial force goes through the bearings into the housing, axial force is taken by the shoulder and the round nut. Torque leaves through the Ø45 extension and the coupling. The Ø50 step runs against a lip seal to keep lubricant in the housing.',
    motionFlow: ['Large gear hub', '18N9 key', 'Ø60 step', 'Shaft body', 'Ø45 extension key joint', 'Coupling', 'Driven machine'],
    loadPath: ['Gear mesh force', 'Key and interference fit surfaces', 'Combined bending–torsion section', 'Bearing seats Ø55k6 at both ends', 'Bearings', 'Housing bores'],
  },
  dimensions: [
    { feature: 'Bearing seats (2)', nominal: 'Ø55', tolerance: 'k6 (+0.021/+0.002)', fit: 'With P0-class bearing inner ring', note: 'Transition fit biased to interference, stops the inner ring creeping' },
    { feature: 'Gear seat', nominal: 'Ø60', tolerance: 'r6 (+0.060/+0.041)', fit: 'H7/r6', note: 'Interference fit, shares torque with the key' },
    { feature: 'Coupling step', nominal: 'Ø45', tolerance: 'm6 (+0.025/+0.009)', fit: 'H7/m6', note: 'Transition fit for easy removal' },
    { feature: 'Seal journal', nominal: 'Ø50', tolerance: 'h9 (0/−0.062)', fit: 'With lip seal', note: 'Loose size tolerance; sealing relies on roughness and roundness' },
    { feature: 'Shoulder', nominal: 'Ø68', tolerance: 'General tolerance GB/T 1804-m', fit: '—', note: 'Locating face; squareness controlled indirectly by runout' },
    { feature: 'Keyway width (Ø60 step)', nominal: '18', tolerance: 'N9 (0/−0.043)', fit: 'Tight parallel-key joint', note: 'Depth t=7.0, measured as Ø60−t' },
    { feature: 'Overall length', nominal: '452', tolerance: '±0.5', fit: '—', note: 'Both end faces are grinding datums' },
  ],
  gdt: [
    { symbol: 'Circular runout', feature: 'Ø60 gear seat', value: '0.025', datum: 'Common datum A–B', meaning: 'Limits wobble of the gear seat relative to the bearing axis; directly affects mesh accuracy and noise' },
    { symbol: 'Circular runout', feature: 'Ø50 seal journal', value: '0.04', datum: 'A–B', meaning: 'Excess runout periodically lifts the seal lip and causes leaks' },
    { symbol: 'Symmetry', feature: 'Keyway center plane', value: '0.02', datum: 'Ø45 axis', meaning: 'Loads both key flanks evenly and prevents one-sided crushing' },
    { symbol: 'Parallelism', feature: 'Keyway side faces', value: '0.02/100', datum: 'Axis', meaning: 'Stops the key from sitting skewed and binding' },
  ],
  surfaces: [
    { feature: 'Bearing seat Ø55k6', roughness: 'Ra 0.8', process: 'Grinding' },
    { feature: 'Gear seat Ø60r6', roughness: 'Ra 0.8', process: 'Grinding' },
    { feature: 'Seal journal Ø50', roughness: 'Ra 0.4', process: 'Grinding, then non-directional polishing' },
    { feature: 'Keyway sides', roughness: 'Ra 3.2', process: 'End milling or slotting' },
    { feature: 'Non-fit diameters and faces', roughness: 'Ra 6.3', process: 'Turning' },
  ],
  manufacturing: {
    blank: 'Hot-rolled bar Ø70×460; for volume production use closed-die forgings so grain flow runs along the axis for better fatigue strength',
    processes: ['Cut stock Ø70×460', 'Rough-face both ends, drill center holes B3.15/10', 'Rough-turn all diameters, 2.5mm stock per side', 'Quench & temper: 850℃ oil quench + 520℃ temper, HB241–286', 'Lap center holes', 'Semi-finish turn with 0.4mm grinding stock, cut relief grooves and chamfers', 'Mill (slot) both keyways', 'Turn M36×1.5 thread', 'Deburr, clean, straighten', 'Grind Ø55k6, Ø60r6, Ø50 and locating faces', 'Final inspection and rust-proof packing'],
    heatTreatment: 'Through Q&T to HB241–286; for dusty or high-speed service, induction-harden the Ø50 seal journal to HRC45–50, case depth 1.0–1.5mm',
    keyDifficulties: ['0.025 runout of both bearing seats to a common datum — must be ground in one setup between centers', '0.02 keyway symmetry needs an indexing fixture or careful indicating', 'Shoulder fillets R2 and relief grooves are fatigue-critical — no tool marks, dents or sharp corners allowed'],
    inspection: ['Diameters by outside micrometer with inductive gauge spot checks', 'Runout on a bench center with indicator, located on both center holes (or V-blocks)', 'Keyway width by plug gauge, symmetry by indicator flip method', 'Roughness by profilometer or comparison specimens', 'After Q&T, hardness and metallography sampled per furnace batch'],
  },
  applications: ['Low-speed (output) shaft of general two-stage helical gear reducers', 'Drives for belt conveyors and scraper conveyors', 'Continuous medium-duty drives such as mixers and crane travel mechanisms'],
  roleInSystem: 'It is the last link of torque output in the reducer: a transmission part (carries all output torque), a support part (hands gear mesh forces to the housing) and a sealing interface (Ø50 step against the lip seal). If its runout or surface quality is out of spec, three failures show up together: higher gear noise, early bearing failure and oil leaks at the end cover.',
  materialsSeen: ['40Cr'],
  risks: [
    { level: 'High', item: 'Stress concentration at keyway ends and shoulder fillets', why: 'The shaft sees fully reversed bending; a sharp-cornered fillet can raise the effective stress concentration factor from 1.6 to over 2.5 and cut fatigue limit by 30%+', suggestion: 'Hold R2 fillets and polish them, check with radius gauges; use round-end (disc-milled) keyways instead of square ends' },
    { level: 'Medium', item: 'Ø60r6 and Ø55k6 are interference-side fits; cold pressing scores the surfaces', why: 'Scoring during pressing both reduces interference and creates fatigue origins', suggestion: 'Shrink-fit gear and bearings after induction or oil-bath heating to 80–100℃; no hammering' },
    { level: 'Medium', item: 'Spiral machining lay left on the seal journal', why: 'A spiral lay pumps oil out like a screw, causing persistent seepage', suggestion: 'Polish circumferentially after grinding for a non-directional lay, Ra≤0.4' },
    { level: 'Low', item: 'No dynamic balancing requirement on the drawing', why: 'Above 1500 r/min, unbalance will increase bearing vibration', suggestion: 'Add a balancing grade (e.g. G6.3) to the technical requirements' },
  ],
  improvements: ['For high volumes, replace the Ø60 keyed joint with an involute spline or a locking assembly to remove keyway stress concentration and improve centering', 'Roll-burnish the shoulder fillets and keyway ends; fatigue life typically improves 30–60%', 'State "keep center holes" (GB/T 145 B3.15/10) in the technical requirements so the part can be re-centered for repair', 'Show the general dimensional and geometric tolerance classes together near the title block to cut shop-floor questions'],
  uncertainties: ['The revision record at the lower right of the title block (changes in revision B) is illegible', 'Part of technical requirement 3 on the scope of induction hardening is blurred; cannot confirm whether it is mandatory', 'No explicit rule for post-heat-treatment straightening allowance or magnetic particle inspection acceptance level'],
  glossary: [
    { term: 'k6', meaning: 'Shaft tolerance zone for a transition fit in the hole-basis system; the usual fit for rolling-bearing inner rings' },
    { term: 'N9', meaning: 'Keyway width tolerance class for a tight standard parallel-key joint' },
    { term: '⌀ / Ø', meaning: 'Diameter symbol' },
    { term: 'Circular runout', meaning: 'Maximum indicator variation while the feature rotates once about the datum axis' },
    { term: 'Ra 0.8', meaning: 'Arithmetic mean roughness 0.8 μm, a common ground finish' },
    { term: 'C2', meaning: '45° chamfer, 2mm axial length' },
    { term: '2×0.5', meaning: 'Grinding relief groove: 2mm wide, 0.5mm deep' },
    { term: 'B3.15/10', meaning: 'Type B center hole per GB/T 145, pilot Ø3.15, countersink Ø10' },
    { term: 'GB/T 1804-m', meaning: 'Medium class of general linear tolerances' },
  ],
};

EX_I18N.en.material = {
  materials: [{
    grade: '40Cr', standard: 'GB/T 3077-2015', category: 'Alloy structural steel (chromium steel)',
    equivalents: [{ system: 'AISI/SAE', grade: '5140' }, { system: 'DIN/EN', grade: '41Cr4 (1.7035)' }, { system: 'JIS', grade: 'SCr440' }, { system: 'ISO', grade: '41Cr4' }, { system: 'UNS', grade: 'G51400' }],
    composition: [
      { element: 'C Carbon', range: '0.37 ~ 0.44' }, { element: 'Si Silicon', range: '0.17 ~ 0.37' },
      { element: 'Mn Manganese', range: '0.50 ~ 0.80' }, { element: 'Cr Chromium', range: '0.80 ~ 1.10' },
      { element: 'P Phosphorus', range: '≤ 0.035' }, { element: 'S Sulfur', range: '≤ 0.035' },
    ],
    mechanical: [
      { property: 'Tensile strength Rm', value: '≥ 980', unit: 'MPa', condition: '850℃ oil quench + 520℃ temper, Ø25 specimen' },
      { property: 'Lower yield strength ReL', value: '≥ 785', unit: 'MPa', condition: 'Same as above' },
      { property: 'Elongation A', value: '≥ 9', unit: '%', condition: 'Same as above' },
      { property: 'Reduction of area Z', value: '≥ 45', unit: '%', condition: 'Same as above' },
      { property: 'Impact energy KU2', value: '≥ 47', unit: 'J', condition: 'Same as above' },
      { property: 'Hardness after Q&T', value: '241 ~ 286', unit: 'HBW', condition: 'Per this drawing' },
      { property: 'Bending fatigue limit σ₋₁', value: 'approx. 350 ~ 420', unit: 'MPa', condition: 'Fully reversed, smooth specimen; confirm by test' },
    ],
    physical: [
      { property: 'Density', value: '7.85', unit: 'g/cm³', condition: '20℃' },
      { property: 'Elastic modulus E', value: '211', unit: 'GPa', condition: '20℃' },
      { property: 'Poisson’s ratio μ', value: '0.28', unit: '—', condition: '20℃' },
      { property: 'Thermal conductivity', value: '44', unit: 'W/(m·K)', condition: '100℃' },
      { property: 'Thermal expansion coefficient', value: '11.6', unit: '×10⁻⁶/K', condition: '20 ~ 100℃' },
    ],
    heatTreatment: { route: 'Normalize 850–870℃ air cool → Q&T: 850℃±10℃ oil quench + 500–540℃ temper', hardness: 'HB 241–286 (≈ Rm 820–950 MPa)', note: 'Cool quickly through 400–500℃ after tempering to avoid temper embrittlement; straighten after Q&T and stress-relieve at 200℃×2h' },
    processability: {
      machinability: 'Moderate in Q&T condition (HB≤286), about 85% of 45 steel; carbide tools, vc 80–120 m/min',
      weldability: 'Poor, carbon equivalent ≈0.72%; preheat 200–300℃, stress-relieve 600–650℃ after welding; weld repair not recommended for shafts',
      formability: 'Good hot formability: start forging 1150–1200℃, finish ≥800℃; poor cold formability',
      corrosion: 'Poor corrosion resistance; black-oxide or oil non-working surfaces, phosphate or zinc-plate in humid service',
    },
    whyChosen: 'The output shaft carries alternating combined bending and torsion, needing good overall mechanical properties and some hardenability. 40Cr after Q&T reliably reaches HB241–286 and ≥785 MPa yield below Ø60, with fatigue strength about 20–30% above 45 steel at far lower cost than 42CrMo — the standard choice for medium-duty reducer shafts.',
    cautions: ['Hardenability is insufficient above Ø80 and core properties drop — use 42CrMo instead', 'Susceptible to temper embrittlement; cool quickly after tempering', 'Tool marks at keyways and fillets sharply reduce fatigue life; roughness must be met', 'If induction hardening is added, keep the soft zone away from the maximum bending section'],
    alternatives: [
      { grade: '45 steel', tradeoff: 'About 20% cheaper and easier to machine, but lower fatigue strength and hardenability; only for light loads or large low-speed shafts' },
      { grade: '42CrMo', tradeoff: 'Better hardenability and hot strength, suits sections above Ø80 or heavy shock loads; about 30% more expensive, slightly harder to machine' },
      { grade: '20CrMnTi carburized', tradeoff: 'Surface HRC58–62 with far better wear resistance, but needs carburizing and grinding-stock control; larger heat-treatment distortion' },
      { grade: 'QT600-3 ductile iron', tradeoff: 'Good damping and low cost, but insufficient strength and impact toughness; only for low-speed light loads or cast sleeve designs' },
    ],
  }],
  failureModes: [
    { mode: 'Bending fatigue fracture', where: 'Keyway ends, R2 shoulder fillets', why: 'Alternating bending initiates cracks at stress raisers that grow over time; fracture surface shows beach marks', control: 'Hold fillet radius and roughness, use round-end keyways, roll-burnish if needed' },
    { mode: 'Fretting wear (fretting fatigue)', where: 'Ø60 gear seat and Ø55 bearing seats', why: 'With too little interference, micro-slip at the fit produces reddish-brown debris and starts cracks', control: 'Ensure interference and clean assembly; tighten the fit class if needed' },
    { mode: 'Torsional plastic deformation', where: 'Ø45 coupling step (smallest section)', why: 'Peak torque at start-up shock or machine stall exceeds yield', control: 'Check against peak torque and fit a safety coupling or torque limiter' },
    { mode: 'Grooving at the seal', where: 'Ø50 journal', why: 'Long-term rubbing of the seal lip with contaminant particles', control: 'Induction-harden or hard-chrome, keep Ra ≤ 0.4, add a dust lip' },
  ],
  strengthNotes: [
    'Check critical sections for combined bending and torsion: Ø55/Ø60 shoulder transitions and both keyway sections',
    'Check torque capacity of the gear interference fit; choose interference per GB/T 5371 and actual temperature rise',
    'Fatigue safety factor from σ₋₁ and effective stress concentration factor kσ; typically S ≥ 1.5',
    'Stiffness: maximum deflection between bearings ≤ 0.0003L, slope at the gear ≤ 0.001 rad',
  ],
  sourceNote: 'Mechanical and physical properties are GB/T 3077-2015 specified values for Ø25mm specimens plus typical handbook values. Real parts are weaker than specimens due to size effect; use supplier certificates and measured data for design checks and acceptance.',
};

EX_I18N.en.ocr = {
  titleBlock: [
    { field: 'Title', value: 'Output Shaft' }, { field: 'Drawing No.', value: 'JSD-04-02' },
    { field: 'Scale', value: '1:2' }, { field: 'Material', value: '40Cr' },
    { field: 'Qty', value: '1' }, { field: 'Revision', value: 'B' },
  ],
  items: [
    { zone: 'Tile 1 (row 1, col 1) left end', kind: 'Dimension', text: 'Ø45 m6 (+0.025/+0.009)' },
    { zone: 'Tile 2 (row 1, col 2) middle', kind: 'Dimension', text: 'Ø55 k6 (+0.021/+0.002)' },
    { zone: 'Tile 2 (row 1, col 2) middle', kind: 'Dimension', text: 'Ø60 r6 (+0.060/+0.041)' },
    { zone: 'Tile 3 (row 1, col 3) right end', kind: 'Dimension', text: 'M36×1.5-6g' },
    { zone: 'Tile 2 top', kind: 'Geometric tolerance', text: '⌰ | 0.025 | A–B' },
    { zone: 'Tile 4 (row 2, col 1)', kind: 'Geometric tolerance', text: '= | 0.02 | A' },
    { zone: 'Tile 2 top', kind: 'Roughness', text: 'Ra 0.8' },
    { zone: 'Tile 5 (row 2, col 2)', kind: 'Roughness', text: 'Ra 0.4' },
    { zone: 'Tile 4, section A–A', kind: 'Dimension', text: '14 N9 (0/−0.043), t = 5.5' },
    { zone: 'Tile 5, section B–B', kind: 'Dimension', text: '18 N9 (0/−0.043), t = 7.0' },
    { zone: 'Tile 1 bottom', kind: 'Dimension', text: '452 ±0.5 (overall length)' },
    { zone: 'Tile 3, detail I', kind: 'Note', text: 'I  5:1   R2   2×0.5' },
    { zone: 'Tile 6 (row 2, col 3)', kind: 'View label', text: 'A–A    B–B' },
    { zone: 'Tile 1 left end face', kind: 'Note', text: 'Center holes B3.15/10 GB/T 145 (both ends)' },
  ],
  technicalNotes: [
    'Quench and temper to HB241–286.',
    'Unspecified chamfers C1.5, unspecified fillets R2.',
    'General linear tolerances per GB/T 1804-m; general geometric tolerances per GB/T 1184-K.',
    'Deburr and break sharp edges; no cracks, laps or similar defects after machining.',
  ],
  unclear: [
    { zone: 'Title block, lower right', what: 'Change description for revision B', why: 'Fold crease in the original; strokes run together' },
    { zone: 'End of technical requirement 3', what: 'Scope of induction hardening', why: 'Faint print; last few characters illegible' },
  ],
  coverage: 'Title block, main dimensions, geometric tolerances and technical requirements fully transcribed; the revision record and two blurred passages could not be confirmed and are listed as illegible.',
};
EX_I18N.en.meta = {
  planText: 'Tiles 3×2, 7 images sent\nDetail magnified 2.4× vs. overview, at native resolution',
  planNote: '(example values — recalculated from the real resolution once you drop a file)',
  at: 'Example data',
  srcName: 'Example · reducer output shaft part drawing',
  srcMeta: [['Drawing', 'Reducer output shaft JSD-04-02'], ['Material', '40Cr Q&T HB241–286'], ['Status', 'Built-in example, replaced when you drop a file']],
  svgLabel: 'Example: stepped shaft sketch',
  pdfCaption: 'Example sketch · stepped shaft',
  qa: [{
    q: 'Why are both bearing seats controlled for runout against a common datum A–B?',
    a: 'Because the shaft ultimately rotates on the two bearings in the housing: what decides whether the gear runs true is the axis defined jointly by both bearing seats, not any single diameter.\nIf only one end were the datum, errors at the other end would be magnified at the gear seat, showing up after assembly as gear face wobble, mesh noise and bearing heat.\nThe common datum A–B also has a process meaning: inspection must support the part on two V-blocks or two centers and indicate it, matching how it is actually supported in the housing — only then are the measured values meaningful.',
  }],
};

EX_I18N.en.eng = {
  optimizations: [
    { target: 'Structure · Ø60 keyed joint', current: 'Single key carries torque; the keyway end is the worst stress raiser on the whole shaft and most fatigue cracks start there', proposal: 'Replace with an involute spline (e.g. INV 28×1.5×18×7H/7e) or a locking assembly (e.g. type Z2), removing the keyway', benefit: 'Effective stress concentration factor drops from ≈2.1 to 1.3–1.5, fatigue life typically +30–60%; better centering and lower gear noise', cost: 'Spline needs a dedicated hob or shaper, unit cost ≈+15%; a locking assembly needs a larger hub', effort: 'Medium', priority: 'High' },
    { target: 'Process · shoulder fillets and relief grooves', current: 'Only R2 and 2×0.5 specified, no surface strengthening', proposal: 'Roll-burnish both shoulder fillets and keyway ends (800–1200 N for Ø60, feed 0.15 mm/r, 2 passes)', benefit: '0.3–0.6 mm compressive residual stress layer; bending fatigue limit +20–40%', cost: 'One extra operation, ≈1.5 min per part, needs a burnishing tool', effort: 'Low', priority: 'High' },
    { target: 'Tolerance · Ø50 seal journal', current: 'h9 with Ra0.4, no lay direction or hardness specified', proposal: 'Add "non-directional polish after grinding, no spiral lay" and, depending on service, induction harden to HRC45–50', benefit: 'Eliminates the most common end-cover seepage complaint; hardening greatly delays seal grooving', cost: 'Induction hardening adds equipment and inspection cost, ≈¥8 per part', effort: 'Low', priority: 'Medium' },
    { target: 'Blank · stock method', current: 'Hot-rolled bar Ø70×460 with heavy turning allowance', proposal: 'Above 500 pcs switch to closed-die forgings, forging ratio ≥3, grain flow along the axis', benefit: 'Material yield from ≈45% to over 70%, fatigue strength a further +10–20%', cost: 'Tooling needed; unit cost must be amortized over batch size', effort: 'High', priority: 'Medium' },
  ],
  dfm: [
    { issue: 'Both bearing seats need 0.025 runout to a common datum, but the drawing does not say whether center holes are kept', impact: 'If the shop removes the center holes after finish turning, the part cannot be ground between centers and runout is hard to hold', fix: 'State "keep GB/T 145 B3.15/10 center holes, do not remove" in the technical requirements' },
    { issue: 'Keyway symmetry 0.02 has no defined way of establishing the datum', impact: 'Different crews indicate differently and re-inspection results conflict', fix: 'Note "datum from both center holes, measured on V-blocks by indicator"' },
    { issue: 'M36×1.5 thread sits next to the Ø55k6 bearing seat with no thread undercut', impact: 'Thread runout can intrude on the bearing seat and jam assembly', fix: 'Add a 3×1 undercut or specify the thread runout length' },
  ],
  toleranceStack: [
    { chain: 'Gear axial location: shoulder face → gear hub → spacer → bearing inner ring', concern: 'Accumulated length tolerances can leave more than 0.1 mm axial play between gear and bearing', action: 'Dimension the locating chain from one datum and run a stack-up on overall length and shoulder position' },
    { chain: 'Ø60r6 interference vs. gear bore H7', concern: 'At the minimum interference of 0.020 mm, friction torque may not carry peak torque, causing fretting', action: 'Calculate minimum interference per GB/T 5371; move to s6 or lengthen the fit if needed' },
  ],
  calculations: [
    { item: 'Combined bending–torsion strength at critical sections', formula: 'σca = √(σb² + 4τ²) ≤ [σ-1], at the Ø55/Ø60 shoulder and keyway sections', input: 'Output torque T, gear pitch diameter, bearing span, radial and axial forces', criterion: 'Safety factor S ≥ 1.5' },
    { item: 'Fatigue strength check', formula: 'Sσ = σ-1 /(kσ·σa/εσ/β + ψσ·σm)', input: 'σ-1 ≈ 350–420 MPa, effective stress concentration factor kσ, size factor εσ, surface factor β', criterion: 'Sσ ≥ 1.5, computed separately at fillets and keyways' },
    { item: 'Torque capacity of the interference fit', formula: 'Mf = π·d²·L·p·f/2', input: 'Contact pressure p at minimum interference, friction f 0.12–0.15, fit length L', criterion: 'Mf ≥ 1.5 × rated torque' },
    { item: 'Shaft stiffness and deflection', formula: 'Deflection y and slope θ at the gear by superposition on a simply supported beam', input: 'E=211 GPa, second moments of each step, load distribution', criterion: 'y ≤ 0.0003L, θ ≤ 0.001 rad' },
  ],
  verification: {
    objective: 'Verify fatigue life, fit reliability and sealing under rated and overload conditions, and confirm the drawing tolerances and heat treatment support the design life',
    specimens: '6 production shafts from the same Q&T batch (3 full-shaft fatigue, 2 sectioned for metallography and hardness, 1 spare), plus 3 standard Ø10 tensile specimens',
    equipment: ['Servo-hydraulic fatigue rig (≥100 kN·m torsion or ±50 kN bending)', 'Bench center with inductive gauge (1 μm resolution)', 'Profilometer (Ra range 0.05–10 μm)', 'Rockwell/Brinell hardness tester', 'Metallurgical microscope', 'Magnetic particle inspection unit', 'Seal test rig (temperature and speed control)'],
    steps: [
      { no: 1, action: 'Incoming and geometric re-inspection', condition: 'Room temperature 20±5℃', record: 'Step diameters, runout, keyway symmetry, roughness', criterion: 'All per drawing, runout ≤0.025' },
      { no: 2, action: 'Q&T quality confirmation', condition: 'Sampled per furnace batch', record: 'Surface and core hardness, microstructure, decarburization depth', criterion: 'HB241–286, tempered sorbite, decarburization ≤0.1 mm' },
      { no: 3, action: 'Magnetic particle inspection', condition: 'Circular and longitudinal magnetization', record: 'Defect location and size', criterion: 'No linear indications at fillets or keyways' },
      { no: 4, action: 'Rotating bending fatigue test', condition: 'One shaft each at 1.0 / 1.2 / 1.4 × rated stress amplitude, 3000 r/min', record: 'Cycles, crack initiation site, fracture appearance', criterion: '≥1×10⁷ cycles without failure at rated load' },
      { no: 5, action: 'Interference fit assembly and teardown', condition: 'Gear heated to 90±10℃ and shrunk on, disassembled after 100 h running', record: 'Press force, fretting marks, actual interference', criterion: 'No reddish-brown debris, scoring ≤2% of fit area' },
      { no: 6, action: 'Seal rig test', condition: 'Ø50 journal, 1500 r/min, oil 80℃, 500 h continuous', record: 'Leakage, journal wear depth, seal lip condition', criterion: 'No visible leakage, journal wear ≤0.02 mm' },
    ],
    measurements: [
      { item: 'Runout of both bearing seats to common datum', method: 'Between centers + dial indicator', tolerance: '≤0.025 mm' },
      { item: 'Keyway symmetry', method: 'V-block + indicator flip method', tolerance: '≤0.02 mm' },
      { item: 'Seal journal roughness and lay', method: 'Profilometer + 30× microscope', tolerance: 'Ra ≤0.4 μm, no spiral lay' },
      { item: 'Q&T hardness', method: 'Brinell tester, 3 points each at end face and middle', tolerance: 'HB 241–286' },
      { item: 'Fit interference', method: 'Measure shaft and bore separately before assembly, take the difference', tolerance: 'Within the Ø60 H7/r6 calculated range' },
    ],
    safety: ['Guard the fatigue test area — specimens can eject at fracture', 'Use heat-resistant gloves and a dedicated lifting tool for shrink fitting; never steady the gear by hand', 'Provide pressure relief and a drip tray on the hot oil circuit of the seal rig; no open flames in the test area'],
    schedule: 'Geometry and material checks 1 week; fatigue tests 3–5 weeks (cycle-driven); seal rig 3 weeks; can run in parallel for ≈6 weeks total with 2 technicians',
  },
  costNotes: [
    'Material is ≈35% of unit cost, machining ≈45%, heat treatment ≈12%; focus optimization on cutting grinding time rather than changing material',
    'Below 200 pcs bar stock is still cheapest; above 500 pcs forgings win on total cost',
  ],
  standardsToCheck: [
    { standard: 'GB/T 1800.2-2020', clause: 'Limit deviation tables for k6 / r6 / m6', why: 'Confirm the deviations on the drawing match the standard' },
    { standard: 'GB/T 1095-2003 / GB/T 1096-2003', clause: 'Parallel key and keyway dimensions and tolerances', why: 'Confirm 18N9 and 14N9 widths and depths match the key fit type' },
    { standard: 'GB/T 3077-2015', clause: '40Cr mechanical properties and delivery condition', why: 'Confirm the Q&T hardness range and size-effect correction' },
  ],
  openIssues: [
    'Actual torque spectrum and start-up shock factor are unknown and directly affect the fatigue conclusion — request the load spectrum from the OEM',
    'Whether induction hardening is mandatory is unclear from the blurred text; the designer must confirm',
    'No corrosion protection or coating requirement for non-working surfaces is shown',
  ],
};

EX_I18N.sr.drawing = {
  docType: 'Radionički crtež', confidence: 88,
  titleBlock: { title: 'Izlazno vratilo', drawingNo: 'JSD-04-02', scale: '1:2', projection: 'Evropska (prvi ugao)', material: '40Cr', quantity: '1', unit: 'mm', standard: 'GB/T 1800.2-2020, GB/T 1184-1996', revision: 'B', org: 'Primer crteža', date: '—' },
  oneLiner: 'Sporohodno izlazno vratilo dvostepenog cilindričnog reduktora: prenosi obrtni moment sa velikog zupčanika preko paralelnog klina na spojnicu, dok kotrljajni ležaji na oba kraja primaju radijalno opterećenje.',
  summary: 'Tipičan radionički crtež stepenastog vratila, prikazan jednim glavnim pogledom (osa horizontalna), dva izvučena preseka i jednim detaljem.\nSedam stepenika raste od krajeva ka sredini i formira naslone za aksijalno pozicioniranje zupčanika i ležaja; najveći stepenik Ø60 nosi veliki zupčanik, stepenici Ø55 sa obe strane nose konusne valjkaste ležaje, a izlazni kraj Ø45 se vezuje za spojnicu.\nTehnički zahtevi su usmereni na tri mesta: radijalno bacanje 0.025 oba ležajna mesta u odnosu na zajedničku bazu, simetričnost žleba za klin 0.02 i Ra0.4 na rukavcu zaptivača.\nMaterijal 40Cr, poboljšan na HB241–286, isporučuje se brušen.',
  keywords: ['Stepenasto vratilo', '40Cr poboljšan', 'Paralelni klin', 'Konusni valjkasti ležaj', 'Pozicioniranje naslonom', 'H7/k6', 'Bacanje 0.025', 'Žleb za izlaz tocila'],
  views: [
    { name: 'Glavni pogled (osa horizontalna)', type: 'Osnovni pogled', describes: 'Aksijalni lanac dimenzija sedam stepenika, prečnici, obarači, žlebovi za izlaz tocila i navojni kraj' },
    { name: 'Izvučeni presek A–A', type: 'Izvučeni presek', describes: 'Žleb za klin 14N9 na stepeniku spojnice Ø45, dubina t=5.5' },
    { name: 'Izvučeni presek B–B', type: 'Izvučeni presek', describes: 'Žleb za klin 18N9 na sedištu zupčanika Ø60, dubina t=7.0' },
    { name: 'Detalj I, 5:1', type: 'Detalj', describes: 'Prelazni radijus naslona R2 i žleb za izlaz tocila 2×0.5' },
  ],
  components: [],
  features: [
    { name: 'Naslon Ø68', spec: 'visina 4mm', purpose: 'Aksijalna površina za pozicioniranje zupčanika i unutrašnjeg prstena ležaja; prima aksijalnu silu i određuje položaj pri montaži' },
    { name: 'Žleb za izlaz tocila', spec: '2×0.5', purpose: 'Omogućava izlaz tocila da u korenu ne ostane stepenik i koncentracija napona' },
    { name: 'Žlebovi za klin', spec: '18N9×7.0 / 14N9×5.5', purpose: 'Prenos obrtnog momenta standardnim paralelnim klinovima; N9 je tešnja klasa tolerancije' },
    { name: 'Središnja gnezda', spec: 'B3.15/10 GB/T 145', purpose: 'Zajednička baza za struganje i brušenje, kao i za ponovno centriranje pri popravci' },
    { name: 'Obarači', spec: 'C2 / C1.5', purpose: 'Olakšavaju navlačenje ležaja i zupčanika, uklanjaju srh, štite površine naleganja pri montaži' },
    { name: 'Prelazni radijusi', spec: 'R2', purpose: 'Smanjuju koncentraciju napona na naslonima — ključni za zamorni vek' },
    { name: 'Navoj za osiguranje', spec: 'M36×1.5-6g', purpose: 'Okrugla navrtka sa sigurnosnom podloškom osigurava unutrašnji prsten ležaja' },
  ],
  principle: {
    designIntent: 'Vratilo prati raspored jednake čvrstoće „debelo u sredini, tanko na krajevima": moment savijanja je najveći kod zupčanika, pa je stepenik Ø60 najveći; smanjivanje ka krajevima omogućava navlačenje delova sa obe strane i svakom delu daje sopstvenu površinu za aksijalno pozicioniranje. Klase naleganja prate uobičajenu praksu — k6 za unutrašnje prstene ležaja, r6 za zupčanik, m6 za spojnicu — tako da moment prenose preklop i klin zajedno.',
    workingPrinciple: 'Posle dva stepena redukcije broja obrtaja motora, obrtni moment prelazi sa glavčine velikog zupčanika preko klina 18N9 na stepenik Ø60. Vratilo leži na konusnim valjkastim ležajima na oba kraja: radijalna sila ide preko ležaja u kućište, aksijalnu silu primaju naslon i okrugla navrtka. Moment izlazi preko kraja Ø45 i spojnice. Stepenik Ø50 radi uz semering i sprečava isticanje ulja iz kućišta.',
    motionFlow: ['Glavčina velikog zupčanika', 'Klin 18N9', 'Stepenik Ø60', 'Telo vratila', 'Klinasta veza na kraju Ø45', 'Spojnica', 'Radna mašina'],
    loadPath: ['Sila sprezanja zupčanika', 'Klin i površine presovanog naleganja', 'Presek sa kombinovanim savijanjem i uvijanjem', 'Ležajna mesta Ø55k6 na oba kraja', 'Ležaji', 'Otvori u kućištu'],
  },
  dimensions: [
    { feature: 'Ležajna mesta (2)', nominal: 'Ø55', tolerance: 'k6 (+0.021/+0.002)', fit: 'Sa unutrašnjim prstenom ležaja klase P0', note: 'Prelazno naleganje sklono preklopu, sprečava okretanje prstena' },
    { feature: 'Sedište zupčanika', nominal: 'Ø60', tolerance: 'r6 (+0.060/+0.041)', fit: 'H7/r6', note: 'Čvrsto naleganje, deli moment sa klinom' },
    { feature: 'Stepenik spojnice', nominal: 'Ø45', tolerance: 'm6 (+0.025/+0.009)', fit: 'H7/m6', note: 'Prelazno naleganje za lako skidanje' },
    { feature: 'Rukavac zaptivača', nominal: 'Ø50', tolerance: 'h9 (0/−0.062)', fit: 'Sa usnom semeringa', note: 'Labava tolerancija mere; zaptivanje zavisi od hrapavosti i kružnosti' },
    { feature: 'Naslon', nominal: 'Ø68', tolerance: 'Opšta tolerancija GB/T 1804-m', fit: '—', note: 'Površina za pozicioniranje; upravnost se posredno kontroliše bacanjem' },
    { feature: 'Širina žleba za klin (stepenik Ø60)', nominal: '18', tolerance: 'N9 (0/−0.043)', fit: 'Tesna veza paralelnim klinom', note: 'Dubina t=7.0, meri se kao Ø60−t' },
    { feature: 'Ukupna dužina', nominal: '452', tolerance: '±0.5', fit: '—', note: 'Obe čeone površine su baze za brušenje' },
  ],
  gdt: [
    { symbol: 'Radijalno bacanje', feature: 'Sedište zupčanika Ø60', value: '0.025', datum: 'Zajednička baza A–B', meaning: 'Ograničava bacanje sedišta zupčanika u odnosu na osu ležaja; direktno utiče na tačnost sprezanja i buku' },
    { symbol: 'Radijalno bacanje', feature: 'Rukavac zaptivača Ø50', value: '0.04', datum: 'A–B', meaning: 'Preveliko bacanje periodično odiže usnu semeringa i izaziva curenje' },
    { symbol: 'Simetričnost', feature: 'Srednja ravan žleba za klin', value: '0.02', datum: 'Osa Ø45', meaning: 'Ravnomerno opterećuje obe strane klina i sprečava jednostrano gnječenje' },
    { symbol: 'Paralelnost', feature: 'Bočne strane žleba', value: '0.02/100', datum: 'Osa', meaning: 'Sprečava da klin sedne ukoso i zaglavi se' },
  ],
  surfaces: [
    { feature: 'Ležajno mesto Ø55k6', roughness: 'Ra 0.8', process: 'Brušenje' },
    { feature: 'Sedište zupčanika Ø60r6', roughness: 'Ra 0.8', process: 'Brušenje' },
    { feature: 'Rukavac zaptivača Ø50', roughness: 'Ra 0.4', process: 'Brušenje, zatim poliranje bez usmerenih tragova' },
    { feature: 'Bočne strane žleba', roughness: 'Ra 3.2', process: 'Glodanje prstastim glodalom ili dubljenje' },
    { feature: 'Prečnici i čela bez naleganja', roughness: 'Ra 6.3', process: 'Struganje' },
  ],
  manufacturing: {
    blank: 'Toplovaljana šipka Ø70×460; za serijsku proizvodnju preporučuje se kovanje u kalupu, da vlakna materijala idu duž ose i povećaju zamornu čvrstoću',
    processes: ['Sečenje šipke Ø70×460', 'Grubo čeono struganje oba kraja, bušenje središnjih gnezda B3.15/10', 'Grubo struganje svih prečnika, dodatak 2.5mm po strani', 'Poboljšanje: kaljenje u ulju 850℃ + otpuštanje 520℃, HB241–286', 'Doterivanje središnjih gnezda', 'Polufino struganje sa dodatkom 0.4mm za brušenje, izrada žlebova i obarača', 'Glodanje (dubljenje) oba žleba za klin', 'Struganje navoja M36×1.5', 'Skidanje srha, pranje, ispravljanje', 'Brušenje Ø55k6, Ø60r6, Ø50 i površina za pozicioniranje', 'Završna kontrola i antikoroziono pakovanje'],
    heatTreatment: 'Poboljšanje po celom preseku na HB241–286; za prašnjave uslove ili visoke brzine, indukciono kaliti rukavac zaptivača Ø50 na HRC45–50, dubina 1.0–1.5mm',
    keyDifficulties: ['Bacanje 0.025 oba ležajna mesta u odnosu na zajedničku bazu — mora se brusiti u jednom stezanju između šiljaka', 'Simetričnost žleba 0.02 zahteva deobni pribor ili pažljivo podešavanje komparaterom', 'Radijusi naslona R2 i žlebovi su kritični za zamor — nisu dozvoljeni tragovi alata, udubljenja ni oštri uglovi'],
    inspection: ['Prečnici mikrometrom uz povremenu kontrolu induktivnim meračem', 'Bacanje na uređaju sa šiljcima i komparaterom, oslonjeno na središnja gnezda (ili V-prizme)', 'Širina žleba čepnim kalibrom, simetričnost metodom okretanja uz komparater', 'Hrapavost profilometrom ili uporednim uzorcima', 'Posle poboljšanja, tvrdoća i metalografija na uzorcima iz svake šarže'],
  },
  applications: ['Sporohodno (izlazno) vratilo opštih dvostepenih cilindričnih reduktora', 'Pogoni tračnih i grabuljastih transportera', 'Kontinualni pogoni srednjeg opterećenja kao što su mešalice i mehanizmi kretanja dizalica'],
  roleInSystem: 'To je poslednja karika izlaza obrtnog momenta u reduktoru: prenosni element (nosi ceo izlazni moment), noseći element (predaje sile sprezanja kućištu) i zaptivna površina (stepenik Ø50 uz semering). Ako bacanje ili kvalitet površine nisu u toleranciji, istovremeno se javljaju tri kvara: veća buka zupčanika, prevremeni otkaz ležaja i curenje ulja na poklopcu.',
  materialsSeen: ['40Cr'],
  risks: [
    { level: 'Visok', item: 'Koncentracija napona na krajevima žleba i radijusima naslona', why: 'Vratilo trpi naizmenično savijanje; oštar ugao umesto radijusa može podići efektivni faktor koncentracije napona sa 1.6 na preko 2.5 i smanjiti granicu zamora za 30%+', suggestion: 'Strogo držati R2 i polirati radijuse, proveravati šablonom; koristiti žlebove sa zaobljenim krajem umesto pravougaonih' },
    { level: 'Srednji', item: 'Ø60r6 i Ø55k6 su naleganja sa preklopom; hladno presovanje oštećuje površine', why: 'Ogrebotine pri presovanju smanjuju preklop i stvaraju začetke zamora', suggestion: 'Zupčanik i ležaje montirati toplo posle indukcionog ili uljnog zagrevanja na 80–100℃; zabranjeno udaranje' },
    { level: 'Srednji', item: 'Spiralni tragovi obrade na rukavcu zaptivača', why: 'Spiralni tragovi „pumpaju" ulje napolje kao zavojnica i izazivaju stalno curenje', suggestion: 'Posle brušenja polirati kružno da tragovi ne budu usmereni, Ra≤0.4' },
    { level: 'Nizak', item: 'Na crtežu nema zahteva za dinamičko uravnoteženje', why: 'Iznad 1500 o/min neuravnoteženost povećava vibracije ležaja', suggestion: 'Dodati klasu uravnoteženja (npr. G6.3) u tehničke zahteve' },
  ],
  improvements: ['Za velike serije zameniti klinastu vezu na Ø60 evolventnim ožlebljenjem ili steznim sklopom, čime se uklanja koncentracija napona žleba i poboljšava centriranje', 'Valjanjem ojačati radijuse naslona i krajeve žlebova; zamorni vek obično raste 30–60%', 'U tehničkim zahtevima navesti „zadržati središnja gnezda" (GB/T 145 B3.15/10) radi ponovnog centriranja pri popravci', 'Opšte klase dimenzionih i geometrijskih tolerancija navesti zajedno pored zaglavlja, da bude manje pitanja u radionici'],
  uncertainties: ['Zapis o reviziji u donjem desnom delu zaglavlja (izmene revizije B) nije čitljiv', 'Deo tehničkog zahteva 3 o obimu indukcionog kaljenja je zamućen; ne može se potvrditi da li je obavezno', 'Nema izričitog pravila za dozvoljeno ispravljanje posle termičke obrade ni za nivo prihvatanja magnetne kontrole'],
  glossary: [
    { term: 'k6', meaning: 'Tolerancijsko polje vratila za prelazno naleganje u sistemu jedinstvenog otvora; uobičajeno za unutrašnje prstene kotrljajnih ležaja' },
    { term: 'N9', meaning: 'Klasa tolerancije širine žleba za tesnu vezu standardnim paralelnim klinom' },
    { term: '⌀ / Ø', meaning: 'Znak prečnika' },
    { term: 'Radijalno bacanje', meaning: 'Najveća promena pokazivanja komparatera dok se element okrene jednom oko bazne ose' },
    { term: 'Ra 0.8', meaning: 'Srednje aritmetičko odstupanje profila 0.8 μm, uobičajena brušena površina' },
    { term: 'C2', meaning: 'Obarač 45°, aksijalna dužina 2mm' },
    { term: '2×0.5', meaning: 'Žleb za izlaz tocila: širina 2mm, dubina 0.5mm' },
    { term: 'B3.15/10', meaning: 'Središnje gnezdo tipa B prema GB/T 145, vodeći otvor Ø3.15, konus Ø10' },
    { term: 'GB/T 1804-m', meaning: 'Srednja klasa opštih linearnih tolerancija' },
  ],
};

EX_I18N.sr.material = {
  materials: [{
    grade: '40Cr', standard: 'GB/T 3077-2015', category: 'Legirani konstrukcioni čelik (hromni čelik)',
    equivalents: [{ system: 'AISI/SAE', grade: '5140' }, { system: 'DIN/EN', grade: '41Cr4 (1.7035)' }, { system: 'JIS', grade: 'SCr440' }, { system: 'ISO', grade: '41Cr4' }, { system: 'UNS', grade: 'G51400' }],
    composition: [
      { element: 'C Ugljenik', range: '0.37 ~ 0.44' }, { element: 'Si Silicijum', range: '0.17 ~ 0.37' },
      { element: 'Mn Mangan', range: '0.50 ~ 0.80' }, { element: 'Cr Hrom', range: '0.80 ~ 1.10' },
      { element: 'P Fosfor', range: '≤ 0.035' }, { element: 'S Sumpor', range: '≤ 0.035' },
    ],
    mechanical: [
      { property: 'Zatezna čvrstoća Rm', value: '≥ 980', unit: 'MPa', condition: 'Kaljenje u ulju 850℃ + otpuštanje 520℃, epruveta Ø25' },
      { property: 'Donja granica tečenja ReL', value: '≥ 785', unit: 'MPa', condition: 'Isto kao gore' },
      { property: 'Izduženje A', value: '≥ 9', unit: '%', condition: 'Isto kao gore' },
      { property: 'Suženje preseka Z', value: '≥ 45', unit: '%', condition: 'Isto kao gore' },
      { property: 'Udarna energija KU2', value: '≥ 47', unit: 'J', condition: 'Isto kao gore' },
      { property: 'Tvrdoća posle poboljšanja', value: '241 ~ 286', unit: 'HBW', condition: 'Prema ovom crtežu' },
      { property: 'Dinamička izdržljivost na savijanje σ₋₁', value: 'oko 350 ~ 420', unit: 'MPa', condition: 'Naizmenični ciklus, glatka epruveta; potvrditi ispitivanjem' },
    ],
    physical: [
      { property: 'Gustina', value: '7.85', unit: 'g/cm³', condition: '20℃' },
      { property: 'Modul elastičnosti E', value: '211', unit: 'GPa', condition: '20℃' },
      { property: 'Poasonov koeficijent μ', value: '0.28', unit: '—', condition: '20℃' },
      { property: 'Toplotna provodljivost', value: '44', unit: 'W/(m·K)', condition: '100℃' },
      { property: 'Koeficijent toplotnog širenja', value: '11.6', unit: '×10⁻⁶/K', condition: '20 ~ 100℃' },
    ],
    heatTreatment: { route: 'Normalizacija 850–870℃ na vazduhu → poboljšanje: kaljenje u ulju 850℃±10℃ + otpuštanje 500–540℃', hardness: 'HB 241–286 (≈ Rm 820–950 MPa)', note: 'Posle otpuštanja brzo ohladiti kroz opseg 400–500℃ da se izbegne krtost pri otpuštanju; posle poboljšanja ispraviti i otpustiti napone na 200℃×2h' },
    processability: {
      machinability: 'Srednja u poboljšanom stanju (HB≤286), oko 85% u odnosu na čelik 45; tvrdi metal, vc 80–120 m/min',
      weldability: 'Loša, ekvivalent ugljenika ≈0.72%; predgrevanje 200–300℃, otpuštanje napona 600–650℃ posle zavarivanja; reparaturno zavarivanje vratila se ne preporučuje',
      formability: 'Dobra za toplo oblikovanje: početak kovanja 1150–1200℃, kraj ≥800℃; loša za hladno oblikovanje',
      corrosion: 'Slaba otpornost na koroziju; neradne površine bruniranje ili ulje, u vlažnoj sredini fosfatiranje ili cinkovanje',
    },
    whyChosen: 'Izlazno vratilo trpi naizmenično kombinovano savijanje i uvijanje, pa su potrebna dobra ukupna mehanička svojstva i određena prokaljivost. 40Cr posle poboljšanja pouzdano dostiže HB241–286 i granicu tečenja ≥785 MPa ispod Ø60, sa zamornom čvrstoćom oko 20–30% većom od čelika 45 i znatno nižom cenom od 42CrMo — standardni izbor za vratila reduktora srednjeg opterećenja.',
    cautions: ['Iznad Ø80 prokaljivost je nedovoljna i svojstva jezgra opadaju — koristiti 42CrMo', 'Sklon krtosti pri otpuštanju; posle otpuštanja brzo hladiti', 'Tragovi alata na žlebovima i radijusima značajno smanjuju zamorni vek; hrapavost mora biti ispunjena', 'Ako se dodaje indukciono kaljenje, meku zonu držati dalje od preseka najvećeg momenta savijanja'],
    alternatives: [
      { grade: 'Čelik 45', tradeoff: 'Oko 20% jeftiniji i lakši za obradu, ali manja zamorna čvrstoća i prokaljivost; samo za laka opterećenja ili velika sporohodna vratila' },
      { grade: '42CrMo', tradeoff: 'Bolja prokaljivost i čvrstoća na povišenoj temperaturi, za preseke iznad Ø80 ili teška udarna opterećenja; oko 30% skuplji, nešto teži za obradu' },
      { grade: '20CrMnTi cementiran', tradeoff: 'Površinska tvrdoća HRC58–62 i mnogo bolja otpornost na habanje, ali zahteva cementaciju i kontrolu dodatka za brušenje; veće deformacije pri termičkoj obradi' },
      { grade: 'QT600-3 nodularni liv', tradeoff: 'Dobro prigušenje vibracija i niska cena, ali nedovoljna čvrstoća i žilavost; samo za mala opterećenja pri malim brzinama ili livene čaure' },
    ],
  }],
  failureModes: [
    { mode: 'Lom usled zamora pri savijanju', where: 'Krajevi žleba za klin, radijusi naslona R2', why: 'Naizmenično savijanje stvara prsline na mestima koncentracije napona koje vremenom rastu; prelomna površina pokazuje linije zamora', control: 'Držati radijus i hrapavost, koristiti žlebove sa zaobljenim krajem, po potrebi valjanje' },
    { mode: 'Frettig habanje (frettig zamor)', where: 'Sedište zupčanika Ø60 i ležajna mesta Ø55', why: 'Pri nedovoljnom preklopu mikroklizanje na naleganju stvara crvenkastosmeđe čestice i začetke prslina', control: 'Obezbediti preklop i čistu montažu; po potrebi pooštriti klasu naleganja' },
    { mode: 'Plastična deformacija uvijanjem', where: 'Stepenik spojnice Ø45 (najmanji presek)', why: 'Vršni moment pri udaru na startu ili blokadi mašine prelazi granicu tečenja', control: 'Proveriti prema vršnom momentu i ugraditi sigurnosnu spojnicu ili ograničivač momenta' },
    { mode: 'Žlebljenje na mestu zaptivača', where: 'Rukavac Ø50', why: 'Dugotrajno trenje usne semeringa sa česticama nečistoće', control: 'Indukciono kaljenje ili tvrdo hromiranje, Ra ≤ 0.4, dodati usnu protiv prašine' },
  ],
  strengthNotes: [
    'Proveriti kritične preseke na kombinovano savijanje i uvijanje: prelazi naslona Ø55/Ø60 i oba preseka sa žlebom',
    'Proveriti nosivost presovanog naleganja zupčanika; preklop birati prema GB/T 5371 i stvarnom porastu temperature',
    'Stepen sigurnosti na zamor iz σ₋₁ i efektivnog faktora koncentracije napona kσ; obično S ≥ 1.5',
    'Krutost: najveći ugib između ležaja ≤ 0.0003L, nagib kod zupčanika ≤ 0.001 rad',
  ],
  sourceNote: 'Mehanička i fizička svojstva su propisane vrednosti GB/T 3077-2015 za epruvete Ø25mm i tipične vrednosti iz priručnika. Stvarni delovi su slabiji od epruveta zbog uticaja veličine preseka; za proračune i prijem koristiti ateste isporučioca i izmerene podatke.',
};

EX_I18N.sr.ocr = {
  titleBlock: [
    { field: 'Naziv', value: 'Izlazno vratilo' }, { field: 'Br. crteža', value: 'JSD-04-02' },
    { field: 'Razmera', value: '1:2' }, { field: 'Materijal', value: '40Cr' },
    { field: 'Kol.', value: '1' }, { field: 'Revizija', value: 'B' },
  ],
  items: [
    { zone: 'Segment 1 (red 1, kolona 1) levi kraj', kind: 'Dimenzija', text: 'Ø45 m6 (+0.025/+0.009)' },
    { zone: 'Segment 2 (red 1, kolona 2) sredina', kind: 'Dimenzija', text: 'Ø55 k6 (+0.021/+0.002)' },
    { zone: 'Segment 2 (red 1, kolona 2) sredina', kind: 'Dimenzija', text: 'Ø60 r6 (+0.060/+0.041)' },
    { zone: 'Segment 3 (red 1, kolona 3) desni kraj', kind: 'Dimenzija', text: 'M36×1.5-6g' },
    { zone: 'Segment 2 gore', kind: 'Geometrijska tolerancija', text: '⌰ | 0.025 | A–B' },
    { zone: 'Segment 4 (red 2, kolona 1)', kind: 'Geometrijska tolerancija', text: '= | 0.02 | A' },
    { zone: 'Segment 2 gore', kind: 'Hrapavost', text: 'Ra 0.8' },
    { zone: 'Segment 5 (red 2, kolona 2)', kind: 'Hrapavost', text: 'Ra 0.4' },
    { zone: 'Segment 4, presek A–A', kind: 'Dimenzija', text: '14 N9 (0/−0.043), t = 5.5' },
    { zone: 'Segment 5, presek B–B', kind: 'Dimenzija', text: '18 N9 (0/−0.043), t = 7.0' },
    { zone: 'Segment 1 dole', kind: 'Dimenzija', text: '452 ±0.5 (ukupna dužina)' },
    { zone: 'Segment 3, detalj I', kind: 'Napomena', text: 'I  5:1   R2   2×0.5' },
    { zone: 'Segment 6 (red 2, kolona 3)', kind: 'Oznaka pogleda', text: 'A–A    B–B' },
    { zone: 'Segment 1, leva čeona površina', kind: 'Napomena', text: 'Središnja gnezda B3.15/10 GB/T 145 (oba kraja)' },
  ],
  technicalNotes: [
    'Poboljšati na HB241–286.',
    'Neoznačeni obarači C1.5, neoznačeni radijusi R2.',
    'Opšte linearne tolerancije prema GB/T 1804-m; opšte geometrijske tolerancije prema GB/T 1184-K.',
    'Skinuti srh i zaobliti oštre ivice; posle obrade nisu dozvoljene prsline, preklopi i slične greške.',
  ],
  unclear: [
    { zone: 'Zaglavlje, dole desno', what: 'Opis izmene za reviziju B', why: 'Pregib na originalu; potezi se spajaju' },
    { zone: 'Kraj tehničkog zahteva 3', what: 'Obim indukcionog kaljenja', why: 'Bled otisak; poslednjih nekoliko znakova nečitko' },
  ],
  coverage: 'Zaglavlje, glavne dimenzije, geometrijske tolerancije i tehnički zahtevi su u potpunosti prepisani; zapis o reviziji i dva nejasna mesta nisu potvrđeni i navedeni su kao nečitki.',
};
EX_I18N.sr.meta = {
  planText: 'Segmenti 3×2, poslato 7 slika\nDetalj uvećan 2.4× u odnosu na pregled, u izvornoj rezoluciji',
  planNote: '(primer vrednosti — preračunava se prema stvarnoj rezoluciji kada otpremiš fajl)',
  at: 'Primer podataka',
  srcName: 'Primer · radionički crtež izlaznog vratila reduktora',
  srcMeta: [['Crtež', 'Izlazno vratilo reduktora JSD-04-02'], ['Materijal', '40Cr poboljšan HB241–286'], ['Status', 'Ugrađeni primer, zamenjuje se kada otpremiš fajl']],
  svgLabel: 'Primer: skica stepenastog vratila',
  pdfCaption: 'Primer skice · stepenasto vratilo',
  qa: [{
    q: 'Zašto se radijalno bacanje oba ležajna mesta kontroliše u odnosu na zajedničku bazu A–B?',
    a: 'Zato što se vratilo na kraju okreće na dva ležaja u kućištu: da li zupčanik radi „pravo" određuje osa koju zajedno definišu oba ležajna mesta, a ne bilo koji pojedinačni prečnik.\nAko bi baza bila samo jedan kraj, greška na drugom kraju bi se uvećala na sedištu zupčanika, što se posle montaže vidi kao bacanje čela zupčanika, buka sprezanja i zagrevanje ležaja.\nZajednička baza A–B ima i tehnološko značenje: pri kontroli deo mora da leži na dve V-prizme ili između dva šiljka i da se meri komparaterom, isto kao što je stvarno oslonjen u kućištu — samo tada izmerene vrednosti imaju smisla.',
  }],
};

EX_I18N.sr.eng = {
  optimizations: [
    { target: 'Konstrukcija · klinasta veza na Ø60', current: 'Jedan klin prenosi moment; kraj žleba je najjače mesto koncentracije napona na celom vratilu i većina zamornih prslina kreće odatle', proposal: 'Zameniti evolventnim ožlebljenjem (npr. INV 28×1.5×18×7H/7e) ili steznim sklopom (npr. tip Z2), bez žleba za klin', benefit: 'Efektivni faktor koncentracije napona pada sa ≈2.1 na 1.3–1.5, zamorni vek obično +30–60%; bolje centriranje i manja buka zupčanika', cost: 'Ožlebljenje zahteva posebno odvalno glodalo ili dubilicu, cena komada ≈+15%; stezni sklop zahteva veću glavčinu', effort: 'Srednji', priority: 'Visok' },
    { target: 'Tehnologija · radijusi naslona i žlebovi za izlaz tocila', current: 'Propisani samo R2 i 2×0.5, bez površinskog ojačanja', proposal: 'Valjanjem ojačati oba radijusa naslona i krajeve žlebova (800–1200 N za Ø60, pomak 0.15 mm/o, 2 prolaza)', benefit: 'Sloj zaostalih pritisnih napona 0.3–0.6 mm; dinamička izdržljivost na savijanje +20–40%', cost: 'Jedna dodatna operacija, ≈1.5 min po komadu, potreban alat za valjanje', effort: 'Nizak', priority: 'Visok' },
    { target: 'Tolerancija · rukavac zaptivača Ø50', current: 'h9 uz Ra0.4, bez propisanog pravca tragova i tvrdoće', proposal: 'Dodati „posle brušenja polirati bez usmerenih tragova, spiralni tragovi nisu dozvoljeni" i, zavisno od uslova rada, indukciono kaliti na HRC45–50', benefit: 'Uklanja najčešću reklamaciju zbog curenja na poklopcu; kaljenje znatno odlaže žlebljenje na mestu zaptivača', cost: 'Indukciono kaljenje povećava trošak opreme i kontrole, ≈¥8 po komadu', effort: 'Nizak', priority: 'Srednji' },
    { target: 'Pripremak · način sečenja', current: 'Toplovaljana šipka Ø70×460 sa velikim dodatkom za struganje', proposal: 'Iznad 500 komada preći na otkivke iz kalupa, stepen kovanja ≥3, vlakna duž ose', benefit: 'Iskorišćenje materijala sa ≈45% na preko 70%, zamorna čvrstoća dodatnih +10–20%', cost: 'Potreban alat; cenu komada treba izračunati prema veličini serije', effort: 'Visok', priority: 'Srednji' },
  ],
  dfm: [
    { issue: 'Oba ležajna mesta traže bacanje 0.025 prema zajedničkoj bazi, ali crtež ne kaže da li se središnja gnezda zadržavaju', impact: 'Ako radionica posle finog struganja ukloni gnezda, deo se ne može brusiti između šiljaka i bacanje se teško postiže', fix: 'U tehničke zahteve upisati „zadržati središnja gnezda GB/T 145 B3.15/10, ne uklanjati"' },
    { issue: 'Za simetričnost žleba 0.02 nije definisan način uspostavljanja baze', impact: 'Različite smene mere na različite načine i rezultati ponovne kontrole se ne slažu', fix: 'Navesti „baza iz oba središnja gnezda, merenje na V-prizmama komparaterom"' },
    { issue: 'Navoj M36×1.5 je odmah do ležajnog mesta Ø55k6, bez žleba za izlaz navoja', impact: 'Izlaz navoja može zadreti u ležajno mesto i blokirati montažu', fix: 'Dodati žleb 3×1 ili propisati dužinu izlaza navoja' },
  ],
  toleranceStack: [
    { chain: 'Aksijalno pozicioniranje zupčanika: čelo naslona → glavčina zupčanika → distancer → unutrašnji prsten ležaja', concern: 'Zbir tolerancija dužina može ostaviti više od 0.1 mm aksijalnog zazora između zupčanika i ležaja', action: 'Dužine u lancu pozicioniranja kotirati od jedne baze i proračunati dimenzioni lanac za ukupnu dužinu i položaj naslona' },
    { chain: 'Preklop Ø60r6 prema otvoru zupčanika H7', concern: 'Pri najmanjem preklopu od 0.020 mm moment trenja možda neće preneti vršni moment, što izaziva frettig', action: 'Proračunati najmanji preklop prema GB/T 5371; po potrebi preći na s6 ili produžiti naleganje' },
  ],
  calculations: [
    { item: 'Čvrstoća kritičnih preseka na kombinovano savijanje i uvijanje', formula: 'σca = √(σb² + 4τ²) ≤ [σ-1], na prelazu naslona Ø55/Ø60 i presecima sa žlebom', input: 'Izlazni moment T, podeoni prečnik zupčanika, razmak ležaja, radijalne i aksijalne sile', criterion: 'Stepen sigurnosti S ≥ 1.5' },
    { item: 'Provera zamorne čvrstoće', formula: 'Sσ = σ-1 /(kσ·σa/εσ/β + ψσ·σm)', input: 'σ-1 ≈ 350–420 MPa, efektivni faktor koncentracije napona kσ, faktor veličine εσ, faktor površine β', criterion: 'Sσ ≥ 1.5, posebno za radijuse i žlebove' },
    { item: 'Nosivost presovanog naleganja', formula: 'Mf = π·d²·L·p·f/2', input: 'Dodirni pritisak p pri najmanjem preklopu, koeficijent trenja f 0.12–0.15, dužina naleganja L', criterion: 'Mf ≥ 1.5 × nazivni moment' },
    { item: 'Krutost vratila i ugib', formula: 'Ugib y i nagib θ kod zupčanika metodom superpozicije za prosto oslonjenu gredu', input: 'E=211 GPa, momenti inercije stepenika, raspodela opterećenja', criterion: 'y ≤ 0.0003L, θ ≤ 0.001 rad' },
  ],
  verification: {
    objective: 'Potvrditi zamorni vek, pouzdanost naleganja i zaptivanje pri nazivnom i preopterećenju, i proveriti da tolerancije i termička obrada sa crteža obezbeđuju projektovani vek',
    specimens: '6 serijskih vratila iz iste šarže poboljšanja (3 za zamor celog vratila, 2 za metalografiju i tvrdoću, 1 rezerva), plus 3 standardne epruvete Ø10 za zatezanje',
    equipment: ['Servohidraulična mašina za zamor (≥100 kN·m uvijanje ili ±50 kN savijanje)', 'Uređaj sa šiljcima i induktivnim meračem (rezolucija 1 μm)', 'Profilometar (opseg Ra 0.05–10 μm)', 'Tvrdomer po Rokvelu/Brinelu', 'Metalografski mikroskop', 'Uređaj za magnetnu kontrolu', 'Probni sto za zaptivače (sa regulacijom temperature i brzine)'],
    steps: [
      { no: 1, action: 'Ulazna i geometrijska kontrola', condition: 'Sobna temperatura 20±5℃', record: 'Prečnici stepenika, bacanje, simetričnost žleba, hrapavost', criterion: 'Sve prema crtežu, bacanje ≤0.025' },
      { no: 2, action: 'Potvrda kvaliteta poboljšanja', condition: 'Uzorak iz svake šarže', record: 'Tvrdoća površine i jezgra, mikrostruktura, dubina razugljeničenja', criterion: 'HB241–286, otpušteni sorbit, razugljeničenje ≤0.1 mm' },
      { no: 3, action: 'Magnetna kontrola', condition: 'Kružno i uzdužno magnetisanje', record: 'Položaj i veličina grešaka', criterion: 'Bez linijskih indikacija na radijusima i žlebovima' },
      { no: 4, action: 'Ispitivanje zamora pri rotacionom savijanju', condition: 'Po jedno vratilo na 1.0 / 1.2 / 1.4 × nazivna amplituda napona, 3000 o/min', record: 'Broj ciklusa, mesto nastanka prsline, izgled preloma', criterion: '≥1×10⁷ ciklusa bez otkaza pri nazivnom opterećenju' },
      { no: 5, action: 'Montaža i demontaža presovanog naleganja', condition: 'Zupčanik zagrejan na 90±10℃ i navučen, demontaža posle 100 h rada', record: 'Sila utiskivanja, tragovi frettinga, stvarni preklop', criterion: 'Bez crvenkastosmeđih čestica, ogrebotine ≤2% površine naleganja' },
      { no: 6, action: 'Ispitivanje zaptivača na probnom stolu', condition: 'Rukavac Ø50, 1500 o/min, ulje 80℃, 500 h neprekidno', record: 'Curenje, dubina habanja rukavca, stanje usne zaptivača', criterion: 'Bez vidljivog curenja, habanje rukavca ≤0.02 mm' },
    ],
    measurements: [
      { item: 'Bacanje oba ležajna mesta prema zajedničkoj bazi', method: 'Između šiljaka + komparater', tolerance: '≤0.025 mm' },
      { item: 'Simetričnost žleba za klin', method: 'V-prizma + metoda okretanja uz komparater', tolerance: '≤0.02 mm' },
      { item: 'Hrapavost i tragovi na rukavcu zaptivača', method: 'Profilometar + mikroskop 30×', tolerance: 'Ra ≤0.4 μm, bez spiralnih tragova' },
      { item: 'Tvrdoća posle poboljšanja', method: 'Tvrdomer po Brinelu, po 3 tačke na čelu i u sredini', tolerance: 'HB 241–286' },
      { item: 'Preklop naleganja', method: 'Pre montaže posebno izmeriti vratilo i otvor, uzeti razliku', tolerance: 'U proračunskom opsegu za Ø60 H7/r6' },
    ],
    safety: ['Ogradi prostor za ispitivanje zamora — epruveta može odleteti pri lomu', 'Pri toploj montaži koristiti rukavice otporne na toplotu i namenski pribor za podizanje; zupčanik nikada ne pridržavati rukom', 'Na vrućem uljnom krugu probnog stola predvideti rasterećenje pritiska i posudu za kapanje; bez otvorenog plamena u zoni ispitivanja'],
    schedule: 'Kontrola geometrije i materijala 1 nedelja; ispitivanja zamora 3–5 nedelja (zavisi od broja ciklusa); probni sto za zaptivače 3 nedelje; paralelno ukupno ≈6 nedelja uz 2 tehničara',
  },
  costNotes: [
    'Materijal čini ≈35% cene komada, mašinska obrada ≈45%, termička obrada ≈12%; optimizaciju usmeriti na skraćenje brušenja, a ne na promenu materijala',
    'Ispod 200 komada šipka je i dalje najjeftinija; iznad 500 komada otkivci su povoljniji po ukupnom trošku',
  ],
  standardsToCheck: [
    { standard: 'GB/T 1800.2-2020', clause: 'Tablice graničnih odstupanja za k6 / r6 / m6', why: 'Proveriti da li odstupanja na crtežu odgovaraju standardu' },
    { standard: 'GB/T 1095-2003 / GB/T 1096-2003', clause: 'Dimenzije i tolerancije paralelnih klinova i žlebova', why: 'Potvrditi da širine i dubine 18N9 i 14N9 odgovaraju vrsti naleganja klina' },
    { standard: 'GB/T 3077-2015', clause: 'Mehanička svojstva i stanje isporuke za 40Cr', why: 'Potvrditi opseg tvrdoće posle poboljšanja i korekciju zbog veličine preseka' },
  ],
  openIssues: [
    'Stvarni spektar momenta i faktor udara pri pokretanju nisu poznati, a direktno utiču na zaključak o zamoru — zatražiti spektar opterećenja od proizvođača mašine',
    'Da li je indukciono kaljenje obavezno nije jasno zbog zamućenog teksta; projektant mora da potvrdi',
    'Za neradne površine nije naveden zahtev za antikorozionu zaštitu ili premaz',
  ],
};

const EX_DRAWING = {
  docType: '零件图', confidence: 88,
  titleBlock: { title: '输出轴', drawingNo: 'JSD-04-02', scale: '1:2', projection: '第一角法', material: '40Cr', quantity: '1', unit: 'mm', standard: 'GB/T 1800.2-2020、GB/T 1184-1996', revision: 'B', org: '示例图纸', date: '—' },
  oneLiner: '二级圆柱齿轮减速器的低速级输出轴：把大齿轮传来的扭矩经平键送到联轴器，同时由两端滚动轴承承受径向载荷。',
  summary: '这是一张典型的阶梯轴零件图，采用一个基本视图（轴线水平）加两个移出断面和一处局部放大表达。\n七段阶梯从两端向中间逐级增大，形成轴肩用于齿轮和轴承的轴向定位；直径最大的 Ø60 段安装大齿轮，两侧 Ø55 段安装圆锥滚子轴承，Ø45 外伸端接联轴器。\n技术要求集中在三处：两个轴承位的公共基准圆跳动 0.025、键槽对称度 0.02、密封轴颈 Ra0.4。\n材料 40Cr 整体调质 HB241~286，磨削后交付。',
  keywords: ['阶梯轴', '40Cr 调质', '平键连接', '圆锥滚子轴承', '轴肩定位', 'H7/k6', '圆跳动 0.025', '砂轮越程槽'],
  views: [
    { name: '主视图（轴线水平）', type: '基本视图', describes: '七段阶梯的轴向尺寸链、各段直径、倒角、砂轮越程槽与螺纹端' },
    { name: 'A—A 移出断面', type: '移出断面图', describes: 'Ø45 联轴器段上的平键键槽 14N9，槽深 t=5.5' },
    { name: 'B—B 移出断面', type: '移出断面图', describes: 'Ø60 齿轮配合段上的平键键槽 18N9，槽深 t=7.0' },
    { name: 'I 局部放大 5:1', type: '局部放大图', describes: '轴肩过渡圆角 R2 与砂轮越程槽 2×0.5 的细节' },
  ],
  components: [],
  features: [
    { name: '轴肩 Ø68', spec: '高 4mm', purpose: '给齿轮和轴承内圈提供轴向定位面，承受轴向力并保证装配位置' },
    { name: '砂轮越程槽', spec: '2×0.5', purpose: '磨削时让砂轮退出，避免根部磨不到而留下台阶与应力集中' },
    { name: '平键键槽', spec: '18N9×7.0 / 14N9×5.5', purpose: '用普通平键传递扭矩，N9 为较紧的配合公差带' },
    { name: '中心孔', spec: 'B3.15/10 GB/T 145', purpose: '车削与磨削的统一定位基准，也便于日后返修找正' },
    { name: '倒角', spec: 'C2 / C1.5', purpose: '便于轴承与齿轮压入、去毛刺，防止装配划伤配合面' },
    { name: '过渡圆角', spec: 'R2', purpose: '降低轴肩处应力集中，是疲劳寿命的关键' },
    { name: '锁紧螺纹', spec: 'M36×1.5-6g', purpose: '用圆螺母加止动垫圈锁紧轴承内圈' },
  ],
  principle: {
    designIntent: '轴系按"中间粗、两端细"的等强度思路布置：最大弯矩出现在齿轮处，所以 Ø60 段直径最大；向两端逐级减小既方便零件从两头装入，又让每个零件都有独立的轴向定位面。所有配合段的公差带都按"轴承内圈用 k6、齿轮用 r6、联轴器用 m6"的惯例选取，装配时靠过盈和键共同传扭。',
    workingPrinciple: '电动机经两级齿轮降速后，扭矩由大齿轮轮毂通过 18N9 平键传到 Ø60 轴段；轴被两端的圆锥滚子轴承支承，径向力由轴承传给箱体，轴向力由轴肩和圆螺母承担；扭矩最终从 Ø45 外伸端经联轴器输出。Ø50 段与骨架油封配合，阻止箱体内润滑油外泄。',
    motionFlow: ['大齿轮轮毂', '18N9 平键', 'Ø60 轴段', '轴体', 'Ø45 外伸端键连接', '联轴器', '工作机'],
    loadPath: ['齿轮啮合力', '键与过盈配合面', '轴的弯扭复合截面', '两端轴承位 Ø55k6', '轴承', '箱体座孔'],
  },
  dimensions: [
    { feature: '轴承位（两处）', nominal: 'Ø55', tolerance: 'k6 (+0.021/+0.002)', fit: '与 P0 级轴承内圈', note: '过渡偏过盈配合，防止内圈跑圈' },
    { feature: '齿轮配合段', nominal: 'Ø60', tolerance: 'r6 (+0.060/+0.041)', fit: 'H7/r6', note: '过盈配合，与键共同传扭' },
    { feature: '联轴器段', nominal: 'Ø45', tolerance: 'm6 (+0.025/+0.009)', fit: 'H7/m6', note: '便于拆装的过渡配合' },
    { feature: '油封轴颈', nominal: 'Ø50', tolerance: 'h9 (0/−0.062)', fit: '与骨架油封唇口', note: '尺寸公差松，靠粗糙度与圆度保证密封' },
    { feature: '轴肩', nominal: 'Ø68', tolerance: '未注公差 GB/T 1804-m', fit: '—', note: '定位端面，垂直度由跳动间接控制' },
    { feature: '键槽宽（Ø60 段）', nominal: '18', tolerance: 'N9 (0/−0.043)', fit: '普通平键较紧连接', note: '槽深 t=7.0，量法为 Ø60−t' },
    { feature: '全长', nominal: '452', tolerance: '±0.5', fit: '—', note: '两端面为磨削基准' },
  ],
  gdt: [
    { symbol: '圆跳动', feature: 'Ø60 齿轮配合面', value: '0.025', datum: 'A—B 公共基准', meaning: '控制齿轮安装面相对两轴承轴线的偏摆，直接影响齿轮啮合精度与噪声' },
    { symbol: '圆跳动', feature: 'Ø50 油封轴颈', value: '0.04', datum: 'A—B', meaning: '跳动过大会周期性顶开油封唇口造成漏油' },
    { symbol: '对称度', feature: '键槽中心平面', value: '0.02', datum: 'Ø45 轴线', meaning: '保证键两侧受力均匀，避免单侧压溃' },
    { symbol: '平行度', feature: '键槽侧面', value: '0.02/100', datum: '轴线', meaning: '防止键装入后歪斜别劲' },
  ],
  surfaces: [
    { feature: '轴承位 Ø55k6', roughness: 'Ra 0.8', process: '磨削' },
    { feature: '齿轮配合 Ø60r6', roughness: 'Ra 0.8', process: '磨削' },
    { feature: '油封轴颈 Ø50', roughness: 'Ra 0.4', process: '磨削后无方向性抛光' },
    { feature: '键槽侧面', roughness: 'Ra 3.2', process: '立铣或插削' },
    { feature: '非配合外圆与端面', roughness: 'Ra 6.3', process: '车削' },
  ],
  manufacturing: {
    blank: '热轧圆钢 Ø70×460；批量生产时建议改用模锻件，使金属纤维沿轴向连续，疲劳强度更高',
    processes: ['下料 Ø70×460', '粗车两端面、钻中心孔 B3.15/10', '粗车各段外圆，单边留量 2.5mm', '调质：850℃油淬 + 520℃回火，HB241~286', '修研中心孔', '半精车各段外圆留磨量 0.4mm，车越程槽与倒角', '铣（插）两处键槽', '车 M36×1.5 螺纹', '去毛刺、清洗、校直', '磨削 Ø55k6、Ø60r6、Ø50 及各定位端面', '终检与防锈包装'],
    heatTreatment: '整体调质 HB241~286；若使用工况多尘或转速高，可对 Ø50 油封颈高频淬火 HRC45~50、硬化层深 1.0~1.5mm',
    keyDifficulties: ['两处轴承位的公共基准圆跳动 0.025，必须以两中心孔定位一次装夹磨出', '键槽对称度 0.02 需专用分度夹具或找正后加工', '轴肩圆角 R2 与越程槽是疲劳危险截面，不允许有刀痕、磕碰和清角'],
    inspection: ['外径用外径千分尺配合电感量仪抽检', '圆跳动在偏摆仪上以两中心孔（或 V 形铁）定位打表', '键槽宽用塞规、对称度用打表翻转法', '粗糙度用轮廓仪或比较样块', '调质后按炉取样测硬度并做金相检查'],
  },
  applications: ['通用二级圆柱齿轮减速器的低速（输出）轴', '带式输送机、刮板机的驱动装置', '搅拌设备、起重机运行机构等中等载荷连续传动场合'],
  roleInSystem: '它是减速器里扭矩输出的最后一环：既是传动件（承担全部输出扭矩），又是支承件（把齿轮的啮合力交给箱体），还是密封界面（Ø50 段与油封配合）。一旦它的跳动或表面质量不达标，会同时表现为齿轮噪声增大、轴承早期失效和端盖漏油三类故障。',
  materialsSeen: ['40Cr'],
  risks: [
    { level: '高', item: '键槽端部与轴肩圆角的应力集中', why: '轴承受对称循环弯曲，若圆角做成清角，有效应力集中系数可从 1.6 升到 2.5 以上，疲劳极限下降 30% 以上', suggestion: '严格保证 R2 圆角并磨光，用圆角样板检验；键槽端部采用圆头（盘铣）而非方头' },
    { level: '中', item: 'Ø60r6 与 Ø55k6 属过盈方向配合，冷压装配易拉伤', why: '压装时配合面产生划痕，既降低过盈量又形成疲劳源', suggestion: '齿轮与轴承采用感应加热或油浴加热至 80~100℃ 热装，禁止锤击' },
    { level: '中', item: '油封轴颈若留下螺旋状加工纹路', why: '螺旋纹会像螺杆一样把油"泵"出去，造成持续渗漏', suggestion: '磨削后沿圆周方向抛光，保证无方向性纹路，Ra≤0.4' },
    { level: '低', item: '图面未见动平衡要求', why: '若实际转速超过 1500 r/min，不平衡量会加剧轴承振动', suggestion: '在技术要求中补充动平衡等级（如 G6.3）' },
  ],
  improvements: ['大批量时把 Ø60 段的键连接改为渐开线花键或胀紧套，可消除键槽应力集中并提高对中性', '对轴肩圆角与键槽端部做滚压强化，疲劳寿命通常可提高 30%~60%', '在技术要求中明确"保留中心孔"（GB/T 145 B3.15/10），便于返修时重新找正', '把未注公差等级与未注几何公差等级在标题栏附近统一标出，减少车间询问'],
  uncertainties: ['标题栏右下角的更改记录（版本 B 的更改内容）分辨不清', '技术要求第 3 条关于高频淬火的适用范围文字部分模糊，无法确认是否为必选项', '未见热处理后校直量与磁粉探伤验收等级的具体规定'],
  glossary: [
    { term: 'k6', meaning: '基孔制中轴的过渡配合公差带，滚动轴承内圈与轴的常用配合' },
    { term: 'N9', meaning: '键槽宽度的公差带代号，对应普通平键的较紧连接' },
    { term: '⌀ / Ø', meaning: '直径符号' },
    { term: '圆跳动', meaning: '被测要素绕基准轴线回转一周时，指示器读数的最大变动量' },
    { term: 'Ra 0.8', meaning: '轮廓算术平均偏差 0.8 μm，磨削可达到的常见等级' },
    { term: 'C2', meaning: '45° 倒角，轴向长度 2mm' },
    { term: '2×0.5', meaning: '砂轮越程槽：宽 2mm、深 0.5mm' },
    { term: 'B3.15/10', meaning: 'GB/T 145 规定的 B 型中心孔，导向孔 Ø3.15、外锥 Ø10' },
    { term: 'GB/T 1804-m', meaning: '未注线性尺寸公差的中等级别' },
  ],
};

const EX_MATERIAL = {
  materials: [{
    grade: '40Cr', standard: 'GB/T 3077-2015', category: '合金结构钢（铬钢）',
    equivalents: [{ system: 'AISI/SAE', grade: '5140' }, { system: 'DIN/EN', grade: '41Cr4 (1.7035)' }, { system: 'JIS', grade: 'SCr440' }, { system: 'ISO', grade: '41Cr4' }, { system: 'UNS', grade: 'G51400' }],
    composition: [
      { element: 'C 碳', range: '0.37 ~ 0.44' }, { element: 'Si 硅', range: '0.17 ~ 0.37' },
      { element: 'Mn 锰', range: '0.50 ~ 0.80' }, { element: 'Cr 铬', range: '0.80 ~ 1.10' },
      { element: 'P 磷', range: '≤ 0.035' }, { element: 'S 硫', range: '≤ 0.035' },
    ],
    mechanical: [
      { property: '抗拉强度 Rm', value: '≥ 980', unit: 'MPa', condition: '850℃油淬 + 520℃回火，Ø25 试样' },
      { property: '下屈服强度 ReL', value: '≥ 785', unit: 'MPa', condition: '同上' },
      { property: '断后伸长率 A', value: '≥ 9', unit: '%', condition: '同上' },
      { property: '断面收缩率 Z', value: '≥ 45', unit: '%', condition: '同上' },
      { property: '冲击吸收能量 KU2', value: '≥ 47', unit: 'J', condition: '同上' },
      { property: '调质后硬度', value: '241 ~ 286', unit: 'HBW', condition: '本图技术要求' },
      { property: '弯曲疲劳极限 σ₋₁', value: '约 350 ~ 420', unit: 'MPa', condition: '对称循环、光滑试样，需试验确认' },
    ],
    physical: [
      { property: '密度', value: '7.85', unit: 'g/cm³', condition: '20℃' },
      { property: '弹性模量 E', value: '211', unit: 'GPa', condition: '20℃' },
      { property: '泊松比 μ', value: '0.28', unit: '—', condition: '20℃' },
      { property: '热导率', value: '44', unit: 'W/(m·K)', condition: '100℃' },
      { property: '线膨胀系数', value: '11.6', unit: '×10⁻⁶/K', condition: '20 ~ 100℃' },
    ],
    heatTreatment: { route: '正火 850~870℃ 空冷 → 调质：850℃±10℃ 油淬 + 500~540℃ 回火', hardness: 'HB 241~286（约相当于 Rm 820~950 MPa）', note: '回火后须快冷通过 400~500℃ 区间以避免第二类回火脆性；调质后校直并做 200℃×2h 去应力回火' },
    processability: {
      machinability: '调质态（HB≤286）切削性中等，相对 45 钢约 85%；建议硬质合金刀具，vc 80~120 m/min',
      weldability: '较差，碳当量约 0.72%，焊前需 200~300℃ 预热、焊后 600~650℃ 消应力；轴类零件不推荐焊接修复',
      formability: '热成形性good：始锻 1150~1200℃、终锻 ≥800℃；冷成形性差',
      corrosion: '耐蚀性差，非工作面需发黑或涂防锈油，潮湿环境建议磷化或镀锌',
    },
    whyChosen: '输出轴承受弯扭复合的交变载荷，要求综合力学性能与一定淬透性。40Cr 调质后在 Ø60 以下截面可稳定获得 HB241~286 与 ≥785 MPa 屈服强度，疲劳强度比 45 钢高约 20%~30%，价格却远低于 42CrMo，是中等载荷减速器轴的标准选择。',
    cautions: ['截面超过 Ø80 时淬透性不足，心部性能明显下降，应改用 42CrMo', '存在第二类回火脆性，回火后必须快冷', '键槽与圆角处的刀痕会显著降低疲劳寿命，粗糙度必须达标', '若叠加高频淬火，注意软带位置避开最大弯矩截面'],
    alternatives: [
      { grade: '45 钢', tradeoff: '便宜约 20%、易加工，但疲劳强度与淬透性低，只适合轻载或大直径低速轴' },
      { grade: '42CrMo', tradeoff: '淬透性与高温强度更好，适合 Ø80 以上大截面或重载冲击工况，成本高约 30%，加工性略差' },
      { grade: '20CrMnTi 渗碳淬火', tradeoff: '表面硬度可达 HRC58~62，耐磨性远高，但需渗碳工艺与磨削余量控制，热处理变形大' },
      { grade: 'QT600-3 球墨铸铁', tradeoff: '减振性好、成本低，但强度与冲击韧性不足，仅适用于低速轻载或改为铸造轴套结构' },
    ],
  }],
  failureModes: [
    { mode: '弯曲疲劳断裂', where: '键槽端部、轴肩 R2 圆角处', why: '交变弯曲应力在应力集中处萌生裂纹并逐步扩展，断口有明显贝纹线', control: '保证圆角半径与表面粗糙度，采用圆头键槽，必要时滚压强化' },
    { mode: '微动磨损（微动疲劳）', where: 'Ø60 齿轮配合段与 Ø55 轴承位', why: '过盈量不足时配合面产生微米级往复滑移，形成红褐色磨屑并诱发裂纹', control: '保证配合过盈与装配清洁，必要时提高一级公差带' },
    { mode: '扭转塑性变形', where: 'Ø45 联轴器最小截面', why: '启动冲击或工作机堵转时峰值扭矩超过屈服强度', control: '按峰值扭矩校核并设置安全联轴器或限矩装置' },
    { mode: '油封处磨出沟槽', where: 'Ø50 轴颈', why: '油封唇口与污染颗粒长期摩擦', control: '高频淬火或镀硬铬，控制 Ra ≤ 0.4，加装防尘唇' },
  ],
  strengthNotes: [
    '按弯扭合成应力校核危险截面：轴肩 Ø55/Ø60 过渡处与两处键槽截面',
    '校核齿轮与轴的过盈配合传扭能力，过盈量按 GB/T 5371 与实际温升选取',
    '疲劳安全系数按 σ₋₁ 与有效应力集中系数 kσ 计算，一般要求 S ≥ 1.5',
    '刚度校核：轴承跨距内最大挠度 ≤ 0.0003L，齿轮安装处偏转角 ≤ 0.001 rad',
  ],
  sourceNote: '力学与物理性能取自 GB/T 3077-2015 对 Ø25mm 试样的规定值及常用工程手册典型值。实际零件受截面尺寸效应影响会低于试样值，设计校核与验收请以供方质保书和实测数据为准。',
};

const EX_SVG = '<svg class="demo" viewBox="-10 -6 440 140" width="100%" aria-label="示例：阶梯轴示意">' +
  '<g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">' +
  '<path d="M0 49 H40 V43 H95 V39 H150 V35 H250 V39 H305 V43 H360 V49 H400 V81 H360 V87 H305 V91 H250 V95 H150 V91 H95 V87 H40 V81 H0 Z"/>' +
  '<rect x="176" y="35" width="52" height="7"/>' +
  '<path d="M40 43 V87 M95 39 V91 M150 35 V95 M250 35 V95 M305 39 V91 M360 43 V87" stroke-width=".7"/>' +
  '</g>' +
  '<path d="M-8 65 H408" stroke="currentColor" stroke-width=".7" stroke-dasharray="10 3 2 3" fill="none"/>' +
  '<g stroke="currentColor" stroke-width=".7" fill="none"><path d="M0 100 V118 M400 100 V118 M4 114 H396"/>' +
  '<path d="M4 114 l6 -2.4 v4.8 Z M396 114 l-6 -2.4 v4.8 Z" fill="currentColor"/></g>' +
  '<text x="200" y="110" text-anchor="middle" font-size="11" font-family="IBM Plex Mono, monospace" fill="currentColor">452</text>' +
  '<text x="202" y="30" text-anchor="middle" font-size="9.5" font-family="IBM Plex Mono, monospace" fill="currentColor">18N9</text>' +
  '</svg>';

const EX_ENG = {
  optimizations: [
    { target: '结构 · Ø60 段键连接', current: '单键传扭，键槽端部是整根轴上应力集中最严重的位置，疲劳裂纹多从这里起', proposal: '改用渐开线花键（如 INV 28×1.5×18×7H/7e）或胀紧套（如 Z2 型）传扭，取消键槽', benefit: '有效应力集中系数由约 2.1 降到 1.3~1.5，疲劳寿命通常提高 30%~60%；同时提高对中性，降低齿轮噪声', cost: '花键需专用滚刀或插齿，单件成本上升约 15%；胀紧套需要加大轮毂尺寸', effort: '中', priority: '高' },
    { target: '工艺 · 轴肩圆角与越程槽', current: '仅要求 R2 与 2×0.5，未规定表面强化', proposal: '对两处轴肩圆角与键槽端部增加滚压强化（滚压力按 Ø60 取 800~1200 N，进给 0.15 mm/r，2 遍）', benefit: '表层形成 0.3~0.6 mm 残余压应力层，弯曲疲劳极限可提高 20%~40%', cost: '增加一道工序，单件约 1.5 min，需滚压工具', effort: '低', priority: '高' },
    { target: '公差 · Ø50 油封轴颈', current: 'h9 配 Ra0.4，未规定纹理方向与硬度', proposal: '补充"磨后无方向性抛光、不允许螺旋纹"，并按工况选择是否高频淬火 HRC45~50', benefit: '直接消除最常见的端盖渗油投诉；硬化后油封处磨损沟槽出现时间显著推后', cost: '高频淬火增加设备与检验成本，约 8 元/件', effort: '低', priority: '中' },
    { target: '毛坯 · 下料方式', current: '热轧圆钢 Ø70×460，车削去除量大', proposal: '批量 500 件以上改模锻件，锻造比 ≥3，纤维沿轴向连续', benefit: '材料利用率由约 45% 提高到 70% 以上，疲劳强度再提高 10%~20%', cost: '需开模，摊销后单件成本需按批量核算', effort: '高', priority: '中' },
  ],
  dfm: [
    { issue: '两处轴承位要求公共基准跳动 0.025，但图上未指明是否保留中心孔', impact: '车间若在精车后车掉中心孔，磨削时无法用两顶尖定位，跳动很难保证', fix: '在技术要求中明确"保留 GB/T 145 B3.15/10 中心孔，不得去除"' },
    { issue: '键槽对称度 0.02 未指明检测基准的建立方式', impact: '不同班组用不同找正方法，复检结果会打架', fix: '注明"以两端中心孔建立基准，V 形块打表法检测"' },
    { issue: 'M36×1.5 螺纹与 Ø55k6 轴承位相邻，未标退刀槽', impact: '螺纹车削收尾处可能干涉轴承位，造成装配顶死', fix: '补画 3×1 退刀槽或明确螺纹收尾长度' },
  ],
  toleranceStack: [
    { chain: '齿轮轴向定位：轴肩端面 → 齿轮轮毂 → 挡圈 → 轴承内圈', concern: '各段长度公差累积后，齿轮与轴承之间可能出现 0.1 mm 以上的轴向间隙', action: '把定位链上的长度尺寸改为同一基准标注，并对总长与轴肩位置做尺寸链校核' },
    { chain: 'Ø60r6 过盈量与齿轮内孔 H7', concern: '最小过盈 0.020 mm 时，传递峰值扭矩的摩擦力矩可能不足，导致微动磨损', action: '按 GB/T 5371 核算最小过盈，必要时改为 s6 或增大接触长度' },
  ],
  calculations: [
    { item: '危险截面弯扭合成强度校核', formula: 'σca = √(σb² + 4τ²) ≤ [σ-1]，取轴肩 Ø55/Ø60 过渡处与键槽截面', input: '输出扭矩 T、齿轮分度圆直径、轴承跨距、径向与轴向力', criterion: '安全系数 S ≥ 1.5' },
    { item: '疲劳强度校核', formula: 'Sσ = σ-1 /(kσ·σa/εσ/β + ψσ·σm)', input: 'σ-1 ≈ 350~420 MPa、有效应力集中系数 kσ、尺寸系数 εσ、表面质量系数 β', criterion: 'Sσ ≥ 1.5，圆角与键槽处分别计算' },
    { item: '过盈配合传扭能力', formula: 'Mf = π·d²·L·p·f/2', input: '最小过盈对应的接触压力 p、摩擦系数 f 取 0.12~0.15、配合长度 L', criterion: 'Mf ≥ 1.5 倍额定扭矩' },
    { item: '轴系刚度与挠度', formula: '按简支梁叠加法计算齿轮处挠度 y 与偏转角 θ', input: 'E=211 GPa、各段惯性矩、载荷分布', criterion: 'y ≤ 0.0003L，θ ≤ 0.001 rad' },
  ],
  verification: {
    objective: '验证该轴在额定与过载工况下的疲劳寿命、配合可靠性与密封性能，确认图纸上的公差与热处理要求足以支撑设计寿命',
    specimens: '同批调质毛坯加工的正式件 6 根（3 根整轴疲劳、2 根解剖金相与硬度、1 根备用），另加 3 根 Ø10 标准拉伸试样',
    equipment: ['液压伺服疲劳试验机（≥100 kN·m 扭转或 ±50 kN 弯曲）', '偏摆仪与电感测微仪（分度值 1 μm）', '轮廓仪（Ra 量程 0.05~10 μm）', '洛氏/布氏硬度计', '金相显微镜', '磁粉探伤机', '油封试验台（带温控与转速控制）'],
    steps: [
      { no: 1, action: '来料与几何复检', condition: '室温 20±5℃', record: '各段直径、圆跳动、键槽对称度、粗糙度', criterion: '全部符合图纸，跳动 ≤0.025' },
      { no: 2, action: '调质质量确认', condition: '按炉取样', record: '表面与心部硬度、金相组织、脱碳层深度', criterion: 'HB241~286，回火索氏体，脱碳层 ≤0.1 mm' },
      { no: 3, action: '磁粉探伤', condition: '周向与纵向两次磁化', record: '缺陷位置与尺寸', criterion: '圆角与键槽区域不允许有任何线性显示' },
      { no: 4, action: '旋转弯曲疲劳试验', condition: '应力幅按额定工况的 1.0 / 1.2 / 1.4 倍各 1 根，转速 3000 r/min', record: '循环次数、裂纹萌生位置、断口形貌', criterion: '额定工况下 ≥1×10⁷ 次不失效' },
      { no: 5, action: '过盈配合装配与拆解试验', condition: '齿轮加热至 90±10℃ 热装，运转 100 h 后拆解', record: '压入力、配合面微动磨损痕迹、实际过盈量', criterion: '无红褐色磨屑，拉伤面积 ≤配合面 2%' },
      { no: 6, action: '油封台架试验', condition: 'Ø50 轴颈，1500 r/min，油温 80℃，连续 500 h', record: '渗漏量、轴颈磨损深度、油封唇口状态', criterion: '无可见渗漏，轴颈磨损 ≤0.02 mm' },
    ],
    measurements: [
      { item: '两轴承位公共基准圆跳动', method: '两中心孔顶尖定位 + 千分表', tolerance: '≤0.025 mm' },
      { item: '键槽对称度', method: 'V 形块 + 打表翻转法', tolerance: '≤0.02 mm' },
      { item: '油封轴颈粗糙度与纹理', method: '轮廓仪 + 30 倍显微观察', tolerance: 'Ra ≤0.4 μm，无螺旋纹' },
      { item: '调质硬度', method: '布氏硬度计，端面与中部各 3 点', tolerance: 'HB 241~286' },
      { item: '配合过盈量', method: '装配前分别测轴径与孔径，取差值', tolerance: '按 Ø60 H7/r6 计算范围内' },
    ],
    safety: ['疲劳试验区必须设防护罩，试件断裂瞬间有飞出风险', '热装齿轮时使用耐高温手套与专用吊具，禁止徒手扶正', '油封台架高温油路需设置泄压与接油盘，试验区禁明火'],
    schedule: '几何与材质检验 1 周；疲劳试验 3~5 周（受循环次数控制）；油封台架 3 周；可并行，总周期约 6 周，需 2 名试验员',
  },
  costNotes: [
    '单件材料成本约占 35%，机加工约占 45%，热处理约占 12%；优化重点应放在减少磨削工时而非换材料',
    '批量低于 200 件时圆钢下料仍最经济；超过 500 件模锻的综合成本开始占优',
  ],
  standardsToCheck: [
    { standard: 'GB/T 1800.2-2020', clause: 'k6 / r6 / m6 的极限偏差表', why: '核对图纸标注的偏差数值是否与标准一致' },
    { standard: 'GB/T 1095-2003 / GB/T 1096-2003', clause: '平键键槽的尺寸与公差', why: '确认 18N9、14N9 的槽宽槽深与键的配合类型匹配' },
    { standard: 'GB/T 3077-2015', clause: '40Cr 的力学性能与交货状态', why: '确认调质硬度区间与试样尺寸效应的修正' },
  ],
  openIssues: [
    '实际工作扭矩谱与启动冲击系数未知，直接影响疲劳校核结论，需要向主机厂索取载荷谱',
    '技术要求中高频淬火是否为必选项，图面文字模糊，需设计方确认',
    '是否有防腐或涂装要求（非工作面），图上未见说明',
  ],
};

const EX_OCR = {
  titleBlock: [
    { field: '图名', value: '输出轴' }, { field: '图号', value: 'JSD-04-02' },
    { field: '比例', value: '1:2' }, { field: '材料', value: '40Cr' },
    { field: '数量', value: '1' }, { field: '版本', value: 'B' },
  ],
  items: [
    { zone: '第1块(第1行第1列) 左端', kind: '尺寸', text: 'Ø45 m6 (+0.025/+0.009)' },
    { zone: '第2块(第1行第2列) 中部', kind: '尺寸', text: 'Ø55 k6 (+0.021/+0.002)' },
    { zone: '第2块(第1行第2列) 中部', kind: '尺寸', text: 'Ø60 r6 (+0.060/+0.041)' },
    { zone: '第3块(第1行第3列) 右端', kind: '尺寸', text: 'M36×1.5-6g' },
    { zone: '第2块 上方', kind: '形位公差', text: '⌰ | 0.025 | A—B' },
    { zone: '第4块(第2行第1列)', kind: '形位公差', text: '= | 0.02 | A' },
    { zone: '第2块 上方', kind: '粗糙度', text: 'Ra 0.8' },
    { zone: '第5块(第2行第2列)', kind: '粗糙度', text: 'Ra 0.4' },
    { zone: '第4块 A—A 断面', kind: '尺寸', text: '14 N9 (0/−0.043)，t = 5.5' },
    { zone: '第5块 B—B 断面', kind: '尺寸', text: '18 N9 (0/−0.043)，t = 7.0' },
    { zone: '第1块 下方', kind: '尺寸', text: '452 ±0.5（全长）' },
    { zone: '第3块 局部放大 I', kind: '注释', text: 'I  5:1   R2   2×0.5' },
    { zone: '第6块(第2行第3列)', kind: '视图名', text: 'A—A    B—B' },
    { zone: '第1块 左端面', kind: '注释', text: '中心孔 B3.15/10 GB/T 145（两端）' },
  ],
  technicalNotes: [
    '调质处理 HB241~286。',
    '未注倒角 C1.5，未注圆角 R2。',
    '未注线性尺寸公差按 GB/T 1804-m，未注几何公差按 GB/T 1184-K。',
    '去毛刺，锐边倒钝；加工后不允许有裂纹、折叠等缺陷。',
  ],
  unclear: [
    { zone: '标题栏右下', what: '版本 B 的更改说明文字', why: '原件此处有折痕，笔画粘连' },
    { zone: '技术要求第 3 条末尾', what: '高频淬火的适用范围', why: '印刷偏淡，末尾几个字不可辨' },
  ],
  coverage: '标题栏、主要尺寸、形位公差与技术要求已全部抄录；更改记录栏与两处模糊文字未能确认，已列入未辨认清单。',
};

function getExampleSet() {
  const lang = getLang();
  if (lang === 'zh') {
    return {
      drawing: EX_DRAWING, material: EX_MATERIAL, eng: EX_ENG, ocr: EX_OCR,
      planText: '分块 3×2，共 7 张送检\n细节相对整图放大 2.4×，已达原图原生分辨率',
      planNote: '（示例数值，投放文件后按实际分辨率重算）',
      at: '示例数据', srcName: '示例 · 减速器输出轴零件图', svgLabel: '示例示意图 · 阶梯轴',
      srcMeta: [['图纸', '减速器输出轴 JSD-04-02'], ['材料', '40Cr 调质 HB241~286'], ['状态', '内置示例，投放文件即替换']],
      qa: [{
        q: '为什么两处轴承位要用公共基准 A—B 来控制圆跳动？',
        a: '因为轴最终是靠两端轴承支承在箱体里旋转的，真正决定齿轮是否"转正"的，是这两个轴承位共同确定的那条回转轴线，而不是任何单独一段外圆。\n如果只用其中一端做基准，另一端的偏差会被放大到齿轮安装面上，装配后表现为齿轮端面摆动、啮合噪声和轴承温升。\n用公共基准 A—B 还有一个工艺含义：检验时必须把零件架在两个 V 形铁或两个中心孔上打表，这与它在箱体里的实际支承状态一致，测出来的数才有意义。',
      }],
    };
  }
  const ex = EX_I18N[lang] || EX_I18N.en;
  return {
    drawing: ex.drawing, material: ex.material, eng: ex.eng, ocr: ex.ocr,
    planText: ex.meta.planText, planNote: ex.meta.planNote, at: ex.meta.at,
    srcName: ex.meta.srcName, srcMeta: ex.meta.srcMeta, qa: ex.meta.qa,
    svgLabel: ex.meta.svgLabel || ex.meta.pdfCaption,
  };
}

function showExample() {
  S.demo = true;
  const ex = getExampleSet();
  S.report = {
    kind: 'drawing', mode: 'eng', data: ex.drawing, mat: ex.material,
    extra: ex.eng, ocr: ex.ocr, planText: ex.planText,
    at: ex.at,
    src: { name: ex.srcName, kind: 'image', note: '' },
    qa: ex.qa.map(x => ({ q: x.q, a: x.a })),
  };
  renderReport();
  showPlan(S.report.planText + '\n' + ex.planNote);
  $('#srcBox').innerHTML = EX_SVG;
  $('#srcBox').style.color = 'var(--ink2)';
  $('#srcKind').textContent = t('src.example');
  $('#srcMeta').innerHTML = ex.srcMeta
    .map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('');
}

/* ============ PDF 导出 ============ */
const PRINT_VARS = [
  '--paper:#ffffff', '--sheet:#ffffff', '--sheet2:#F6F8F8', '--sink:#EDF1F2',
  '--ink:#0F1A21', '--ink2:#3B4A53', '--ink3:#6C7C85', '--line:#C6D0D5', '--line2:#8B9AA1',
  '--accent:#14607F', '--accent-wash:#E3EEF2', '--accent-ink:#0C4257', '--on-accent:#ffffff',
  '--brass:#836219', '--brass-wash:#F1E9D8', '--ok:#25684D', '--ok-wash:#E2EFE8',
  '--warn:#8A6512', '--warn-wash:#F5ECD8', '--crit:#AE3722', '--crit-wash:#F7E3DE',
  'background:#ffffff', 'color:#0F1A21', 'width:772px', 'padding:30px 34px',
  'font-family:var(--f-body)', 'font-size:14px', 'line-height:1.68', 'box-shadow:none',
].join(';');

async function exportPDF() {
  if (!S.report) return;
  if (!S.downloads) { toast(t('toast.noDownload')); return; }
  const btn = $('#pdfBtn'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = t('pdf.generating');
  try {
    await loadScript(CDN.html2canvas);
    await loadScript(CDN.jspdf);
    const host = $('#printhost');
    const title = reportTitle();
    const head = '<div style="border-bottom:2px solid #14607F;padding-bottom:10px;margin-bottom:18px">' +
      '<div style="font-family:var(--f-mono);font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#6C7C85">' + esc(t('brand.pdfHead')) + '</div>' +
      '<div style="font-family:var(--f-disp);font-size:23px;font-weight:700;margin-top:3px">' + esc(title) + ' · ' + esc(t('pdf.reportSuffix')) + '</div>' +
      '<div style="font-size:11.5px;color:#3B4A53;margin-top:3px">' + esc(t('pdf.generatedAt')) + ' ' + esc(nowStamp()) +
      (S.report.src && S.report.src.name ? '　·　' + esc(TX('源文件')) + ' ' + esc(S.report.src.name) : '') +
      (S.demo ? '　·　' + esc(t('pdf.demoData')) : '') + '</div></div>';
    let srcImg = '';
    const capBase = 'border:1px solid #C6D0D5;padding:9px;margin-bottom:20px;text-align:center;background:#fff';
    const capTxt = 'font-family:var(--f-mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#6C7C85;margin-top:7px';
    if (S.demo) {
      srcImg = '<div style="' + capBase + ';color:#3B4A53">' + EX_SVG +
        '<div style="' + capTxt + '">' + esc(getExampleSet().svgLabel || t('pdf.srcCaption')) + '</div></div>';
    } else if (S.src && S.src.kind === 'image' && S.src.bitmap) {
      const k = Math.min(1, 1500 / Math.max(S.src.w, S.src.h));
      const cv = bitmapToCanvas(S.src.bitmap, S.src.w * k, S.src.h * k);
      srcImg = '<div style="' + capBase + '"><img src="' + cv.toDataURL('image/jpeg', 0.86) +
        '" style="max-width:100%;display:block;margin:0 auto"><div style="' + capTxt + '">' + esc(t('pdf.srcCaption')) + ' · ' +
        esc(S.src.name) + (S.src.note ? ' · ' + esc(S.src.note) : '') + '</div></div>';
    }
    host.innerHTML = '<div style="' + PRINT_VARS + '">' + head + srcImg + reportHTML(S.report, true) + '</div>';
    if (document.fonts && document.fonts.ready) { await document.fonts.ready; }
    await new Promise(r => setTimeout(r, 60));

    // 部分浏览器（尤其 iOS Safari）对画布总面积有约 16M 像素的上限
    const el = host.firstElementChild;
    const estH = Math.max(400, el.scrollHeight), estW = 772;
    const scale = Math.max(1.1, Math.min(2, Math.sqrt(15500000 / (estW * estH))));
    const canvas = await window.html2canvas(el, {
      scale: scale, backgroundColor: '#ffffff', logging: false, useCORS: false,
      windowWidth: 900, imageTimeout: 0,
    });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    const PW = 210, PH = 297, MX = 12, MT = 12, MB = 14;
    const imgW = PW - MX * 2, usableH = PH - MT - MB;
    const pxPerMM = canvas.width / imgW;
    const sliceH = Math.floor(usableH * pxPerMM);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let y = 0, page = 0;
    const tmp = document.createElement('canvas'); tmp.width = canvas.width;
    const tctx = tmp.getContext('2d');
    while (y < canvas.height) {
      let h = Math.min(sliceH, canvas.height - y);
      if (y + h < canvas.height) h = findBreak(ctx, canvas.width, y + h, Math.floor(h * 0.22)) - y;
      if (h < 40) h = Math.min(sliceH, canvas.height - y);
      tmp.height = h;
      tctx.fillStyle = '#ffffff'; tctx.fillRect(0, 0, tmp.width, h);
      tctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
      if (page > 0) pdf.addPage();
      pdf.addImage(tmp.toDataURL('image/jpeg', 0.92), 'JPEG', MX, MT, imgW, h / pxPerMM, undefined, 'FAST');
      page++; y += h;
      if (page > 60) break;
    }
    const total = pdf.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      pdf.setPage(i); pdf.setFontSize(8); pdf.setTextColor(120, 130, 138);
      pdf.text('Drawing Decoder  /  AI-generated engineering drawing analysis  /  verify against controlled drawings', MX, PH - 6);
      pdf.text(i + ' / ' + total, PW - MX, PH - 6, { align: 'right' });
    }
    pdf.setProperties({ title: title + ' ' + t('pdf.reportSuffix'), subject: t('brand.name'), creator: 'Drawing Decoder' });
    const blob = pdf.output('blob');
    const d = new Date(), p = (x) => String(x).padStart(2, '0');
    const fname = t('pdf.filenamePrefix') + title.replace(/[\\/:*?"<>|]/g, '') + '-' +
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.pdf';
    await S.downloads.save({ filename: fname, data: blob });
    toast(t('toast.saved') + fname);
  } catch (e) {
    console.error(e);
    if (e && e.code === 'declined') toast(t('toast.pdfDeclined'));
    else if (e && e.code === 'rate_limited') toast(t('toast.pdfRateLimited'));
    else toast(t('toast.pdfFail') + ((e && e.message) || t('toast.unknownError')), 5000);
  } finally {
    $('#printhost').innerHTML = '';
    btn.disabled = false; btn.textContent = old;
  }
}

function findBreak(ctx, w, y, maxBack) {
  const step = Math.max(1, Math.floor(w / 240));
  for (let d = 0; d < maxBack; d++) {
    const yy = y - d;
    if (yy < 2) break;
    let clean = true;
    const row = ctx.getImageData(0, yy, w, 1).data;
    for (let i = 0; i < row.length; i += 4 * step) {
      if (row[i] < 244 || row[i + 1] < 244 || row[i + 2] < 244) { clean = false; break; }
    }
    if (clean) return yy;
  }
  return y;
}

/* ============ 追问 ============ */
async function ask(q) {
  if (!q || !S.report || !S.sample || S.busy) return;
  S.busy = true; syncRun();
  const btn = $('#askBtn'); btn.disabled = true; btn.textContent = t('ask.thinking');
  S.abort = new AbortController();
  try {
    const ctxJSON = JSON.stringify({ kind: S.report.kind, analysis: S.report.data, materials: S.report.mat });
    const prompt = [
      '你是资深机械工程师。下面是一份' + (S.report.kind === 'code' ? '设备程序' : '机械图纸') + '的结构化分析结果（JSON）：',
      '"""', sliceBytes(ctxJSON, 42000), '"""',
      S.report.imgs && S.report.imgs.length ? '同时附上了原图，可直接查看图面细节。' : '',
      '',
      '用户的问题：' + q,
      '',
      '要求：' + (OUTPUT_LANG[getLang()] || OUTPUT_LANG.zh) + ' 直接回答，像资深工程师给同事讲解一样具体；结论先行，必要时分点。',
      '只依据上述分析结果与图片作答；资料里没有依据的，明确说明"图上没有体现，需要补充确认"，不要编造数值。',
      '控制在 400 字以内，不要 markdown 标题和代码块。',
    ].filter(Boolean).join('\n');
    const opts = { modelTier: S.tier === 'quick' ? 'quick' : 'default', signal: S.abort.signal };
    if (S.report.imgs && S.report.imgs.length && S.limits && S.limits.images) opts.images = S.report.imgs.slice(0, 1);
    const r = await S.sample(prompt, opts);
    S.report.qa.push({ q, a: (r && r.text ? r.text : '').trim() });
    renderReport(); saveHistory();
    $('#askInput').value = '';
    const items = $$('.qa-item'); if (items.length) items[items.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    toast(errMsg(e), 5000);
  } finally {
    btn.textContent = t('btn.ask'); S.busy = false; S.abort = null; syncRun();
  }
}

/* ============ 历史记录 ============ */
const HK = 'mdd.history.v2';
function loadHist() { try { return JSON.parse(localStorage.getItem(HK) || '[]'); } catch (e) { return []; } }
function saveHistory() {
  if (!S.report || S.demo) return;
  try {
    const list = loadHist().filter(x => x.id !== S.report.id);
    if (!S.report.id) S.report.id = 'r' + Date.now();
    list.unshift({ id: S.report.id, title: reportTitle(), kind: S.report.kind, mode: S.report.mode, at: S.report.at,
      data: S.report.data, mat: S.report.mat, extra: S.report.extra, ocr: S.report.ocr, lang: S.report.lang || 'zh',
      planText: S.report.planText, qa: S.report.qa, src: S.report.src });
    while (list.length > 12) list.pop();
    for (let i = 0; i < 4; i++) {
      try { localStorage.setItem(HK, JSON.stringify(list)); break; } catch (e) { list.pop(); }
    }
  } catch (e) { /* 存储不可用时忽略 */ }
  renderHistory();
}
function historyListHTML(list) {
  if (!list.length) return '<li class="empty">' + esc(t('hist.empty')) + '</li>';
  return list.map(h => '<li><button type="button" data-id="' + esc(h.id) + '">' +
    '<span class="ht">' + esc(h.title) + '</span>' +
    '<span class="hd">' + esc(TX(h.kind === 'code' ? '代码' : h.kind === 'chart' ? '图表' : '图纸')) +
    ' · ' + esc(TX(h.mode === 'teach' ? '教学' : '工程')) + ' · ' + esc(h.at) + '</span></button></li>').join('');
}
// 侧栏历史面板和右上角的历史下拉共用同一份 localStorage 数据，两处一起刷新
function renderHistory() {
  const list = loadHist();
  const ul = $('#hist'); if (ul) ul.innerHTML = historyListHTML(list);
  const menu = $('#histMenuList'); if (menu) menu.innerHTML = historyListHTML(list);
}
function openHistory(id) {
  const h = loadHist().find(x => x.id === id); if (!h) return;
  S.report = { kind: h.kind, mode: h.mode || 'eng', data: h.data, mat: h.mat, extra: h.extra || null,
    ocr: h.ocr || null, planText: h.planText || '', qa: h.qa || [], at: h.at, src: h.src || {}, id: h.id,
    lang: h.lang || 'zh' };
  S.demo = false; renderReport(); syncRun();
  $('#reportState').textContent = t('reportState.history') + ' · ' + h.at;
  $('#sheet').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ============ 纯文本导出 ============ */
function plainText() {
  const host = document.createElement('div');
  host.innerHTML = reportHTML(S.report, true);
  host.querySelectorAll('table').forEach(t => {
    t.querySelectorAll('tr').forEach(tr => {
      const cells = Array.from(tr.children).map(td => td.textContent.trim());
      tr.replaceWith(document.createTextNode(cells.join(' | ') + '\n'));
    });
  });
  host.querySelectorAll('.sec-h h3').forEach(h => h.textContent = '\n## ' + h.textContent + '\n');
  host.querySelectorAll('.sub').forEach(h => h.textContent = '\n— ' + h.textContent + '\n');
  host.querySelectorAll('li,p,div.prop,div.cell').forEach(n => n.append('\n'));
  return ('# ' + reportTitle() + ' ' + t('pdf.reportSuffix') + '\n' + t('pdf.generatedAt') + ' ' + nowStamp() + '\n' +
    host.textContent.replace(/\n{3,}/g, '\n\n')).trim();
}
async function copyText(content, okMsg) {
  try { await navigator.clipboard.writeText(content); toast(okMsg); return; } catch (e) {}
  const ta = document.createElement('textarea');
  ta.value = content; ta.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast(okMsg); } catch (e) { toast(t('toast.copyFail')); }
  ta.remove();
}
const copyReport = () => copyText(plainText(), t('toast.copied'));

/* ============ 事件绑定 ============ */
function bindUI() {
  const drop = $('#drop'), fileInput = $('#file');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) intake(fileInput.files[0]); fileInput.value = ''; });

  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.classList.add('hot'); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.classList.remove('hot'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; drop.classList.remove('hot');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) intake(f);
  });
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items; if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) { intake(f); e.preventDefault(); return; } }
    }
  });

  $('#tierSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tier]'); if (!b) return;
    S.tier = b.dataset.tier;
    $$('#tierSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });

  $('#runTeach').addEventListener('click', () => run('teach'));
  $('#runEng').addEventListener('click', () => run('eng'));
  $('#optTile').addEventListener('change', updatePlanPreview);
  $('#classSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cls]'); if (!b) return;
    S.docClass = b.dataset.cls;
    $$('#classSeg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  $('#stopBtn').addEventListener('click', () => { if (S.abort) S.abort.abort(); });
  $('#pdfBtn').addEventListener('click', exportPDF);
  $('#copyBtn').addEventListener('click', copyReport);
  $('#askBtn').addEventListener('click', () => ask($('#askInput').value.trim()));
  $('#askInput').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); ask($('#askInput').value.trim()); }
  });
  $('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-q]'); if (!b) return;
    if (S.demo) { toast(t('toast.demoAsk'), 4500); return; }
    ask(b.dataset.q);
  });
  $('#frame').addEventListener('click', (e) => {
    if (e.target.closest('#copyPromptBtn')) {
      copyText(chatPrompt(S.mode), t('toast.chatPromptCopied'));
    } else if (e.target.closest('#backDemoBtn')) {
      showExample(); $('#reportState').textContent = t('report.state.demo');
    }
  });
  $('#hist').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]'); if (b) openHistory(b.dataset.id);
  });
  $('#clearHist').addEventListener('click', () => {
    try { localStorage.removeItem(HK); } catch (e) {}
    renderHistory(); toast(t('toast.historyCleared'));
  });

  const historyBtn = $('#historyBtn'), historyMenu = $('#historyMenu');
  if (historyBtn && historyMenu) {
    historyBtn.addEventListener('click', () => {
      const opening = historyMenu.hidden;
      historyMenu.hidden = !opening;
      if (opening) renderHistory();
    });
    document.addEventListener('click', (e) => {
      if (!historyMenu.hidden && !e.target.closest('.historyWrap')) historyMenu.hidden = true;
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') historyMenu.hidden = true; });
  }
  $('#histMenuList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) { openHistory(b.dataset.id); if (historyMenu) historyMenu.hidden = true; }
  });
  const historyBackBtn = $('#historyBackBtn');
  if (historyBackBtn) historyBackBtn.addEventListener('click', () => {
    showExample(); $('#reportState').textContent = t('report.state.demo');
    if (historyMenu) historyMenu.hidden = true;
  });
  const historyClearBtn = $('#historyClearBtn');
  if (historyClearBtn) historyClearBtn.addEventListener('click', () => {
    try { localStorage.removeItem(HK); } catch (e) {}
    renderHistory(); toast(t('toast.historyCleared'));
  });
}

boot();
