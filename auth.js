/* 前端密码锁 —— 用户明确要求的"公网 + 用户名密码"访问方式。
   如实说明局限：这只是挡随手访客的前端提示框，不是真正的账户系统——
   任何人查看页面源码都能看到下面这个哈希，只是看不到明文密码；
   真正需要多用户、可审计的登录，需要一个后端。 */
'use strict';

(function () {
  const REALM = 'mdd-auth-v1';
  const CRED_HASH = '6fd1e4aebb6b1f1937d1ccf90432c394c4fc0dc3d555178041bb34ebf654835e'; // sha256("username:password")
  const TOKEN_KEY = 'mdd.auth.token';
  const TOKEN_TTL_DAYS = 30;

  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function hasValidToken() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return false;
      const obj = JSON.parse(raw);
      return obj.realm === REALM && (Date.now() - obj.at) < TOKEN_TTL_DAYS * 86400000;
    } catch (e) { return false; }
  }
  function grant() {
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ realm: REALM, at: Date.now() })); } catch (e) {}
    document.body.classList.add('mdd-unlocked');
    const gate = document.getElementById('authGate');
    if (gate) gate.remove();
  }

  function boot() {
    if (hasValidToken()) { document.body.classList.add('mdd-unlocked'); return; }
    const gate = document.getElementById('authGate');
    if (!gate) { document.body.classList.add('mdd-unlocked'); return; }
    if (typeof applyI18n === 'function') applyI18n(gate);

    const userEl = document.getElementById('authUser');
    const passEl = document.getElementById('authPass');
    const btn = document.getElementById('authBtn');
    const errEl = document.getElementById('authErr');

    async function tryLogin() {
      const u = (userEl.value || '').trim();
      const p = passEl.value || '';
      if (!u || !p) return;
      btn.disabled = true;
      const h = await sha256Hex(u + ':' + p);
      btn.disabled = false;
      if (h === CRED_HASH) { grant(); }
      else { errEl.hidden = false; passEl.value = ''; passEl.focus(); }
    }
    btn.addEventListener('click', tryLogin);
    [userEl, passEl].forEach(el => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); }));
    userEl.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
