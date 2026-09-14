/* 本地直连版桥接层 —— 在浏览器里直接调用 Anthropic Messages API，
   对上暴露与 Artifact 运行时同样的 window.claude 接口，因此 app.js 一行都不用改。
   与 Artifact 沙箱版的区别：图片通道永远可用，单次可送 12 张图，提示词上限 40 万字节。 */
'use strict';

window.__MDD_LOCAL_BRIDGE__ = true; // 供 app.js 判断当前是独立站点（本地/公网）还是 Artifact 沙箱

// 本地调试地址（localhost/局域网测试）用这个按钮把已保存的 Key 一键带去正式网站，
// 不需要在两边分别手填。改成你自己的部署地址后，这个按钮才会在“非该地址”的页面上出现。
const SYNC_TARGET_URL = 'https://lzjleo99-ux.github.io/drawing-decoder/';

const LS_KEY = 'mdd.local.apikey';
const LS_DS_KEY = 'mdd.local.dskey';
const LS_ZP_KEY = 'mdd.local.zpkey';
const LS_APEX_KEY = 'mdd.local.apexkey';
const LS_MODEL = 'mdd.local.model';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
// 智谱走国内这个域名：api.z.ai（国际站）的浏览器预检没有返回 CORS 头，直连会被浏览器拦下；
// open.bigmodel.cn 实测预检正常，同一套 Key/模型可用。
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const APEX_URL = 'https://api.aixapex.com/v1/chat/completions';
const ANTHROPIC_FALLBACK_MODEL = 'claude-opus-5'; // DeepSeek 不支持图片，图片调用自动改走这个

const MODELS = [
  { id: 'claude-opus-5', name: 'Opus 5', noteKey: 'bridge.note.opus', vendor: 'anthropic' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', noteKey: 'bridge.note.sonnet', vendor: 'anthropic' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', noteKey: 'bridge.note.haiku', vendor: 'anthropic' },
  { id: 'deepseek-chat', name: 'DeepSeek V3', noteKey: 'bridge.note.dschat', textOnly: true, vendor: 'deepseek' },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1', noteKey: 'bridge.note.dsreasoner', textOnly: true, vendor: 'deepseek' },
  { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', noteKey: 'bridge.note.dsflash', vendor: 'deepseek' },
  // 智谱只列能读图的两个：GLM-4.5-Air 是纯文本模型，不支持图片，所以没有放进来
  { id: 'glm-4.6v', name: 'GLM-4.6V', noteKey: 'bridge.note.glm46v', vendor: 'zhipu' },
  { id: 'glm-4.6v-flash', name: 'GLM-4.6V-Flash', noteKey: 'bridge.note.glm46vflash', vendor: 'zhipu' },
  // Apex（api.aixapex.com）要求的模型名就是这几个字符串本身（含 TPK/ 前缀、大小写），不能自己改写
  { id: 'TPK/DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash (Apex)', noteKey: 'bridge.note.apexDeepSeek', vendor: 'apex' },
  { id: 'TPK/GLM-5.2', name: 'GLM-5.2 (Apex)', noteKey: 'bridge.note.apexGlm', vendor: 'apex' },
  { id: 'TPK/Qwen3.6-35B-A3B', name: 'Qwen3.6-35B-A3B (Apex)', noteKey: 'bridge.note.apexQwen36', vendor: 'apex' },
  { id: 'TPK/Qwen3.8-27B', name: 'Qwen3.8-27B (Apex)', noteKey: 'bridge.note.apexQwen', vendor: 'apex' },
  // 只有打开过别人给的分享链接、本机存了分享令牌时才会出现在下拉里
  { id: 'claude-shared', name: 'Claude', noteKey: 'bridge.note.shared', vendor: 'shared', requiresShare: true },
];
const isShared = (id) => id === 'claude-shared';
const bridgeT = (k) => (typeof t === 'function' ? t(k) : k);
const EFFORT = { quick: 'low', default: 'high', complex: 'xhigh' };
const isDeepSeek = (id) => /^deepseek-/.test(id);
const isZhipu = (id) => MODELS.some(m => m.id === id && m.vendor === 'zhipu');
const VISION_DEEPSEEK = ['deepseek-flash'];   // 其余 DeepSeek 模型（V3/R1）不认图片
const visionCapable = (id) => !isDeepSeek(id) || VISION_DEEPSEEK.indexOf(id) >= 0; // 智谱这里只列了会读图的型号，全部为 true

const getKey = () => { try { return localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; } };
const setKey = (v) => { try { localStorage.setItem(LS_KEY, v); } catch (e) { } };
const getDSKey = () => { try { return localStorage.getItem(LS_DS_KEY) || ''; } catch (e) { return ''; } };
const setDSKey = (v) => { try { localStorage.setItem(LS_DS_KEY, v.trim()); } catch (e) { } };
const getZPKey = () => { try { return localStorage.getItem(LS_ZP_KEY) || ''; } catch (e) { return ''; } };
const getApexKey = () => { try { return localStorage.getItem(LS_APEX_KEY) || ''; } catch (e) { return ''; } };
const setApexKey = (v) => { try { localStorage.setItem(LS_APEX_KEY, v.trim()); } catch (e) { } };
const isApex = (id) => MODELS.some(m => m.id === id && m.vendor === 'apex');
const setZPKey = (v) => { try { localStorage.setItem(LS_ZP_KEY, v.trim()); } catch (e) { } };
const DEFAULT_MODEL = 'glm-4.6v';
const getModel = () => { try { return localStorage.getItem(LS_MODEL) || DEFAULT_MODEL; } catch (e) { return DEFAULT_MODEL; } };
const setModel = (v) => { try { localStorage.setItem(LS_MODEL, v); } catch (e) { } };

const LS_WS = 'mdd.local.workspace';
const getWS = () => { try { return (localStorage.getItem(LS_WS) || '').trim(); } catch (e) { return ''; } };
const setWS = (v) => { try { localStorage.setItem(LS_WS, v.trim()); } catch (e) { } };

// 别人打开你的分享链接后，用这两项去走你的后端代理，而不是自己的 Key
const LS_SHARE_TOKEN = 'mdd.local.sharetoken';
const LS_SHARE_URL = 'mdd.local.shareurl';
const LS_SHARE_LABEL = 'mdd.local.sharelabel';
const getShareToken = () => { try { return (localStorage.getItem(LS_SHARE_TOKEN) || '').trim(); } catch (e) { return ''; } };
const setShareToken = (v) => { try { localStorage.setItem(LS_SHARE_TOKEN, v.trim()); } catch (e) { } };
const getShareWorkerUrl = () => { try { return (localStorage.getItem(LS_SHARE_URL) || '').trim(); } catch (e) { return ''; } };
const setShareWorkerUrl = (v) => { try { localStorage.setItem(LS_SHARE_URL, v.trim()); } catch (e) { } };
const getShareLabel = () => { try { return (localStorage.getItem(LS_SHARE_LABEL) || '').trim(); } catch (e) { return ''; } };
const setShareLabel = (v) => { try { localStorage.setItem(LS_SHARE_LABEL, v.trim()); } catch (e) { } };
const hasShareAccess = () => !!(getShareToken() && getShareWorkerUrl());

// 从「同步到线上网站」按钮打开的链接里取回 Key/模型设置，写入本页面的 localStorage
// （必须放在上面这些 get/set 定义之后：下面这个 IIFE 会用到它们，const 有暂时性死区，写反了会静默抛错）
let __syncImported = false;
let __shareImported = false;
(function importSyncFromHash() {
  const mSync = /(?:^|[?&#])sync=([^&]+)/.exec(location.hash) || /(?:^|[?&])sync=([^&]+)/.exec(location.search);
  const mShare = /(?:^|[?&#])share=([^&]+)/.exec(location.hash) || /(?:^|[?&])share=([^&]+)/.exec(location.search);
  if (mSync) {
    try {
      const cfg = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(mSync[1])))));
      if (cfg.anthropicKey) setKey(cfg.anthropicKey);
      if (cfg.dsKey) setDSKey(cfg.dsKey);
      if (cfg.zpKey) setZPKey(cfg.zpKey);
      if (cfg.apexKey) setApexKey(cfg.apexKey);
      if (cfg.wsId) setWS(cfg.wsId);
      if (cfg.model) setModel(cfg.model);
      __syncImported = true;
    } catch (e) { console.warn('[bridge] sync 参数解析失败', e); }
  }
  if (mShare) {
    try {
      const cfg = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(mShare[1])))));
      if (cfg.token && cfg.workerUrl) {
        setShareToken(cfg.token); setShareWorkerUrl(cfg.workerUrl); setShareLabel(cfg.from || '');
        setModel('claude-shared');
        __shareImported = true;
      }
    } catch (e) { console.warn('[bridge] share 参数解析失败', e); }
  }
  // 清掉地址栏里的敏感参数，不留在浏览历史 / 地址栏截图里
  if (mSync || mShare) {
    try { history.replaceState(null, '', location.pathname + location.search.replace(/[?&](sync|share)=[^&]+/, '')); } catch (e) { }
  }
})();
const LS_PROFILE = 'mdd.local.profile';
const getProfile = () => { try { return parseInt(localStorage.getItem(LS_PROFILE), 10) || 0; } catch (e) { return 0; } };
const setProfile = (i) => { try { localStorage.setItem(LS_PROFILE, String(i)); } catch (e) { } };
let lastError = '';

function blobToB64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(new Error('图片编码失败'));
    r.readAsDataURL(blob);
  });
}

function mapError(vendor, status, body) {
  const t = (body && body.error && body.error.type) || '';
  const m = (body && body.error && body.error.message) || ('HTTP ' + status);
  lastError = '[' + vendor + '] HTTP ' + status + ' · ' + (t || '?') + ' · ' + m;
  console.error('[' + vendor + ' API]', status, body);
  // 注意：code 不能用 app.js 里已有固定中文文案的那几个，否则真实原因会被盖掉
  if (status === 401 || status === 403) return { code: 'api_error', message: '[' + vendor + '] API Key 无效或无权限 → ' + m, status: status, raw: m };
  if (status === 429) return { code: 'rate_limited', message: '[' + vendor + '] 速率限制或额度不足 → ' + m, status: status, raw: m };
  if (status >= 500) return { code: 'api_error', message: '[' + vendor + '] 服务端错误 → ' + m, status: status, raw: m };
  if (vendor === 'anthropic' && /anthropic-workspace-id|scoped to a workspace/i.test(m)) {
    return {
      code: 'api_error', status: status, raw: m,
      message: '这个 API Key 是组织级的，必须指定工作区：在顶部「Workspace ID」里填入 wrkspc_ 开头的 ID（platform.claude.com/settings/workspaces，点进某个工作区后地址栏里就是），或改用某个工作区专属的 Key。'
    };
  }
  if (/image/i.test(m)) return { code: 'image_rejected', message: '[' + vendor + '] 图片被拒绝 → ' + m, status: status, raw: m };
  return { code: 'api_error', message: '[' + vendor + '] ' + m + (t ? '（' + t + '）' : ''), status: status, raw: m };
}

// 不同账号/模型对可选参数的支持不一致：从最完整的一档开始，遇到 400 就降一档重试，
// 成功后记住档位，之后直接用。
const PROFILES = [
  { thinking: true, effort: true, maxTokens: 64000, label: 'adaptive thinking + effort' },
  { thinking: true, effort: false, maxTokens: 64000, label: 'adaptive thinking' },
  { thinking: false, effort: true, maxTokens: 32000, label: 'effort only' },
  { thinking: false, effort: false, maxTokens: 32000, label: '基础参数' },
  { thinking: false, effort: false, maxTokens: 8192, label: '最小参数' },
];

function buildBody(model, msgs, tier, profile) {
  const b = { model: model, max_tokens: profile.maxTokens, stream: true, messages: msgs };
  if (profile.thinking && model.indexOf('haiku') < 0) b.thinking = { type: 'adaptive' };
  if (profile.effort && model.indexOf('haiku') < 0) b.output_config = { effort: EFFORT[tier] || 'high' };
  return b;
}

function apiHeaders(key) {
  const h = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  // 组织级 API Key 必须指明用哪个工作区
  const ws = getWS();
  if (ws) h['anthropic-workspace-id'] = ws;
  return h;
}

function normalizeImages(imgs) {
  if (!imgs) return [];
  return Array.isArray(imgs) ? imgs : (imgs.length !== undefined ? Array.from(imgs) : [imgs]);
}

function anthropicMessages(turns, imgs) {
  return (async () => {
    const msgs = turns.map(t => ({ role: t.role, content: [{ type: 'text', text: String(t.content) }] }));
    if (imgs.length) {
      const last = msgs[msgs.length - 1];
      const blocks = [];
      for (const b of imgs) {
        const type = b.type && /^image\/(png|jpeg|webp|gif)$/.test(b.type) ? b.type : 'image/png';
        blocks.push({ type: 'image', source: { type: 'base64', media_type: type, data: await blobToB64(b) } });
      }
      last.content = blocks.concat(last.content);
    }
    return msgs;
  })();
}

// Anthropic 原生请求，和经过分享代理转发的请求，body 构造与 SSE 解析完全一样，只是 url/header 不同
async function callAnthropicLike(vendor, url, buildHeaders, model, turns, imgs, opts) {
  const msgs = await anthropicMessages(turns, imgs);
  let res = null, err = null;
  for (let i = getProfile(); i < PROFILES.length; i++) {
    const body = buildBody(model, msgs, opts.modelTier, PROFILES[i]);
    let r;
    try {
      r = await fetch(url, { method: 'POST', signal: opts.signal, headers: buildHeaders(), body: JSON.stringify(body) });
    } catch (e) {
      if (e && e.name === 'AbortError') throw { code: 'cancelled', message: '已中止' };
      throw { code: 'api_error', message: '连不上 ' + new URL(url).host + '（网络或代理问题）：' + (e && e.message ? e.message : e) };
    }
    if (r.ok) { res = r; if (i !== getProfile()) { setProfile(i); console.info('[bridge] 采用参数档位：' + PROFILES[i].label); } break; }
    let j = null; try { j = await r.json(); } catch (e) { }
    err = mapError(vendor, r.status, j);
    if (/credit balance|billing|Plans & Billing|authentication|api key|not permitted|does not have access|invalid or expired share token/i.test(err.raw || '')) throw err;
    if (r.status !== 400 || i === PROFILES.length - 1) throw err;
    console.warn('[bridge] 参数档位 "' + PROFILES[i].label + '" 被拒绝，降档重试。原因：' + err.raw);
  }
  if (!res) throw err || { code: 'api_error', message: '请求失败' };

  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', truncated = false;
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (line.indexOf('data:') !== 0) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let ev; try { ev = JSON.parse(raw); } catch (e) { continue; }
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          text += ev.delta.text;
          if (opts.onText) { try { opts.onText({ text: text, delta: ev.delta.text }); } catch (e) { } }
        } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'max_tokens') {
          truncated = true;
        } else if (ev.type === 'error') {
          throw mapError(vendor, 200, ev);
        }
      }
    }
  }
  if (!text.trim()) throw { code: 'empty_completion', message: '模型没有返回内容' };
  return { text: text, truncated: truncated, modelTierApplied: opts.modelTier || 'default' };
}

async function callAnthropic(model, turns, imgs, opts) {
  const key = getKey();
  if (!key) throw { code: 'no_anthropic_key', message: '还没有填 Anthropic API Key。在页面顶部输入以 sk-ant- 开头的密钥后再试。' };
  return await callAnthropicLike('anthropic', ANTHROPIC_URL, () => apiHeaders(key), model, turns, imgs, opts);
}

async function callShared(model, turns, imgs, opts) {
  const workerUrl = getShareWorkerUrl(), token = getShareToken();
  if (!workerUrl || !token) throw { code: 'no_share_config', message: '分享链接的配置不完整，请重新打开对方发给你的分享链接。' };
  return await callAnthropicLike('shared', workerUrl.replace(/\/$/, '') + '/chat',
    () => ({ 'content-type': 'application/json', authorization: 'Bearer ' + token }),
    model, turns, imgs, opts);
}

async function callDeepSeek(model, turns, imgs, opts) {
  const key = getDSKey();
  if (!key) throw { code: 'no_deepseek_key', message: '还没有填 DeepSeek API Key。在页面顶部「DeepSeek API Key」里输入后再试，或把模型换回 Claude。' };

  const msgs = turns.map(t => ({ role: t.role, content: String(t.content) }));
  if (imgs.length) {
    // OpenAI 兼容格式：最后一条 user 消息的 content 换成图文混排的数组
    const last = msgs[msgs.length - 1];
    const parts = [{ type: 'text', text: last.content }];
    for (const b of imgs) {
      const type = b.type && /^image\/(png|jpeg|webp|gif)$/.test(b.type) ? b.type : 'image/png';
      parts.push({ type: 'image_url', image_url: { url: 'data:' + type + ';base64,' + await blobToB64(b) } });
    }
    last.content = parts;
  }
  const body = { model: model, messages: msgs, stream: true, max_tokens: 8192 };

  let r;
  try {
    r = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      signal: opts.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw { code: 'cancelled', message: '已中止' };
    throw { code: 'api_error', message: '连不上 api.deepseek.com（网络或代理问题）：' + (e && e.message ? e.message : e) };
  }
  if (!r.ok) {
    let j = null; try { j = await r.json(); } catch (e) { }
    throw mapError('deepseek', r.status, j);
  }

  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', reasoning = '', truncated = false;
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (line.indexOf('data:') !== 0) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let ev; try { ev = JSON.parse(raw); } catch (e) { continue; }
        const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
        if (d && d.reasoning_content) reasoning += d.reasoning_content; // R1 的思维链，不计入正文
        if (d && d.content) {
          text += d.content;
          if (opts.onText) { try { opts.onText({ text: text, delta: d.content }); } catch (e) { } }
        }
        if (ev.choices && ev.choices[0] && ev.choices[0].finish_reason === 'length') truncated = true;
      }
    }
  }
  if (!text.trim()) throw { code: 'empty_completion', message: '模型没有返回内容' + (reasoning ? '（只输出了思维链，未给出最终答案，试试换 deepseek-chat 或简化提示词）' : '') };
  return { text: text, truncated: truncated, modelTierApplied: opts.modelTier || 'default' };
}

async function callOpenAICompatible(vendor, url, key, model, turns, imgs, opts) {
  if (!key) throw { code: 'no_' + vendor + '_key', message: '还没有填写 ' + vendor + ' API Key，请在页面顶部输入后再试。' };
  const msgs = turns.map(t => ({ role: t.role, content: String(t.content) }));
  if (imgs.length) {
    // 跟 DeepSeek 一样是 OpenAI 兼容格式：最后一条 user 消息换成图文混排数组
    const last = msgs[msgs.length - 1];
    const parts = [{ type: 'text', text: last.content }];
    for (const b of imgs) {
      const type = b.type && /^image\/(png|jpeg|webp|gif)$/.test(b.type) ? b.type : 'image/png';
      parts.push({ type: 'image_url', image_url: { url: 'data:' + type + ';base64,' + await blobToB64(b) } });
    }
    last.content = parts;
  }
  const body = { model: model, messages: msgs, stream: true, max_tokens: 8192 };

  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      signal: opts.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw { code: 'cancelled', message: '已中止' };
    throw { code: 'api_error', message: '连不上 ' + new URL(url).host + '（网络或代理问题）：' + (e && e.message ? e.message : e) };
  }
  if (!r.ok) {
    let j = null; try { j = await r.json(); } catch (e) { }
    throw mapError(vendor, r.status, j);
  }

  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', truncated = false;
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (line.indexOf('data:') !== 0) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let ev; try { ev = JSON.parse(raw); } catch (e) { continue; }
        const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
        if (d && d.content) {
          text += d.content;
          if (opts.onText) { try { opts.onText({ text: text, delta: d.content }); } catch (e) { } }
        }
        if (ev.choices && ev.choices[0] && ev.choices[0].finish_reason === 'length') truncated = true;
      }
    }
  }
  if (!text.trim()) throw { code: 'empty_completion', message: '模型没有返回内容' };
  return { text: text, truncated: truncated, modelTierApplied: opts.modelTier || 'default' };
}

async function callZhipu(model, turns, imgs, opts) {
  return await callOpenAICompatible('zhipu', ZHIPU_URL, getZPKey(), model, turns, imgs, opts);
}

async function callApex(model, turns, imgs, opts) {
  return await callOpenAICompatible('Apex', APEX_URL, getApexKey(), model, turns, imgs, opts);
}

async function callAPI(input, options) {
  const opts = options || {};
  const turns = typeof input === 'string' ? [{ role: 'user', content: String(input) }] : input.slice();
  const model = getModel();
  const imgs = normalizeImages(opts.images);

  if (isShared(model)) {
    return await callShared(model === 'claude-shared' ? 'claude-opus-5' : model, turns, imgs, opts);
  }
  if (isZhipu(model)) {
    return await callZhipu(model, turns, imgs, opts); // 列表里的智谱模型全部支持图片，不需要 fallback
  }
  if (isApex(model)) {
    return await callApex(model, turns, imgs, opts);
  }
  if (isDeepSeek(model)) {
    if (imgs.length && !visionCapable(model)) {
      // 这个 DeepSeek 模型不认图片：透明地改走 Anthropic，其余调用仍按你选的 DeepSeek 模型走
      return await callAnthropic(ANTHROPIC_FALLBACK_MODEL, turns, imgs, opts);
    }
    return await callDeepSeek(model, turns, imgs, opts);
  }
  return await callAnthropic(model, turns, imgs, opts);
}

const sample = async function (input, options) { return await callAPI(input, options); };

sample.json = async function (input, options) {
  const r = await callAPI(input, options);
  let s = r.text.trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); }
  catch (e) { throw { code: 'invalid_json', message: '返回的不是合法 JSON', text: r.text }; }
};

sample.limits = async function () {
  return {
    maxPromptBytes: 400000,
    images: { maxCount: 12, maxInputBytes: 4500000, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
  };
};

const downloads = {
  save: async function (req) {
    const blob = req.data instanceof Blob ? req.data : new Blob([req.data]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = req.filename || 'download';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
    return { status: 'saved' };
  },
};

window.claude = {
  use: async function (name) {
    if (name === 'sample') return sample;
    if (name === 'downloads') return downloads;
    return null;
  },
};

/* ---- 顶部的 Key / 模型工具条 ---- */
function renderModelOptions(sel) {
  const cur = sel.value || getModel();
  const shown = MODELS.filter(m => !m.requiresShare || hasShareAccess());
  sel.innerHTML = shown.map(m => {
    const nameShown = m.name + (m.textOnly ? bridgeT('bridge.textOnlySuffix') : '');
    return '<option value="' + m.id + '">' + nameShown + ' — ' + bridgeT(m.noteKey) + '</option>';
  }).join('');
  sel.value = shown.some(m => m.id === cur) ? cur : (shown[0] && shown[0].id);
}

document.addEventListener('DOMContentLoaded', function () {
  const input = document.getElementById('apiKey');
  const dsInput = document.getElementById('dsApiKey');
  const zpInput = document.getElementById('zpApiKey');
  const apexInput = document.getElementById('apexApiKey');
  const sel = document.getElementById('modelSel');
  const state = document.getElementById('keyState');
  const ws = document.getElementById('wsId');
  if (!input || !sel) return;
  if (ws) {
    ws.value = getWS();
    const saveWS = () => { setWS(ws.value); setProfile(0); };
    ws.addEventListener('change', saveWS);
    ws.addEventListener('blur', saveWS);
  }
  renderModelOptions(sel);
  sel.value = getModel();
  input.value = getKey();
  if (dsInput) dsInput.value = getDSKey();
  if (zpInput) zpInput.value = getZPKey();
  if (apexInput) apexInput.value = getApexKey();

  const apiKeyField = document.getElementById('apiKeyField');
  const syncVendorUI = () => {
    const m = getModel();
    const apex = isApex(m);
    if (dsInput) dsInput.parentElement.hidden = !isDeepSeek(m);
    if (zpInput) zpInput.parentElement.hidden = !isZhipu(m);
    if (apexInput) apexInput.parentElement.hidden = !apex;
    // 分享链接进来的不用填自己的 Key；选了 DeepSeek/智谱时也不需要看到 Anthropic 的输入框
    if (apiKeyField) apiKeyField.hidden = isShared(m) || isDeepSeek(m) || isZhipu(m) || apex;
  };

  const syncBtn = document.getElementById('syncBtn');
  if (syncBtn) {
    // 已经在目标网址上，或者没配置目标网址，就没必要显示这个按钮
    if (!SYNC_TARGET_URL || location.href.indexOf(SYNC_TARGET_URL) === 0) {
      syncBtn.hidden = true;
    } else {
      syncBtn.addEventListener('click', () => {
        const cfg = { anthropicKey: getKey(), dsKey: getDSKey(), zpKey: getZPKey(), apexKey: getApexKey(), wsId: getWS(), model: getModel() };
        if (!cfg.anthropicKey && !cfg.dsKey && !cfg.zpKey) { alert(bridgeT('bridge.syncNoKey')); return; }
        const encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(cfg)))));
        window.open(SYNC_TARGET_URL + '#sync=' + encoded, '_blank');
        state.textContent = bridgeT('bridge.syncOpened');
        state.className = 'keystate ok';
      });
    }
  }

  const paint = () => {
    const model = getModel();
    const ds = isDeepSeek(model);
    const zp = isZhipu(model);
    const apex = isApex(model);
    const vision = visionCapable(model);
    const aOk = /^sk-ant-/.test(getKey());
    const dsOk = /^sk-/.test(getDSKey());
    const zpOk = getZPKey().length > 10;
    const apexOk = getApexKey().length > 10;
    const T = bridgeT;
    if (isShared(model)) {
      const label = getShareLabel();
      state.textContent = T('bridge.sharedActive') + (label ? '（' + label + '）' : '');
      state.className = 'keystate ok';
    } else if (zp) {
      state.textContent = zpOk ? T('bridge.zpSaved') : T('bridge.zpNeedKey');
      state.className = zpOk ? 'keystate ok' : 'keystate';
    } else if (apex) {
      state.textContent = apexOk ? T('bridge.apexSaved') : T('bridge.apexNeedKey');
      state.className = apexOk ? 'keystate ok' : 'keystate';
    } else if (!ds) {
      state.textContent = aOk
        ? T('bridge.saved') + (getWS() ? '（' + T('auth.workspace') + ' ' + getWS().slice(0, 18) + '…）' : '')
        : T('bridge.needKey');
      state.className = aOk ? 'keystate ok' : 'keystate';
    } else {
      const imgNote = vision ? T('bridge.dsVision') : T('bridge.dsImgFallback') + (aOk ? T('bridge.aOk') : T('bridge.aMissing'));
      state.textContent = (dsOk ? T('bridge.dsSaved') : T('bridge.dsNeedKey')) + '　·　' + imgNote;
      state.className = dsOk ? 'keystate ok' : 'keystate';
    }
    syncVendorUI();
  };

  const test = document.getElementById('testBtn');
  if (test) test.addEventListener('click', async () => {
    const T = bridgeT;
    const old = test.textContent;
    test.textContent = T('bridge.testing'); test.disabled = true;
    state.className = 'keystate';
    try {
      const r = await callAPI('只回答两个字：可用', { modelTier: 'quick' });
      state.textContent = T('bridge.connected') + r.text.trim().slice(0, 12) + '」' +
        ((isDeepSeek(getModel()) || isZhipu(getModel())) ? '' : ' · ' + T('bridge.profileLabel') + ' ' + PROFILES[getProfile()].label);
      state.className = 'keystate ok';
    } catch (e) {
      state.textContent = T('bridge.failed') + (e && e.message ? e.message : lastError || T('bridge.unknownError'));
      state.className = 'keystate';
    } finally { test.textContent = old; test.disabled = false; }
  });
  input.addEventListener('change', () => { setKey(input.value.trim()); setProfile(0); paint(); });
  input.addEventListener('blur', () => { setKey(input.value.trim()); paint(); });
  if (dsInput) {
    dsInput.addEventListener('change', () => { setDSKey(dsInput.value); paint(); });
    dsInput.addEventListener('blur', () => { setDSKey(dsInput.value); paint(); });
  }
  if (zpInput) {
    zpInput.addEventListener('change', () => { setZPKey(zpInput.value); paint(); });
    zpInput.addEventListener('blur', () => { setZPKey(zpInput.value); paint(); });
  }
  if (apexInput) {
    apexInput.addEventListener('change', () => { setApexKey(apexInput.value); paint(); });
    apexInput.addEventListener('blur', () => { setApexKey(apexInput.value); paint(); });
  }
  sel.addEventListener('change', () => { setModel(sel.value); paint(); });
  renderModelOptions(sel); // 若刚从本地页面同步过来，模型可能变了，重新按当前值渲染下拉
  sel.value = getModel();
  input.value = getKey();
  if (dsInput) dsInput.value = getDSKey();
  if (zpInput) zpInput.value = getZPKey();
  if (apexInput) apexInput.value = getApexKey();
  if (ws) ws.value = getWS();
  paint();
  if (__syncImported) { state.textContent = bridgeT('bridge.imported'); state.className = 'keystate ok'; }

  // 供 app.js 在切换界面语言时调用，刷新顶部工具条的翻译
  window.__refreshBridgeI18n = () => { renderModelOptions(sel); paint(); if (typeof applyI18n === 'function') applyI18n(); };
});
