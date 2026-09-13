/* Drawing Decoder API 分享代理 —— 部署在 Cloudflare Workers 上。
   作用：你的真实 Anthropic Key 只存在这里（Worker Secret），从不进入任何访客的浏览器。
   访客的浏览器只拿到一个"分享令牌"，这个 Worker 校验令牌有效后，代它去调 Anthropic，
   再把结果原样转发回去——所以拿到分享链接的人能"用"，但打开开发者工具也看不到你的真 Key。

   需要的环境变量（在 Cloudflare 控制台 → Workers → 这个 Worker → Settings → Variables）：
     ANTHROPIC_KEY  (Secret)  你的真实 Anthropic API Key
     ADMIN_SECRET   (Secret)  一段随机字符串，只有你的管理面板知道，用来生成/吊销分享链接
   需要绑定的存储（Settings → Bindings → KV Namespace）：
     SHARE_TOKENS   变量名必须是这个，指向一个新建的 KV 命名空间，用来记录发出去的分享令牌 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      if (url.pathname === '/chat' && request.method === 'POST') return await handleChat(request, env, cors);
      if (url.pathname === '/mint' && request.method === 'POST') return await handleMint(request, env, cors);
      if (url.pathname === '/revoke' && request.method === 'POST') return await handleRevoke(request, env, cors);
      if (url.pathname === '/list' && request.method === 'GET') return await handleList(request, env, cors);
      if (url.pathname === '/' ) return json({ ok: true, service: 'drawing-decoder-share-proxy' }, 200, cors);
      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      return json({ error: 'internal_error', message: String((e && e.message) || e) }, 500, cors);
    }
  },
};

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'content-type': 'application/json' }, cors) });
}
function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  return !!token && !!env.ADMIN_SECRET && token === env.ADMIN_SECRET;
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 管理面板：生成一个新的分享令牌
async function handleMint(request, env, cors) {
  if (!requireAdmin(request, env)) return json({ error: { message: 'unauthorized' } }, 401, cors);
  if (!env.SHARE_TOKENS) return json({ error: { message: 'SHARE_TOKENS KV 没有绑定，先在 Worker 设置里加一个 KV 绑定' } }, 500, cors);
  const body = await request.json().catch(() => ({}));
  const label = String(body.label || '').slice(0, 80) || 'unlabeled';
  const ttlHours = Math.min(24 * 90, Math.max(1, Number(body.ttlHours) || 24 * 7));
  const token = randomToken();
  const now = Date.now();
  const rec = { label, createdAt: now, expiresAt: now + ttlHours * 3600000, revoked: false };
  await env.SHARE_TOKENS.put('tok:' + token, JSON.stringify(rec));
  return json({ token, expiresAt: rec.expiresAt }, 200, cors);
}

// 管理面板：吊销一个分享令牌
async function handleRevoke(request, env, cors) {
  if (!requireAdmin(request, env)) return json({ error: { message: 'unauthorized' } }, 401, cors);
  const body = await request.json().catch(() => ({}));
  const token = String(body.token || '');
  if (!token) return json({ error: { message: 'bad_request' } }, 400, cors);
  const raw = await env.SHARE_TOKENS.get('tok:' + token);
  if (!raw) return json({ error: { message: 'not_found' } }, 404, cors);
  const rec = JSON.parse(raw);
  rec.revoked = true;
  await env.SHARE_TOKENS.put('tok:' + token, JSON.stringify(rec));
  return json({ ok: true }, 200, cors);
}

// 管理面板：列出所有分享令牌（不会返回真实 API Key，只有令牌本身和状态）
async function handleList(request, env, cors) {
  if (!requireAdmin(request, env)) return json({ error: { message: 'unauthorized' } }, 401, cors);
  const out = [];
  let cursor;
  do {
    const page = await env.SHARE_TOKENS.list({ prefix: 'tok:', cursor });
    for (const k of page.keys) {
      const raw = await env.SHARE_TOKENS.get(k.name);
      if (!raw) continue;
      const rec = JSON.parse(raw);
      out.push({ token: k.name.slice(4), label: rec.label, createdAt: rec.createdAt, expiresAt: rec.expiresAt, revoked: !!rec.revoked });
    }
    cursor = page.cursor;
  } while (cursor);
  out.sort((a, b) => b.createdAt - a.createdAt);
  return json({ shares: out }, 200, cors);
}

// 真正的转发：校验令牌（或管理员本人），代为调用 Anthropic，把结果（含流式 SSE）原样转发回去
async function handleChat(request, env, cors) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  let allowed = !!token && !!env.ADMIN_SECRET && token === env.ADMIN_SECRET;
  if (!allowed && token && env.SHARE_TOKENS) {
    const raw = await env.SHARE_TOKENS.get('tok:' + token);
    if (raw) {
      const rec = JSON.parse(raw);
      allowed = !rec.revoked && rec.expiresAt > Date.now();
    }
  }
  if (!allowed) return json({ error: { message: 'invalid or expired share token' } }, 401, cors);
  if (!env.ANTHROPIC_KEY) return json({ error: { message: 'ANTHROPIC_KEY 没有配置，先在 Worker 设置里加这个 Secret' } }, 500, cors);

  const body = await request.text();
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body,
  });
  const headers = Object.assign({}, cors, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
  return new Response(upstream.body, { status: upstream.status, headers });
}
