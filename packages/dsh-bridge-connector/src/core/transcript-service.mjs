// 转录服务：把会话里发生过的事，一条一条落到库里的「会话笔记」。
//
// 两路进水：
//   ① 实时——连接器本来就在收 `session/event`，事件到了直接转写，不轮询
//   ② 回填——DSH 重启前没在跑的那段时间，从会话日志按偏移补；靠 `seq` 去重，
//      同一件事绝不会写两遍
//
// 第一次见到某个会话文件时**只记位置、不回补**：库里已有的那些转录是枢阁写的，
// 我们从"此刻"接着往后写，不重复堆一遍。
import fs from 'node:fs';
import path from 'node:path';
import { decodeFrom, listSessionFiles } from './session-log.mjs';
import { toTranscriptEvent } from './transcript-format.mjs';

export function createTranscriptService({
  store,
  sessionsRoot,
  stateFile,
  backfillDays = 3,
  maxBytes = 96 * 1024 * 1024,
  log = () => {},
} = {}) {
  /** 每个会话一行：`{ offset, lastSeq }`。offset 只用于回填，lastSeq 是去重的唯一依据。 */
  let state = { sessions: {} };
  let started = false;
  const queue = [];
  let draining = null;

  function loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
        state = { sessions: { ...parsed.sessions } };
      }
    } catch {
      state = { sessions: {} };
    }
  }

  function saveState() {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      /* 落盘失败不该影响转录本身，下次回填会补上 */
    }
  }

  function entryOf(sessionId) {
    const key = String(sessionId || '');
    if (!state.sessions[key]) state.sessions[key] = { offset: 0, lastSeq: -1 };
    return state.sessions[key];
  }

  function writeEvents(sessionId, events, cwd) {
    if (!events.length) return 0;
    const r = store.appendEvents({ sessionId, cwd, events });
    return r.written;
  }

  /** 一条实时事件。返回是否真的写进去了（便于测试和日志）。 */
  function noteEvent(session, event) {
    if (!event || !started) return false;
    const sessionId = String((session && session.id) || '');
    if (!sessionId) return false;
    const entry = entryOf(sessionId);
    const ev = toTranscriptEvent(event, { sessionId, cwd: (session && session.cwd) || '' });
    if (!ev) return false;
    const seq = Number.isFinite(Number(ev.seq)) ? Number(ev.seq) : null;
    if (seq !== null && seq <= entry.lastSeq) return false;
    const written = writeEvents(sessionId, [ev], (session && session.cwd) || '');
    if (seq !== null) entry.lastSeq = seq;
    if (written) saveState();
    return written > 0;
  }

  /** 从日志补漏：只读偏移之后的部分，只认 seq 比记录更大的。 */
  function backfillSession(fileInfo) {
    const entry = entryOf(fileInfo.id);
    if (fileInfo.size > maxBytes) return 0;
    const { records, offsetAfter } = decodeFrom(fileInfo.path, entry.offset || 0);
    if (!records.length) {
      if (offsetAfter !== entry.offset) {
        entry.offset = offsetAfter;
        saveState();
      }
      return 0;
    }
    const events = [];
    let lastSeq = entry.lastSeq;
    for (const rec of records) {
      const ev = toTranscriptEvent(rec, { sessionId: fileInfo.id, cwd: fileInfo.cwd || '' });
      if (!ev) continue;
      const seq = Number.isFinite(Number(ev.seq)) ? Number(ev.seq) : null;
      if (seq !== null && seq <= lastSeq) continue;
      events.push(ev);
      if (seq !== null) lastSeq = seq;
    }
    const written = writeEvents(fileInfo.id, events, fileInfo.cwd || '');
    entry.lastSeq = lastSeq;
    entry.offset = offsetAfter;
    saveState();
    return written;
  }

  function recentFiles() {
    const cutoff = Date.now() - Math.max(1, backfillDays) * 24 * 3600 * 1000;
    return listSessionFiles(sessionsRoot).filter((f) => f.mtimeMs >= cutoff);
  }

  /** 首次启动：把已有会话的位置记下来（不回补历史），再把最近几天的漏网补上。 */
  function start() {
    loadState();
    started = true;
    let touched = 0;
    let skipped = 0;
    for (const f of recentFiles()) {
      const entry = entryOf(f.id);
      if (!Number.isFinite(entry.offset) || entry.offset === 0) {
        if (entry.lastSeq < 0) {
          // 第一次见：从此刻接着写，不把历史重抄一遍
          entry.offset = f.size;
          skipped += 1;
          continue;
        }
      }
      try {
        touched += backfillSession(f);
      } catch (err) {
        log('回填失败 ' + f.id + '：' + String((err && err.message) || err));
      }
    }
    saveState();
    log('转录就绪：回补 ' + touched + ' 条，跳过历史 ' + skipped + ' 个会话');
    return { touched, skipped };
  }

  function stop() {
    started = false;
    saveState();
  }

  return {
    start,
    stop,
    noteEvent,
    backfillSession,
    get state() {
      return state;
    },
    flush() {
      saveState();
    },
  };
}
