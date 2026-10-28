// 解答历史。
//
// 单独一份存储，不和图纸台的 mdd.history.v2 混用：那边存的是图纸报告结构，
// 点击条目会按报告去还原界面，混进作业数据只会让两边都坏掉。
//
// 上限 100 条。localStorage 每个源通常只有 5–10MB，而且要和图纸台共享，
// 所以写入必须做配额降级，不能写失败就整个丢掉。

const HK = 'mdd.solver.history.v1';
const CAP = 100;
// 单条超过这个大小就先把图去掉再存：一张 SVG 受力图可能比整道题的文字还大
const BIG_ENTRY = 120 * 1024;

export function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HK) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function hasFigures(entry) {
  return !!entry.doc?.questions?.some((q) => q.blocks?.some((b) => b.type === 'figure'));
}

function writeList(list) {
  // [FIX H2] 返回写入结果，并一次剥掉所有含图的记录。
  //
  // 原来的降级循环每轮只剥「一条」记录的图，6 轮最多腾出 6 条的空间。当配额缺口更大
  // （典型场景：图纸台的 base64 缩略图先占满了同一个 origin 的配额）时，循环耗尽后
  // 直接 `return list` —— 什么都没写进去，却当成成功返回，界面于是用绿色 ok 打印
  // "已存入历史记录"。刷新后记录消失，且没有任何错误提示。
  let working = list;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      localStorage.setItem(HK, JSON.stringify(working));
      return { ok: true, list: working };
    } catch {
      const withFigures = working.filter(hasFigures);
      if (withFigures.length) { withFigures.forEach(stripFigures); continue; }
      if (working.length > 1) { working = working.slice(0, -1); continue; }
      return { ok: false, list: working };   // 单条都放不下，如实报告失败
    }
  }
  return { ok: false, list: working };
}

function stripFigures(entry) {
  for (const q of entry.doc?.questions || []) {
    q.blocks = (q.blocks || []).filter((b) => b.type !== 'figure');
  }
  entry.figuresDropped = true;
}

/**
 * 存一份答卷。
 * @param {object} answerDoc
 * @returns {{id:string, total:number}}
 */
export function saveToHistory(answerDoc) {
  const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const entry = {
    id,
    title: answerDoc.meta?.title || '',
    subtitle: answerDoc.meta?.subtitle || '',
    subject: answerDoc.meta?.subject || '',
    sourceName: answerDoc.meta?.sourceName || '',
    at: new Date().toISOString(),
    count: (answerDoc.questions || []).length,
    doc: answerDoc,
  };
  if (JSON.stringify(entry).length > BIG_ENTRY) stripFigures(entry);

  const list = loadHistory();
  list.unshift(entry);
  while (list.length > CAP) list.pop();
  const written = writeList(list);
  // [FIX H2] 把"到底写没写进去"如实带给调用方
  return { id, total: written.list.length, saved: written.ok };
}

export function removeFromHistory(id) {
  return writeList(loadHistory().filter((h) => h.id !== id)).list;
}

export function clearHistory() {
  try { localStorage.removeItem(HK); } catch { /* 存储不可用时忽略 */ }
  return [];
}

export function getFromHistory(id) {
  return loadHistory().find((h) => h.id === id) || null;
}

export const HISTORY_CAP = CAP;
