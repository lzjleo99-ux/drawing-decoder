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

function writeList(list) {
  // 降级顺序：先去图，再逐条丢最老的。直接 pop 会无谓地丢掉本可保留的记录。
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      localStorage.setItem(HK, JSON.stringify(list));
      return list;
    } catch {
      const withFigures = list.find((h) => h.doc?.questions?.some((q) => q.blocks?.some((b) => b.type === 'figure')));
      if (withFigures) stripFigures(withFigures);
      else if (list.length > 1) list.pop();
      else return list.slice(0, 0);
    }
  }
  return list;
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
  return { id, total: written.length };
}

export function removeFromHistory(id) {
  return writeList(loadHistory().filter((h) => h.id !== id));
}

export function clearHistory() {
  try { localStorage.removeItem(HK); } catch { /* 存储不可用时忽略 */ }
  return [];
}

export function getFromHistory(id) {
  return loadHistory().find((h) => h.id === id) || null;
}

export const HISTORY_CAP = CAP;
