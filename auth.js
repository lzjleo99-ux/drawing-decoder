/* 前端密码锁 —— 用户明确要求的"公网 + 用户名密码"访问方式。
   如实说明局限：这只是挡随手访客的前端提示框，不是真正的账户系统——
   任何人查看页面源码都能看到 accounts.js 里的哈希，只是看不到明文密码；
   真正需要多用户、可审计的登录，需要一个后端。
   登录状态存在 sessionStorage：同一次浏览器会话内（刷新、切页面）不用重登，
   但关掉标签页/窗口再重新访问，一律回到登录页——不做"记住此设备"。
   账号列表在 accounts.js（先于本文件加载），登录时逐个核对 sha256(用户名:密码)。 */
'use strict';

(function () {
  const REALM = 'mdd-auth-v1';
  const TOKEN_KEY = 'mdd.auth.session';

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function readSession() {
    try {
      const raw = sessionStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return obj.realm === REALM ? obj : null;
    } catch (e) { return null; }
  }
  window.__mddSession = readSession; // 给 admin.js / share.js 判断"当前是不是管理员"用

  function grant(account) {
    const session = { realm: REALM, user: account.user, admin: !!account.admin, label: account.label || account.user, at: Date.now() };
    try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(session)); } catch (e) {}
    document.body.classList.add('mdd-unlocked');
    document.body.classList.toggle('mdd-admin', session.admin);
    const gate = document.getElementById('authGate');
    if (gate) gate.remove();
    window.dispatchEvent(new CustomEvent('mdd:login', { detail: session }));
  }
  function logout() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    location.reload();
  }
  window.__mddLogout = logout;

  function wireLogoutButton() {
    const btn = document.getElementById('logoutBtn');
    if (btn) btn.addEventListener('click', logout);
  }

  function boot() {
    wireLogoutButton();
    const session = readSession();
    if (session) {
      document.body.classList.add('mdd-unlocked');
      document.body.classList.toggle('mdd-admin', !!session.admin);
      return;
    }
    const gate = document.getElementById('authGate');
    if (!gate) { document.body.classList.add('mdd-unlocked'); return; }
    if (typeof applyI18n === 'function') applyI18n(gate);

    const userEl = document.getElementById('authUser');
    const passEl = document.getElementById('authPass');
    const btn = document.getElementById('authBtn');
    const errEl = document.getElementById('authErr');
    const list = (typeof ACCOUNTS !== 'undefined' && Array.isArray(ACCOUNTS)) ? ACCOUNTS : [];

    async function tryLogin() {
      const u = (userEl.value || '').trim();
      const p = passEl.value || '';
      if (!u || !p) return;
      btn.disabled = true;
      const h = await sha256Hex(u + ':' + p);
      btn.disabled = false;
      const account = list.find(a => a.hash === h);
      if (account) { grant(account); }
      else { errEl.hidden = false; passEl.value = ''; passEl.focus(); }
    }
    btn.addEventListener('click', tryLogin);
    [userEl, passEl].forEach(el => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); }));
    userEl.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
