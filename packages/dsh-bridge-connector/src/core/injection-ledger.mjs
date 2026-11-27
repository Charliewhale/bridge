// 注入审计账本：只追加，一行一条事件。
//
// 和 injections.json 的分工：
//   injections.json —— 快照，回答「现在有哪些注入项、各自用了几次」
//   本文件         —— 事件流，回答「哪一轮、哪个会话、真的带进去了什么」
//
// 只记事实，不记正文：正文每轮从磁盘实时读，记下来既没意义又会把账本撑爆。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_LEDGER_FILE = path.join(os.homedir(), '.dsh-bridge', 'injection-ledger.jsonl');

export function createLedger({
  file = DEFAULT_LEDGER_FILE,
  now = () => Date.now(),
  // 写失败必须有人知道：「账本没记上」和「没发生过」是两件事。
  onError = null,
} = {}) {
  function report(error) {
    if (typeof onError !== 'function') return;
    try {
      onError(error);
    } catch {
      // 连报告都失败就只能放弃，但绝不让它反过来影响调用方
    }
  }
  function append(event) {
    if (!file) return;
    const ts = now();
    // ts/iso 放在展开之后：调用方传什么都盖不掉真实时间
    const row = { ...event, ts, iso: new Date(ts).toISOString() };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    } catch (error) {
      // 账本写不进去不该影响注入本身，但也不能假装写成功了
      report(error);
    }
  }

  function read(limit = 0) {
    if (!file) return [];
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const rows = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        // 断电写坏半行：跳过，不阻断后面所有记录
      }
    }
    const n = Number(limit);
    return n > 0 ? rows.slice(-n) : rows;
  }

  return { append, read };
}
