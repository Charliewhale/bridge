// Bridge 连接器 · 当前注入（进系统提示词段，可多篇）。
//
// 两种范围：
//   global —— 所有 DSH 会话都能带（局部节流按每个会话自己的轮次算，总上限跨会话累计）
//   local  —— 只对注入时绑定的那个会话生效
//
// 两种形态：
//   ① 路径注入（首选）：只记 path + absPath，每轮组装时按 mtime/size 读磁盘最新内容。
//      笔记改了，注入跟着变——这是「实时跟随」，不是拍快照。
//   ② 纯正文（兼容老格式 / 客户端没给路径时的后备）：存什么就是什么。
//
// 频率由两个数决定（见 injection-schedule.mjs）：
//   every —— 每几轮带一次（1 = 每次都带）
//   times —— 一共带几次（0 = 不限期）
// local 的「第几轮」按绑定会话算；global 的 every 按每个会话自己的轮次算，
// 第一次遇到该会话时算第 1 轮，times 是所有会话合计的总上限。
//
// 落盘只存路径和元信息，不存正文：存了正文，笔记后来改了也没意义。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeEvery, normalizeTimes, isDue } from './injection-schedule.mjs';

const DEFAULT_FILE = path.join(os.homedir(), '.dsh-bridge', 'injections.json');
// 单篇预算：注入进系统提示词、每轮都要重发，所以必须有上限。
const DEFAULT_MAX_CHARS = 512 * 1024;
const GLOBAL_SESSION = '*';

function scopeOf(item) {
  return item && item.scope === 'global' ? 'global' : 'local';
}

function titleKeyOf(item) {
  const scope = scopeOf(item);
  if (!item || !item.title) return null;
  return scope === 'global'
    ? 'g:' + item.title
    : 'l:' + String(item.sessionId || '') + ':' + item.title;
}

export function createInjectionStore({
  ttlMs = 0,
  now = () => Date.now(),
  maxCurrent = 10,
  file = null,
  maxContentChars = DEFAULT_MAX_CHARS,
  ledger = null,
  onError = null,
} = {}) {
  // 行为留痕：状态文件只说「现在有哪些」，说不了「哪一轮带了什么」。
  // 留痕失败绝不能反过来打断注入。
  function record(event) {
    if (typeof ledger !== 'function') return;
    try {
      ledger(event);
    } catch (error) {
      // 注入本身比账本重要，但留痕失败不能变成「没人知道」
      if (typeof onError !== 'function') return;
      try {
        onError(error);
      } catch {
        // 报告本身失败也只能放弃
      }
    }
  }
  let seq = 0;
  let current = [];
  // 会话 -> 已经投递过几轮
  const rounds = new Map();
  // 这一轮该带哪些（beginDelivery 定下来，提示词段只读）
  let dueIds = new Set();
  // 应用注入后要求「下一次投递忽略 every 带一次」的会话
  const forced = new Set();
  // 已经记过 render 的「会话@轮次」：提示词段可能被调多次，回执只记一次
  const rendered = new Set();
  // id -> { mtimeMs, size, text }：文件没变就不重复读盘
  const cache = new Map();

  const expiring = Number.isFinite(ttlMs) && ttlMs > 0;
  const isAlive = (item) => !expiring || now() - item.at <= ttlMs;
  const roundOf = (sid) => Number(rounds.get(sid)) || 0;

  function normalizeItem(item) {
    if (!item || typeof item !== 'object') return null;
    const scope = scopeOf(item);
    return {
      ...item,
      scope,
      sessionId: scope === 'global' ? GLOBAL_SESSION : String(item.sessionId || ''),
    };
  }

  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved.items)) {
        current = saved.items
          .map(normalizeItem)
          .filter((x) => x && x.id && (typeof x.content === 'string' || typeof x.path === 'string'));
      }
      if (Number.isFinite(saved.seq)) seq = Math.max(seq, Number(saved.seq));
      for (const item of current) {
        const n = Number(String(item.id).replace(/^inj-/, ''));
        if (Number.isFinite(n)) seq = Math.max(seq, n);
      }
      if (saved.rounds && typeof saved.rounds === 'object') {
        for (const [sid, n] of Object.entries(saved.rounds)) {
          const v = Number(n);
          if (Number.isFinite(v) && v > 0) rounds.set(sid, v);
        }
      }
      // 老文件里没有 rounds：按条目的起始轮推一个，别让「每 N 轮」一重启就错位
      for (const item of current) {
        const start = Number(item.startRound);
        if (Number.isFinite(start) && start > 0 && roundOf(item.sessionId) < start - 1) {
          rounds.set(item.sessionId, start - 1);
        }
      }
    } catch {
      // 没有文件、或者文件坏了：从空开始，不阻断启动
    }
  }

  function persist() {
    if (!file) return;
    try {
      // 有路径的记录不带正文（正文每轮实时读）
      const items = current.map((item) => {
        if (!item.path) return item;
        const { content, ...rest } = item;
        return rest;
      });
      const roundMap = {};
      for (const [sid, n] of rounds) roundMap[sid] = n;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 4, seq, rounds: roundMap, items }), 'utf8');
    } catch {
      // 落盘失败不该让本次会话的注入失效
    }
  }

  function clamp(text) {
    const s = String(text == null ? '' : text);
    if (s.length <= maxContentChars) return s;
    return s.slice(0, maxContentChars) + '\n\n…（已截断，原文 ' + s.length + ' 字）';
  }

  function contentOf(item) {
    if (!item.path || !item.absPath) return clamp(item.content);
    // 有路径时 content 是「附加内容」（比如 Obsidian 里选中的那一段——它不在文件里）
    const extra = typeof item.content === 'string' ? item.content.trim() : '';
    const withExtra = (body) => (extra ? body + '\n\n【选中内容】\n' + extra : body);
    const cached = cache.get(item.id);
    try {
      const st = fs.statSync(item.absPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return clamp(withExtra(cached.text));
      const text = fs.readFileSync(item.absPath, 'utf8');
      cache.set(item.id, { mtimeMs: st.mtimeMs, size: st.size, text });
      return clamp(withExtra(text));
    } catch {
      // 文件读不到：有旧内容就用旧内容，从没读到过就明说，别给空串假装没内容
      if (cached) return clamp(withExtra(cached.text));
      return '(文件读不到：' + item.path + ')' + (extra ? '\n\n【选中内容】\n' + extra : '');
    }
  }

  function alive() {
    if (!expiring) return current;
    const before = current.length;
    current = current.filter(isAlive);
    if (current.length !== before) persist();
    return current;
  }

  // 界面要看的：还剩几次（times=0 表示不限）
  const viewOf = (item) => {
    const times = normalizeTimes(item.times);
    const used = Number(item.used) || 0;
    return {
      ...item,
      scope: scopeOf(item),
      every: normalizeEvery(item.every),
      times,
      used,
      remaining: times === 0 ? 0 : Math.max(0, times - used),
      content: contentOf(item),
    };
  };

  function clearById(ids) {
    if (!ids || ids.size === 0) return;
    for (const item of current) {
      if (ids.has(item.id)) cache.delete(item.id);
    }
    current = current.filter((item) => !ids.has(item.id));
    persist();
  }

  return {
    // 只产出一条记录；要不要生效由调用方 markCurrent 决定。
    add({
      scope: rawScope = 'local',
      sessionId,
      content,
      path: notePath = null,
      absPath = null,
      title = null,
      kind = 'context',
      every = 1,
      times = 0,
    } = {}) {
      const scope = rawScope === 'global' ? 'global' : 'local';
      const sid = scope === 'global' ? GLOBAL_SESSION : String(sessionId || '').trim();
      const rel = notePath ? String(notePath) : null;
      const abs = absPath ? String(absPath) : null;
      const text = typeof content === 'string' ? content : null;
      if (!sid) return null;
      // 有路径就不需要正文；没路径才要求正文
      if (!rel && (!text || !text.trim())) return null;
      seq += 1;
      const record = {
        id: 'inj-' + seq,
        scope,
        sessionId: sid,
        title,
        kind,
        at: now(),
        every: normalizeEvery(every),
        times: normalizeTimes(times),
        used: 0,
        // local：注入那一刻的下一轮算第一轮；global 的起点按会话在 beginDelivery 里记
        startRound: scope === 'local' ? roundOf(sid) + 1 : 0,
      };
      if (scope === 'global' && sessionId && String(sessionId).trim()) {
        record.originSessionId = String(sessionId).trim();
      }
      if (rel) {
        record.path = rel;
        if (abs) record.absPath = abs;
        // 首次给的内容作为后备（文件被删时还能用），但不落盘
        if (text) record.content = text;
      } else {
        record.content = text;
      }
      return record;
    },

    /** 记为「当前注入」：可多篇，同范围同标题覆盖，超出上限丢最旧。 */
    markCurrent(record) {
      if (!record) return current.map(viewOf);
      const key = titleKeyOf(record);
      const idx = key ? current.findIndex((x) => titleKeyOf(x) === key) : -1;
      if (idx >= 0) {
        cache.delete(current[idx].id);
        current[idx] = record;
      } else current.push(record);
      if (current.length > maxCurrent) {
        const dropped = current.slice(0, current.length - maxCurrent);
        for (const d of dropped) cache.delete(d.id);
        current = current.slice(-maxCurrent);
      }
      persist();
      return current.map(viewOf);
    },

    /** 状态视图：带正文和剩余次数，不改任何计数（界面轮询调用它是对的）。
     *  给 sessionId 时只返回「全局 + 该会话局部」；不给则返回全部。 */
    currentItems(sessionId) {
      const sid = String(sessionId || '').trim();
      const list = alive();
      const filtered = sid
        ? list.filter((item) => scopeOf(item) === 'global' || item.sessionId === sid)
        : list;
      return filtered.map(viewOf);
    },

    /**
     * 组装系统提示词时调：只返回这一轮定下来的那几篇。
     * 纯读——计数已经在 beginDelivery 里做过了，这里被调几次都不影响。
     */
    carryItems(sessionId) {
      if (dueIds.size === 0) return [];
      const sid = String(sessionId || '').trim();
      const list = alive()
        .filter((item) => dueIds.has(item.id) && (!sid || scopeOf(item) === 'global' || item.sessionId === sid))
        .map(viewOf);
      // 只有真被取走才算渲染：定了名单但提示词段没来取，不能记成「带了」。
      if (list.length > 0) {
        const round = roundOf(sid);
        const key = sid + '@' + round;
        if (!rendered.has(key)) {
          rendered.add(key);
          record({
            type: 'render',
            sessionId: sid,
            round,
            items: list.map((x) => ({ id: x.id, title: x.title || null, every: x.every, times: x.times, used: x.used })),
          });
        }
      }
      return list;
    },

    /**
     * 一条消息要投递了：这个会话的轮次 +1，顺手定下这一轮该带哪几篇。
     * global 项按当前会话的轮次节流，used 全局累计；local 项只看绑定会话。
     */
    beginDelivery(sessionId) {
      const sid = String(sessionId || '').trim();
      if (!sid) return 0;
      const next = roundOf(sid) + 1;
      rounds.set(sid, next);
      dueIds = new Set();
      const forcedNow = forced.delete(sid);
      for (const item of alive()) {
        const scope = scopeOf(item);
        if (scope === 'local' && item.sessionId !== sid) continue;
        let startRound;
        if (scope === 'global') {
          if (!item.starts || typeof item.starts !== 'object') item.starts = {};
          startRound = Number(item.starts[sid]);
          if (!Number.isFinite(startRound) || startRound <= 0) {
            startRound = next;
            item.starts[sid] = startRound;
          }
        } else {
          startRound = Number(item.startRound) || 0;
        }
        const times = normalizeTimes(item.times);
        const used = Number(item.used) || 0;
        // forceNext：应用注入后这一轮不看 every，但仍尊重总次数上限。
        const due = forcedNow
          ? times === 0 || used < times
          : isDue({ every: item.every, times, used, startRound, round: next });
        if (!due) continue;
        item.used = (Number(item.used) || 0) + 1;
        item.lastRound = next;
        item.lastSession = sid;
        dueIds.add(item.id);
      }
      persist();
      if (dueIds.size > 0) {
        const items = [];
        for (const item of current) {
          if (!dueIds.has(item.id)) continue;
          items.push({
            id: item.id,
            title: item.title || null,
            every: normalizeEvery(item.every),
            times: normalizeTimes(item.times),
            used: Number(item.used) || 0,
          });
        }
        record({ type: 'due', sessionId: sid, round: next, items });
      }
      return next;
    },

    /** 投递失败：把这一轮退回去，别让「每 N 轮」白走一格。 */
    rollbackDelivery(sessionId) {
      const sid = String(sessionId || '').trim();
      if (!sid) return 0;
      const round = roundOf(sid);
      if (round <= 0) return 0;
      rounds.set(sid, round - 1);
      // 这一轮已经记过的「用过」和名单都退回
      const undone = [];
      for (const item of current) {
        if (Number(item.lastRound) !== round) continue;
        if (scopeOf(item) === 'local' ? item.sessionId !== sid : item.lastSession !== sid) continue;
        item.used = Math.max(0, (Number(item.used) || 0) - 1);
        delete item.lastRound;
        delete item.lastSession;
        undone.push({ id: item.id, title: item.title || null });
      }
      dueIds = new Set();
      persist();
      rendered.delete(sid + '@' + round);
      if (undone.length > 0) record({ type: 'rollback', sessionId: sid, round, items: undone });
      return round - 1;
    },

    /** 投递成功之后：次数带满的条目退场。 */
    tick(sessionId) {
      const sid = String(sessionId || '').trim();
      const kept = [];
      let changed = false;
      for (const item of current) {
        const scope = scopeOf(item);
        if (scope === 'local' && sid && item.sessionId !== sid) {
          kept.push(item);
          continue;
        }
        const times = normalizeTimes(item.times);
        if (times > 0 && (Number(item.used) || 0) >= times) {
          cache.delete(item.id);
          changed = true;
          continue;
        }
        kept.push(item);
      }
      if (changed) {
        current = kept;
        persist();
      }
      return current.map(viewOf);
    },

    /** 下一次该会话投递时忽略 every 带一次（应用注入后立刻生效）。 */
    forceNext(sessionId) {
      const sid = String(sessionId || '').trim();
      if (sid) forced.add(sid);
    },

    /** 清掉按 mtime/size 缓存的正文，下一次重新读磁盘。 */
    refreshCache() {
      cache.clear();
    },

    /** 清注入：传 id 清单篇；传 { scope:'global' } 清全局；传 { scope:'local', sessionId } 清该会话局部。 */
    clearCurrent(arg) {
      if (arg && typeof arg === 'object') {
        const { id, scope, sessionId } = arg;
        if (id) {
          clearById(new Set([String(id)]));
          return;
        }
        const sid = String(sessionId || '').trim();
        const ids = new Set();
        for (const item of current) {
          if (scope === 'global' && scopeOf(item) === 'global') ids.add(item.id);
          else if (scope === 'local' && scopeOf(item) === 'local' && (!sid || item.sessionId === sid)) ids.add(item.id);
          else if (!scope) ids.add(item.id);
        }
        clearById(ids);
        return;
      }
      if (typeof arg === 'string' && arg) {
        clearById(new Set([arg]));
        return;
      }
      current = [];
      cache.clear();
      persist();
    },
  };
}

/** 把注入记录拼成一段文本，供系统提示词段使用。 */
export function renderInjection(records) {
  if (!Array.isArray(records) || records.length === 0) return '';
  const parts = records.map((r) => {
    const head = r.title ? '【' + r.title + '】' : '【注入】';
    return head + '\n' + (r.content == null ? '' : r.content);
  });
  return [
    '[Bridge 注入] 下面是主人在 Obsidian 里的上下文（不是用户发言，按需使用）：',
    ...parts,
  ].join('\n\n');
}
