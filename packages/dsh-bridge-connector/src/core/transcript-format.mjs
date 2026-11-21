// DSH 会话事件 → 可读的转录记录 + 笔记格式。
//
// 形状是 2026-11-21 定的：**只留对话和"用过什么工具"，不搬工具参数与回显**。
// 早先照枢阁的版本把参数、结果全文都抄进库里，读起来像日志不像对话。
//
// 几条硬规矩：
//   · 只收 user/message、assistant/message、compaction/summary；轮次、工具回显、
//     系统提示这些过程噪声不进转录
//   · `user/message` 只收 `source.kind === 'user'`（插件灌的消息是工具回灌，不要）
//   · 没有时间字段的记录**不猜时间**，直接丢——猜了会把历史算成"此刻"（2026-10-04 栽过）
//   · 对话正文原样，不截断

/** 进转录的事件类型（值只是给人看的中文标签）。 */
export const KEEP_TYPES = {
  'user/message': '用户',
  'assistant/message': '助手',
  'compaction/summary': '上下文压缩',
};

/** 角色 → 标题里那个称呼。 */
const ROLE_LABEL = { user: '你', assistant: '我', system: '系统' };

/** `user/message` 里只有这个来源是真人说话。 */
const USER_SOURCE_KEEP = new Set(['user']);

const pad = (n) => String(n).padStart(2, '0');

function localDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 时间戳 → 本地 `YYYY-MM-DD`。 */
export function dayOf(ms) {
  const d = localDate(ms);
  if (!d) return '';
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 时间戳 → 本地 `HH:MM:SS`。 */
export function hhmmssOf(ms) {
  const d = localDate(ms);
  if (!d) return '';
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/** `session-712f4f31-…` → `712f4f31`（笔记名用短名）。 */
export function shortIdOf(sessionId) {
  const raw = String(sessionId || '');
  if (!raw) return '';
  const body = raw.startsWith('session-') ? raw.slice('session-'.length) : raw;
  return body.split('-')[0] || '';
}

function recMs(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const ms = rec.time !== undefined ? rec.time : rec.createdAt;
  return Number.isFinite(Number(ms)) ? Number(ms) : null;
}

/** 内容分片 → 正文。text 全要；image 留占位；reasoning 默认不要。 */
function joinText(parts, withReasoning) {
  const texts = [];
  const thinks = [];
  for (const c of Array.isArray(parts) ? parts : []) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && c.text) texts.push(String(c.text));
    else if (c.type === 'reasoning' && withReasoning && c.text) thinks.push(String(c.text));
    else if (c.type === 'image') texts.push('（一张图）');
  }
  let body = texts.join('\n\n').trim();
  if (thinks.length) {
    const tail = '<details><summary>思考</summary>\n\n' + thinks.join('\n\n').trim() + '\n\n</details>';
    body = body ? body + '\n\n' + tail : tail;
  }
  return body;
}

/** 只收工具名，去重、保持出现顺序；参数一个都不留。 */
function toolNames(parts) {
  const out = [];
  for (const c of Array.isArray(parts) ? parts : []) {
    if (!c || typeof c !== 'object' || c.type !== 'tool-call') continue;
    const name = String(c.name || '').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 一条 DSH 记录 → 转录记录 `{seq, timeMs, role, body, tools}`；不该进转录的返回 null。
 */
export function toTranscriptEvent(rec, { sessionId = '', cwd = '', withReasoning = false } = {}) {
  if (!rec || typeof rec !== 'object') return null;
  const type = String(rec.type || '');
  if (!Object.prototype.hasOwnProperty.call(KEEP_TYPES, type)) return null;
  const timeMs = recMs(rec);
  if (timeMs === null) return null;
  const data = rec.data || {};
  void sessionId;
  void cwd;

  let role = 'system';
  let body = '';
  let tools = [];

  if (type === 'user/message') {
    const kind = String((data.source && data.source.kind) || '');
    if (!USER_SOURCE_KEEP.has(kind)) return null;
    role = 'user';
    body = joinText(data.content, withReasoning);
  } else if (type === 'assistant/message') {
    const parts = (data.message && data.message.content) || [];
    role = 'assistant';
    body = joinText(parts, withReasoning);
    tools = toolNames(parts);
  } else if (type === 'compaction/summary') {
    const parts = (data.message && data.message.content) || data.content || [];
    role = 'system';
    body = '（上下文被压缩，摘要如下）\n\n' + joinText(parts, withReasoning);
  } else {
    return null;
  }

  const seq = rec.seq === undefined ? null : rec.seq;
  return { seq, timeMs, role, body, tools };
}

/** 一条记录 → Markdown 片段（`## HH:MM:SS · 你/我/系统` + 正文 + 一行工具名）。 */
export function renderEntry(ev) {
  const role = (ev && ev.role) || 'system';
  const head = '## ' + hhmmssOf(ev && ev.timeMs) + ' · ' + (ROLE_LABEL[role] || '系统');
  const body = ev && typeof ev.body === 'string' ? ev.body.trim() : '';
  const tools = ev && Array.isArray(ev.tools) ? ev.tools.filter(Boolean) : [];
  const parts = [];
  // 只调工具不说话的那些步骤：不写"（没有文字）"占位，一行工具名就够了
  if (body) parts.push(body);
  if (tools.length) parts.push('> 用了 ' + tools.length + ' 个工具：' + tools.join('、'));
  if (!parts.length) parts.push('（空）');
  return head + '\n\n' + parts.join('\n\n') + '\n';
}

/** 篇头：只在新建那一篇时写一次。故意不写「共 N 条」——这篇会一直追加。 */
export function renderHeader({ agent = 'agent.dsh', day = '', label = '', session = '', cwd = '' } = {}) {
  const where = '> 会话 id：`' + (session || '（这批事件没带会话标记）') + '`' + (cwd ? ' · cwd：`' + cwd + '`' : '');
  return (
    '# ' + agent + ' · ' + day + ' · ' + label + '\n\n' +
    '> 由 dsh-bridge-connector 从 DSH 会话日志**按会话**组装；只留对话和用过的工具名，工具参数与回显不抄。' +
    '同一会话后续内容**直接追加在文末**（跨天才新建一篇）。\n>\n' +
    where + '\n\n'
  );
}
