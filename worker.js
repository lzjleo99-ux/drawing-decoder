/* Drawing Decoder API 分享代理 —— 部署在 Cloudflare Workers 上。
   作用：你的真实智谱（Zhipu）Key 只存在这里（Worker Secret），从不进入任何访客的浏览器。
   访客的浏览器只拿到一个"分享令牌"，这个 Worker 校验令牌有效后，代它去调智谱 GLM，
   再把结果转换成前端认识的格式转发回去——所以拿到分享链接的人能"用"，但打开开发者工具
   也看不到你的真 Key。

   前端（app.js / local-bridge.js）说的是 Anthropic Messages API 那一套请求/流式格式，
   这个 Worker 负责把它翻译成智谱的 OpenAI 兼容格式去请求，再把智谱的流式返回翻译回
   Anthropic 的格式转发给前端——前端完全不用改，只当自己在跟一个"叫 Claude 的模型"说话。

   需要的环境变量（在 Cloudflare 控制台 → Workers → 这个 Worker → Settings → Variables）：
     ZHIPU_KEY      (Secret)  你的真实智谱 API Key（open.bigmodel.cn 申请的那个）
     ZHIPU_MODEL    (可选，Text)  实际调用的智谱模型名，不填默认 glm-4.6v
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

// 把前端发来的 Anthropic Messages 格式请求体，转换成智谱（OpenAI 兼容）格式
function toZhipuBody(anthropicBody, model) {
  const msgs = (anthropicBody.messages || []).map((m) => {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    const hasImage = blocks.some((b) => b.type === 'image');
    if (!hasImage) {
      return { role: m.role, content: blocks.map((b) => String(b.text || '')).join('') };
    }
    const parts = blocks.map((b) => {
      if (b.type === 'image') {
        const src = b.source || {};
        const mime = src.media_type || 'image/png';
        return { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + src.data } };
      }
      return { type: 'text', text: String(b.text || '') };
    });
    return { role: m.role, content: parts };
  });
  return {
    model: model,
    messages: msgs,
    stream: true,
    max_tokens: anthropicBody.max_tokens || 8192,
  };
}

// 把智谱的流式 SSE（OpenAI 兼容的 choices[0].delta.content）翻译成
// 前端解析器认识的 Anthropic 流式事件（content_block_delta / text_delta）
function zhipuStreamToAnthropic(upstreamBody) {
  const reader = upstreamBody.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        buf += dec.decode(value, { stream: true });
        let i, emitted = false;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of chunk.split('\n')) {
            if (line.indexOf('data:') !== 0) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let ev; try { ev = JSON.parse(raw); } catch (e) { continue; }
            const choice = ev.choices && ev.choices[0];
            const delta = choice && choice.delta;
            if (delta && delta.content) {
              const out = { type: 'content_block_delta', delta: { type: 'text_delta', text: delta.content } };
              controller.enqueue(enc.encode('data: ' + JSON.stringify(out) + '\n\n'));
              emitted = true;
            }
            if (choice && choice.finish_reason === 'length') {
              const out = { type: 'message_delta', delta: { stop_reason: 'max_tokens' } };
              controller.enqueue(enc.encode('data: ' + JSON.stringify(out) + '\n\n'));
              emitted = true;
            }
          }
        }
        if (emitted) return;
      }
    },
  });
}

// 真正的转发：校验令牌（或管理员本人），把 Anthropic 格式的请求转换成智谱格式代为调用，
// 再把智谱的流式返回转换回 Anthropic 格式转发回去
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
  if (!env.ZHIPU_KEY) return json({ error: { message: 'ZHIPU_KEY 没有配置，先在 Worker 设置里加这个 Secret' } }, 500, cors);

  let anthropicBody;
  try { anthropicBody = JSON.parse(await request.text()); }
  catch (e) { return json({ error: { message: 'bad_request: invalid JSON body' } }, 400, cors); }

  const model = env.ZHIPU_MODEL || 'glm-4.6v';
  const zhipuBody = toZhipuBody(anthropicBody, model);

  let upstream;
  try {
    upstream = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.ZHIPU_KEY },
      body: JSON.stringify(zhipuBody),
    });
  } catch (e) {
    return json({ error: { message: '连不上智谱 API：' + (e && e.message ? e.message : e) } }, 502, cors);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    return json(j || { error: { message: 'upstream HTTP ' + upstream.status + ': ' + text.slice(0, 500) } }, upstream.status, cors);
  }

  const stream = zhipuStreamToAnthropic(upstream.body);
  return new Response(stream, { status: 200, headers: Object.assign({}, cors, { 'content-type': 'text/event-stream' }) });
}
