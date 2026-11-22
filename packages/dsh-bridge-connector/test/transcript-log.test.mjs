// 增量读 DSH 会话日志 + 按天按会话写转录笔记
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { listSessionFiles, decodeFrom } from '../src/core/session-log.mjs';
import { createTranscriptStore } from '../src/core/transcript-store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tx-'));
const iso = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime();

function writeLog(file, records, { truncateLastFrame = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const frames = records.map((r) => zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')));
  let buf = Buffer.concat(frames);
  if (truncateLastFrame) buf = buf.subarray(0, buf.length - 3);
  fs.writeFileSync(file, buf);
  return buf.length;
}

test('日志文件能被找出来，带 cwd 和短 id', () => {
  const root = tmp();
  const file = path.join(root, 'D-RAG', 'session-abc12345-1', 'session.v3.jsonl.zstd');
  writeLog(file, [{ type: 'session', seq: 0, time: iso(2026, 11, 20, 15, 0, 0) }]);
  const list = listSessionFiles(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'session-abc12345-1');
  assert.equal(list[0].cwd, 'D-RAG');
  assert.ok(list[0].size > 0);
});

test('从偏移续读：只回后面的，偏移停在没写全的那一帧之前', () => {
  const root = tmp();
  const file = path.join(root, 'x', 'session-s1', 'session.v3.jsonl.zstd');
  const recs = [
    { type: 'turn/start', seq: 1, time: iso(2026, 11, 20, 15, 0, 1), data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: iso(2026, 11, 20, 15, 0, 2), data: { turn: 1, reason: { kind: 'ok' } } },
    { type: 'turn/start', seq: 3, time: iso(2026, 11, 20, 15, 0, 3), data: { turn: 2 } },
  ];
  writeLog(file, recs);

  const all = decodeFrom(file, 0);
  assert.deepEqual(all.records.map((r) => r.seq), [1, 2, 3]);
  assert.equal(all.offsetAfter, fs.statSync(file).size);

  const second = decodeFrom(file, all.offsetAfter);
  assert.deepEqual(second.records, []);
  assert.equal(second.offsetAfter, all.offsetAfter);

  // 追加后从旧偏移续读，只拿到新的
  const more = Buffer.concat([
    zstdCompressSync(Buffer.from(JSON.stringify({ type: 'turn/end', seq: 4, time: iso(2026, 11, 20, 15, 0, 4), data: { turn: 2, reason: { kind: 'ok' } } }) + '\n')),
  ]);
  fs.appendFileSync(file, more);
  const third = decodeFrom(file, all.offsetAfter);
  assert.deepEqual(third.records.map((r) => r.seq), [4]);
});

test('最后一帧没写全时不吞数据：偏移退回到它的起点', () => {
  const root = tmp();
  const file = path.join(root, 'x', 'session-s2', 'session.v3.jsonl.zstd');
  const good = [
    { type: 'turn/start', seq: 1, time: iso(2026, 11, 20, 15, 0, 1), data: { turn: 1 } },
    { type: 'turn/start', seq: 2, time: iso(2026, 11, 20, 15, 0, 2), data: { turn: 2 } },
  ];
  const full = writeLog(file, good);
  const frame2 = zstdCompressSync(Buffer.from(JSON.stringify(good[1]) + '\n'));
  const cut = full - frame2.length;
  // 把最后一帧腰斩（切掉一半，绝不可能解出来）
  const buf = fs.readFileSync(file);
  fs.writeFileSync(file, buf.subarray(0, full - Math.floor(frame2.length / 2) - 2));

  const r = decodeFrom(file, 0);
  assert.deepEqual(r.records.map((x) => x.seq), [1], '坏帧之前的照收');
  assert.equal(r.offsetAfter, cut, '偏移停在坏帧起点，等它写全再读');
});

test('转录按天按会话落盘：先建篇头，后续追加不重写篇头', () => {
  const root = tmp();
  const store = createTranscriptStore({ root: path.join(root, 'vault'), agent: 'agent.dsh' });
  const day1 = [
    { seq: 1, timeMs: iso(2026, 11, 20, 15, 22, 37), role: 'system', body: '（摘要）', tools: [] },
    { seq: 2, timeMs: iso(2026, 11, 20, 15, 22, 40), role: 'user', body: '改个名', tools: [] },
  ];
  store.appendEvents({ sessionId: 'session-712f4f31-4faa-49a2-8df3-06b03686990f', cwd: 'D:\\RAG', events: day1 });
  const file = path.join(root, 'vault', '记录', '日志', 'agent.dsh-raw', '2026-11-20', '会话-712f4f31.md');
  const first = fs.readFileSync(file, 'utf8');
  assert.match(first, /^# agent\.dsh · 2026-11-20 · 会话-712f4f31\n/);
  assert.match(first, /## 15:22:37 · 系统\n\n（摘要）\n/);
  assert.match(first, /## 15:22:40 · 你\n\n改个名\n/);

  store.appendEvents({
    sessionId: 'session-712f4f31-4faa-49a2-8df3-06b03686990f',
    cwd: 'D:\\RAG',
    events: [{ seq: 3, timeMs: iso(2026, 11, 20, 15, 23, 0), role: 'assistant', body: '看完了', tools: ['pwsh'] }],
  });
  const second = fs.readFileSync(file, 'utf8');
  assert.equal(second.split('# agent.dsh').length, 2, '篇头只出现一次');
  assert.match(second, /## 15:23:00 · 我\n\n看完了\n\n> 用了 1 个工具：pwsh\n/);
  assert.ok(second.startsWith(first), '老内容原样保留，只在末尾长');
});

test('跨天会新建一篇，不是把新的一天塞进旧文件', () => {
  const root = tmp();
  const store = createTranscriptStore({ root: path.join(root, 'vault'), agent: 'agent.dsh' });
  store.appendEvents({
    sessionId: 'session-s1',
    events: [{ seq: 1, timeMs: iso(2026, 11, 20, 23, 59, 59), role: 'user', body: 'a', tools: [] }],
  });
  store.appendEvents({
    sessionId: 'session-s1',
    events: [{ seq: 2, timeMs: iso(2026, 11, 21, 0, 0, 1), role: 'user', body: 'b', tools: [] }],
  });
  const base = path.join(root, 'vault', '记录', '日志', 'agent.dsh-raw');
  assert.ok(fs.existsSync(path.join(base, '2026-11-20', '会话-s1.md')));
  assert.ok(fs.existsSync(path.join(base, '2026-11-21', '会话-s1.md')));
});


test('库路径记在盘上：重启后不用等插件再推一次', () => {
  const root = tmp();
  const stateFile = path.join(root, 'vault.json');
  const a = createTranscriptStore({ root: '', agent: 'agent.dsh', stateFile });
  assert.equal(a.root, '', '没有记录时就是空的');
  a.setRoot('D:\\个人数据\\辞玖');
  const b = createTranscriptStore({ root: '', agent: 'agent.dsh', stateFile });
  assert.equal(b.root, 'D:\\个人数据\\辞玖', '下次启动自己捡回来');
});
test('没有库路径就什么都不写，也不炸', () => {
  const store = createTranscriptStore({ root: '' });
  const r = store.appendEvents({ sessionId: 'session-s1', events: [{ seq: 1, timeMs: Date.now(), role: 'user', body: 'x', tools: [] }] });
  assert.equal(r.written, 0);
});
