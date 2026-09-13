/* 管理面板 —— 只有登录时用的账号带 admin:true 才看得到入口（见 auth.js 的 mdd-admin 这个 body class）。
   两块功能：
   1. 账号管理：加/删账号，下载新的 accounts.js，手动放回项目目录跑 deploy.command 发布
      （纯静态站没有后端，做不到"新增账号立刻在线上生效"，这一步是诚实的折中）。
   2. 分享我的 API Key：调用 worker.js 部署出来的后端代理生成/吊销分享令牌，
      对方拿到的只是一个令牌，从头到尾看不到你的真实 Key。
   复用 app.js 里已有的全局函数（esc/toast/$），这里不重复定义，避免同名冲突。 */
'use strict';

(function () {
  const LS_WORKER_URL = 'mdd.admin.workerurl';
  const LS_ADMIN_SECRET = 'mdd.admin.secret';
  const getWorkerUrl = () => { try { return (localStorage.getItem(LS_WORKER_URL) || '').trim(); } catch (e) { return ''; } };
  const setWorkerUrl = (v) => { try { localStorage.setItem(LS_WORKER_URL, v.trim()); } catch (e) {} };
  const getAdminSecret = () => { try { return (localStorage.getItem(LS_ADMIN_SECRET) || '').trim(); } catch (e) { return ''; } };
  const setAdminSecret = (v) => { try { localStorage.setItem(LS_ADMIN_SECRET, v.trim()); } catch (e) {} };

  const T = (k) => (typeof t === 'function' ? t(k) : k);
  const escHtml = (typeof esc === 'function') ? esc : (v) => String(v == null ? '' : v);
  const showToast = (typeof toast === 'function') ? toast : (m) => alert(m);
  const q = (typeof $ === 'function') ? $ : (s) => document.querySelector(s);

  let workingAccounts = null; // accounts.js 的内存副本；加/删都改这份，下载时序列化成新文件

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function ensureWorkingAccounts() {
    if (!workingAccounts) {
      const base = (typeof ACCOUNTS !== 'undefined' && Array.isArray(ACCOUNTS)) ? ACCOUNTS : [];
      workingAccounts = base.map(a => Object.assign({}, a));
    }
    return workingAccounts;
  }

  function renderAccounts() {
    const body = document.getElementById('accountsBody');
    if (!body) return;
    const list = ensureWorkingAccounts();
    body.innerHTML = list.map((a, i) =>
      '<tr><td>' + escHtml(a.user) + '</td><td>' + escHtml(a.label || '') + '</td><td>' + (a.admin ? '✓' : '') + '</td>' +
      '<td><button class="btn ghost sm" type="button" data-remove="' + i + '">' + escHtml(T('admin.remove')) + '</button></td></tr>'
    ).join('');
  }

  async function addAccount() {
    const userEl = document.getElementById('newUser'), passEl = document.getElementById('newPass');
    const labelEl = document.getElementById('newLabel'), adminEl = document.getElementById('newAdmin');
    const u = (userEl.value || '').trim(), p = passEl.value || '', label = (labelEl.value || '').trim();
    if (!u || !p) return;
    const list = ensureWorkingAccounts();
    if (list.some(a => a.user === u)) { alert(T('admin.userExists')); return; }
    const hash = await sha256Hex(u + ':' + p);
    list.push({ user: u, hash: hash, admin: !!adminEl.checked, label: label || u });
    userEl.value = ''; passEl.value = ''; labelEl.value = ''; adminEl.checked = false;
    renderAccounts();
    showToast(T('admin.accountAdded'));
  }

  function removeAccount(i) {
    const list = ensureWorkingAccounts();
    const admins = list.filter(a => a.admin);
    if (list[i].admin && admins.length <= 1) { alert(T('admin.confirmRemoveLastAdmin')); return; }
    list.splice(i, 1);
    renderAccounts();
  }

  function downloadAccounts() {
    const list = ensureWorkingAccounts();
    const src = "'use strict';\n" +
      "/* 账号列表 —— 由“账号管理”面板生成。放回项目目录覆盖 accounts.js，跑一次 deploy.command 发布。 */\n" +
      "const ACCOUNTS = " + JSON.stringify(list, null, 2) + ";\n";
    const blob = new Blob([src], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'accounts.js';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---- 分享我的 API Key（走 worker.js 部署出来的后端代理）----
  async function workerCall(path, opts) {
    const base = getWorkerUrl().replace(/\/$/, '');
    if (!base) throw new Error(T('admin.needWorkerConfig'));
    const merged = Object.assign({ method: 'GET' }, opts || {});
    merged.headers = Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + getAdminSecret() }, (opts && opts.headers) || {});
    const res = await fetch(base + path, merged);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + res.status));
    return data;
  }
  function fmtDate(ms) { try { return new Date(ms).toLocaleString(); } catch (e) { return String(ms); } }

  async function refreshShares() {
    const body = document.getElementById('sharesBody');
    if (!body || !getWorkerUrl()) return;
    try {
      const data = await workerCall('/list', { method: 'GET' });
      const now = Date.now();
      body.innerHTML = (data.shares || []).map(s => {
        const expired = s.expiresAt < now;
        const status = s.revoked ? T('admin.status.revoked') : (expired ? T('admin.status.expired') : T('admin.status.active'));
        const canRevoke = !s.revoked && !expired;
        return '<tr><td>' + escHtml(s.label) + '</td><td>' + escHtml(fmtDate(s.expiresAt)) + '</td><td>' + escHtml(status) + '</td>' +
          '<td>' + (canRevoke ? '<button class="btn ghost sm" type="button" data-revoke="' + escHtml(s.token) + '">' + escHtml(T('admin.revoke')) + '</button>' : '') + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="adminEmpty">' + escHtml(T('admin.noShares')) + '</td></tr>';
    } catch (e) {
      body.innerHTML = '<tr><td colspan="4" class="adminEmpty">' + escHtml(e.message) + '</td></tr>';
    }
  }

  async function mintShare() {
    if (!getWorkerUrl() || !getAdminSecret()) { alert(T('admin.needWorkerConfig')); return; }
    const labelEl = document.getElementById('shareLabelInput');
    const label = (labelEl.value || '').trim() || T('admin.unlabeled');
    const ttlHours = Number(document.getElementById('shareTtlSelect').value) || 168;
    const btn = document.getElementById('mintShareBtn');
    btn.disabled = true;
    try {
      const data = await workerCall('/mint', { method: 'POST', body: JSON.stringify({ label: label, ttlHours: ttlHours }) });
      const session = (typeof window.__mddSession === 'function') ? window.__mddSession() : null;
      const cfg = { token: data.token, workerUrl: getWorkerUrl(), from: (session && session.label) || '' };
      const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(cfg)))));
      const link = location.origin + location.pathname + '#share=' + encoded;
      const box = document.getElementById('shareLinkBox');
      const out = document.getElementById('shareLinkOutput');
      out.value = link; box.hidden = false;
      labelEl.value = '';
      refreshShares();
    } catch (e) { alert(T('admin.mintFailed') + '：' + e.message); }
    btn.disabled = false;
  }

  async function revokeShare(token) {
    if (!confirm(T('admin.confirmRevoke'))) return;
    try { await workerCall('/revoke', { method: 'POST', body: JSON.stringify({ token: token }) }); refreshShares(); }
    catch (e) { alert(T('admin.revokeFailed') + '：' + e.message); }
  }

  function openModal() {
    const modal = document.getElementById('adminModal');
    if (!modal) return;
    modal.hidden = false;
    if (typeof applyI18n === 'function') applyI18n(modal);
    renderAccounts();
    const wu = document.getElementById('workerUrlInput'), as = document.getElementById('adminSecretInput');
    if (wu) wu.value = getWorkerUrl();
    if (as) as.value = getAdminSecret();
    if (getWorkerUrl() && getAdminSecret()) refreshShares();
  }
  function closeModal() { const m = document.getElementById('adminModal'); if (m) m.hidden = true; }

  function wireTabs() {
    document.querySelectorAll('.modalTab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.modalTab').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
        const isAccounts = btn.getAttribute('data-tab') === 'accounts';
        document.getElementById('paneAccounts').hidden = !isAccounts;
        document.getElementById('paneShare').hidden = isAccounts;
      });
    });
  }

  function boot() {
    const openBtn = document.getElementById('adminBtn');
    if (openBtn) openBtn.addEventListener('click', openModal);
    const closeBtn = document.getElementById('adminClose');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    const overlay = document.getElementById('adminModal');
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
    wireTabs();

    const addBtn = document.getElementById('addAccountBtn');
    if (addBtn) addBtn.addEventListener('click', addAccount);
    const accBody = document.getElementById('accountsBody');
    if (accBody) accBody.addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove]'); if (b) removeAccount(Number(b.getAttribute('data-remove')));
    });
    const dl = document.getElementById('downloadAccountsBtn');
    if (dl) dl.addEventListener('click', downloadAccounts);

    const saveCfg = document.getElementById('saveWorkerCfgBtn');
    if (saveCfg) saveCfg.addEventListener('click', () => {
      setWorkerUrl(document.getElementById('workerUrlInput').value);
      setAdminSecret(document.getElementById('adminSecretInput').value);
      refreshShares();
    });
    const mint = document.getElementById('mintShareBtn');
    if (mint) mint.addEventListener('click', mintShare);
    const copyBtn = document.getElementById('copyShareLinkBtn');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const out = document.getElementById('shareLinkOutput');
      try { await navigator.clipboard.writeText(out.value); showToast(T('admin.linkCopied')); }
      catch (e) { out.select(); try { document.execCommand('copy'); showToast(T('admin.linkCopied')); } catch (e2) {} }
    });
    const sharesBody = document.getElementById('sharesBody');
    if (sharesBody) sharesBody.addEventListener('click', (e) => {
      const b = e.target.closest('[data-revoke]'); if (b) revokeShare(b.getAttribute('data-revoke'));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
