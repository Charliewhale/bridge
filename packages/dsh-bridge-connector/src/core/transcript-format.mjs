// 转录格式（2026-11-21 定稿）：对话原文 + 工具名 + 工具结果，参数不抄。
//
// 目的：这是"发生过什么"的记录，不是调试日志。
//   · 我和你说的话 —— 全文
//   · 用了哪些工具 —— 只留名字，参数一律不抄（参数才是噪音的大头）
//   · 工具结果 —— 留，但单条截到 TOOL_RESULT_LIMIT 字，并明说截了多少（不许悄悄砍）
//
// 其余硬规矩：
//   · `user/message` 只收 `source.kind === 'user'`（插件灌的是工具回灌，不要）
//   · 没有时间的记录不猜时间，直接丢（猜了历史会混进今天）
//   · 轮次起止、系统提示、空步骤这些过程噪声不进转录

/** 进转录的事件类型。 */
export const KEEP_TYPES = {
  'user/message': '用户',
  'assistant/message': '助手',
  'tool/result': '工具结果',
  'compaction/summary': '上下文压缩',
};

/** 单条工具结果最多留这么多字。 */
export const TOOL_RESULT_LIMIT = 2000;

const ROLE_LABEL = { user: '你', assistant: '我', system: '系统' };
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

/** `session-712f4f31-…` → `712f4f31`。 */
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

/** 助手那条里的工具调用 → `[{id, name}]`，参数一个不留。 */
export function toolCalls(parts) {
  const out = [];
  for (const c of Array.isArray(parts) ? parts : []) {
    if (!c || typeof c !== 'object' || c.type !== 'tool-call') continue;
    const name = String(c.name || '').trim();
    if (!name) continue;
    out.push({ id: String(c.id || ''), name });
  }
  return out;
}

/**
 * 一条 DSH 记录 → 转录记录；不该进转录的返回 null。
 * 形状：`{seq, timeMs, role, body, tools}`，工具结果那条额外带 `ok` / `chars` / `toolOf`。
 */
export function toTranscriptEvent(rec, { withReasoning = false } = {}) {
  if (!rec || typeof rec !== 'object') return null;
  const type = String(rec.type || '');
  if (!Object.prototype.hasOwnProperty.call(KEEP_TYPES, type)) return null;
  const timeMs = recMs(rec);
  if (timeMs === null) return null;
  const data = rec.data || {};

  if (type === 'user/message') {
    const kind = String((data.source && data.source.kind) || '');
    if (!USER_SOURCE_KEEP.has(kind)) return null;
    return { seq: rec.seq ?? null, timeMs, role: 'user', body: joinText(data.content, withReasoning), tools: [] };
  }

  if (type === 'assistant/message') {
    const parts = (data.message && data.message.content) || [];
    const calls = toolCalls(parts);
    return {
      seq: rec.seq ?? null,
      timeMs,
      role: 'assistant',
      body: joinText(parts, withReasoning),
      tools: [...new Set(calls.map((c) => c.name))],
      calls,
    };
  }

  if (type === 'tool/result') {
    const message = data.message || {};
    for (const c of Array.isArray(message.content) ? message.content : []) {
      if (!c || c.type !== 'tool-result') continue;
      const text = (Array.isArray(c.content) ? c.content : [])
        .map((x) => (x && typeof x.text === 'string' ? x.text : ''))
        .join('');
      if (!text.trim()) return null;
      return {
        seq: rec.seq ?? null,
        timeMs,
        role: 'tool',
        toolOf: String(c.toolCallId || ''),
        ok: c.isError !== true,
        chars: text.length,
        body: text,
        tools: [],
      };
    }
    return null;
  }

  // compaction/summary
  const parts = (data.message && data.message.content) || data.content || [];
  return {
    seq: rec.seq ?? null,
    timeMs,
    role: 'system',
    body: '（上下文被压缩，摘要如下）\n\n' + joinText(parts, withReasoning),
    tools: [],
  };
}

/** 结果太长就截，截了必须说清楚（库里不能出现"看起来完整其实被砍过"的东西）。 */
export function clipResult(text, limit = TOOL_RESULT_LIMIT) {
  const t = typeof text === 'string' ? text : '';
  const max = Number(limit) > 0 ? Number(limit) : TOOL_RESULT_LIMIT;
  if (t.length <= max) return { text: t, clipped: false, total: t.length };
  return { text: t.slice(0, max), clipped: true, total: t.length };
}

function fenceFor(body) {
  const runs = body.match(/`{3,}/g) || [];
  const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** 一条记录 → Markdown 片段。 */
export function renderEntry(ev) {
  const stamp = hhmmssOf(ev && ev.timeMs);

  if (ev && ev.role === 'tool') {
    const name = ev.tool || ev.toolOf || '?';
    const state = ev.ok === false ? '失败' : '成功';
    const head = '## ' + stamp + ' · 工具 · ' + name + ' · ' + state + '（' + (ev.chars || 0) + ' 字）';
    const { text, clipped, total } = clipResult(ev.body);
    const fence = fenceFor(text);
    const block = fence + 'text\n' + text.replace(/\n$/, '') + '\n' + fence;
    const note = clipped ? '\n\n> …（共 ' + total + ' 字，这里留了前 ' + text.length + ' 字）' : '';
    return head + '\n\n' + block + note + '\n';
  }

  const role = (ev && ev.role) || 'system';
  const head = '## ' + stamp + ' · ' + (ROLE_LABEL[role] || '系统');
  const body = ev && typeof ev.body === 'string' ? ev.body.trim() : '';
  const tools = ev && Array.isArray(ev.tools) ? ev.tools.filter(Boolean) : [];
  const parts = [];
  if (body) parts.push(body);
  if (tools.length) parts.push('> 用了 ' + tools.length + ' 个工具：' + tools.join('、'));
  if (!parts.length) parts.push('（空）');
  return head + '\n\n' + parts.join('\n\n') + '\n';
}

/** 篇头：只在新建那一篇时写一次。 */
export function renderHeader({ agent = 'agent.dsh', day = '', label = '', session = '', cwd = '' } = {}) {
  const where = '> 会话 id：`' + (session || '（这批事件没带会话标记）') + '`' + (cwd ? ' · cwd：`' + cwd + '`' : '');
  return (
    '# ' + agent + ' · ' + day + ' · ' + label + '\n\n' +
    '> 由 dsh-bridge-connector 从 DSH 会话日志**按会话**组装：对话原文、用过的工具名、工具结果（单条超过 ' +
    TOOL_RESULT_LIMIT + ' 字会截断并注明）。工具参数不记。同一会话后续内容**直接追加在文末**（跨天才新建一篇）。\n>\n' +
    where + '\n\n'
  );
}
