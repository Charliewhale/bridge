// 把转录记录写进库：`记录/日志/<agent>-raw/<日期>/会话-<短id>.md`，一篇一个会话，只追加。
//
// 为什么按"天 + 会话"分篇：同一天里多个会话是交错写的，整天一份必然混着几场对话；
// 而一个会话跨天就新开一篇——否则一篇文件会横跨好几个月，翻起来没边。
import fs from 'node:fs';
import path from 'node:path';
import { dayOf, renderEntry, renderHeader, shortIdOf } from './transcript-format.mjs';

export const TRANSCRIPT_DIR = ['记录', '日志'];

export function createTranscriptStore({ root = '', agent = 'agent.dsh', stateFile = null } = {}) {
  let vaultRoot = String(root || '');
  if (!vaultRoot && stateFile) {
    // DSH 重启后插件不一定会马上把库路径再推一遍，所以这里记一份：上次落在哪，这次还落哪
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (saved && typeof saved.root === 'string') vaultRoot = saved.root;
    } catch {
      /* 没有记录就等插件推 */
    }
  }

  function setRoot(next) {
    vaultRoot = String(next || '');
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ root: vaultRoot }, null, 2), 'utf8');
    } catch {
      /* 记不住也不影响本次写入 */
    }
  }

  function baseDir() {
    return path.join(vaultRoot, ...TRANSCRIPT_DIR, agent + '-raw');
  }

  function pathFor(day, shortId) {
    return path.join(baseDir(), day, '会话-' + shortId + '.md');
  }

  /**
   * 追加一批记录。调用方负责去重（同一 seq 别喂两次）。
   * 返回 `{written, files}`；没有库路径时什么都不写，也不报错。
   */
  function appendEvents({ sessionId = '', cwd = '', events = [] } = {}) {
    if (!vaultRoot) return { written: 0, files: [] };
    const shortId = shortIdOf(sessionId);
    if (!shortId) return { written: 0, files: [] };

    // 按天分组，保持原顺序
    const byDay = new Map();
    for (const ev of Array.isArray(events) ? events : []) {
      if (!ev || !Number.isFinite(Number(ev.timeMs))) continue;
      const day = dayOf(ev.timeMs);
      if (!day) continue;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(ev);
    }

    const files = [];
    let written = 0;
    for (const [day, list] of byDay) {
      if (!list.length) continue;
      const file = pathFor(day, shortId);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const fresh = !fs.existsSync(file);
        const body = list.map((ev) => renderEntry(ev)).join('\n');
        if (fresh) {
          const head = renderHeader({ agent, day, label: '会话-' + shortId, session: sessionId });
          fs.writeFileSync(file, head + body + '\n', 'utf8');
        } else {
          // 老文件末尾可能已经有换行，补一个空行再续，条目之间留一行
          fs.appendFileSync(file, (endsWithBlank(file) ? '' : '\n') + body + '\n', 'utf8');
        }
        files.push(file);
        written += list.length;
      } catch {
        /* 写不进库不该影响会话；下一轮还能补 */
      }
    }
    return { written, files };
  }

  return { setRoot, get root() { return vaultRoot; }, baseDir, pathFor, appendEvents };
}

function endsWithBlank(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size < 2) return true;
      const buf = Buffer.alloc(2);
      fs.readSync(fd, buf, 0, 2, size - 2);
      return buf[0] === 0x0a && buf[1] === 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true;
  }
}
