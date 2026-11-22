// 转录服务：实时去重、首见跳过历史、回补只补新的
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { createTranscriptStore } from '../src/core/transcript-store.mjs';
import { createTranscriptService } from '../src/core/transcript-service.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-svc-'));
const iso = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime();

function writeLog(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(records.map((r) => zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')))));
}

function human(seq, time) {
  return { type: 'user/message', seq, time, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第' + seq + '句' }] } };
}

function rig() {
  const root = tmp();
  const vault = path.join(root, 'vault');
  const sessionsRoot = path.join(root, 'sessions');
  const stateFile = path.join(root, 'state.json');
  const store = createTranscriptStore({ root: vault, agent: 'agent.dsh' });
  const svc = createTranscriptService({ store, sessionsRoot, stateFile, log: () => {} });
  return { root, vault, sessionsRoot, stateFile, store, svc };
}

test('实时事件只写一次，同一 seq 再来不吃', () => {
  const { svc, vault } = rig();
  svc.start();
  const session = { id: 'session-abcd1234-x', cwd: 'D:\\RAG' };
  assert.equal(svc.noteEvent(session, human(1, iso(2026, 11, 20, 15, 0, 1))), true);
  assert.equal(svc.noteEvent(session, human(1, iso(2026, 11, 20, 15, 0, 1))), false);
  assert.equal(svc.noteEvent(session, human(2, iso(2026, 11, 20, 15, 0, 2))), true);
  const file = path.join(vault, '记录', '日志', 'agent.dsh-raw', '2026-11-20', '会话-abcd1234.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.split('第1句').length - 1, 1, '只出现一次');
  assert.equal(text.split('第2句').length - 1, 1);
});

test('第一次见到老日志：只记位置，不把历史重抄一遍', () => {
  const { svc, sessionsRoot, vault, stateFile } = rig();
  const file = path.join(sessionsRoot, 'D-RAG', 'session-old00001', 'session.v3.jsonl.zstd');
  writeLog(file, [human(1, iso(2026, 11, 19, 10, 0, 0)), human(2, iso(2026, 11, 19, 10, 0, 1))]);
  svc.start();
  const raw = path.join(vault, '记录', '日志', 'agent.dsh-raw');
  assert.equal(fs.existsSync(raw), false, '历史不该被重抄进库');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions['session-old00001'];
  assert.equal(st.offset, fs.statSync(file).size, '位置记在文件末尾');
});

test('日志长出来之后，回补只补新事件', () => {
  const { svc, sessionsRoot, vault } = rig();
  const file = path.join(sessionsRoot, 'D-RAG', 'session-new00001', 'session.v3.jsonl.zstd');
  writeLog(file, [human(1, iso(2026, 11, 20, 10, 0, 0))]);
  svc.start(); // 首见：跳过

  fs.appendFileSync(file, zstdCompressSync(Buffer.from(JSON.stringify(human(2, iso(2026, 11, 20, 10, 0, 5))) + '\n')));
  const written = svc.backfillSession({ id: 'session-new00001', path: file, cwd: 'D-RAG', size: fs.statSync(file).size });
  assert.equal(written, 1);
  const out = path.join(vault, '记录', '日志', 'agent.dsh-raw', '2026-11-20', '会话-new00001.md');
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /第2句/);
  assert.equal(/第1句/.test(text), false, '首见之前的历史不该补进来');
});

test('老状态重放不会重复写（seq 去重）', () => {
  const { svc, sessionsRoot } = rig();
  const file = path.join(sessionsRoot, 'D-RAG', 'session-dup000001', 'session.v3.jsonl.zstd');
  writeLog(file, [human(5, iso(2026, 11, 20, 10, 0, 0))]);
  svc.start();
  // 假装上次跑到 seq=7
  svc.state.sessions['session-dup000001'].lastSeq = 7;
  fs.appendFileSync(file, zstdCompressSync(Buffer.from(JSON.stringify(human(6, iso(2026, 11, 20, 10, 0, 1))) + '\n')));
  const written = svc.backfillSession({ id: 'session-dup000001', path: file, cwd: 'D-RAG', size: fs.statSync(file).size });
  assert.equal(written, 0, 'seq 6 <= 7，不该写');
});


test('库路径还没到：先不消费，等路径来了照原样补回来', () => {
  const { svc, store, vault } = rig();
  store.setRoot('');
  svc.start();
  const session = { id: 'session-late00001', cwd: 'D:\\RAG' };
  assert.equal(svc.noteEvent(session, human(1, iso(2026, 11, 20, 15, 0, 1))), false);
  assert.equal(svc.state.sessions['session-late00001'], undefined, '没写进去就不许记游标');

  store.setRoot(vault);
  assert.equal(svc.noteEvent(session, human(1, iso(2026, 11, 20, 15, 0, 1))), true, '路径到了还能补上');
  const file = path.join(vault, '记录', '日志', 'agent.dsh-raw', '2026-11-20', '会话-late00001.md');
  assert.match(fs.readFileSync(file, 'utf8'), /第1句/);
});

test('backfillRecent：路径到了之后把这段时间攒的补进来', () => {
  const { svc, store, sessionsRoot, vault } = rig();
  store.setRoot('');
  svc.start();
  const file = path.join(sessionsRoot, 'D-RAG', 'session-late00002', 'session.v3.jsonl.zstd');
  writeLog(file, [human(1, iso(2026, 11, 20, 11, 0, 0))]);
  svc.state.sessions['session-late00002'] = { offset: 0, lastSeq: -1 };
  store.setRoot(vault);
  const r = svc.backfillRecent();
  assert.ok(r.touched >= 1);
  const out = path.join(vault, '记录', '日志', 'agent.dsh-raw', '2026-11-20', '会话-late00002.md');
  assert.match(fs.readFileSync(out, 'utf8'), /第1句/);
});

test('工具结果跟名字对得上：结果那条自己不带工具名，靠调用时记的 id', () => {
  const { svc, vault } = rig();
  svc.start();
  const session = { id: 'session-tool00001', cwd: 'D:\\RAG' };
  const t0 = iso(2026, 11, 20, 15, 0, 0);
  svc.noteEvent(session, {
    type: 'assistant/message', seq: 1, time: t0,
    data: { message: { content: [
      { type: 'text', text: '我看看' },
      { type: 'tool-call', id: 'call_x1', name: 'read', arguments: '{"path":"a.md"}' },
    ] } },
  });
  svc.noteEvent(session, {
    type: 'tool/result', seq: 2, time: t0 + 1000,
    data: { message: { content: [{ type: 'tool-result', toolCallId: 'call_x1', isError: false, content: [{ type: 'text', text: '文件内容' }] }] } },
  });
  const file = path.join(vault, '记录', '日志', 'agent.dsh-raw', '2026-11-20', '会话-tool00001.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /· 工具 · read · 成功（4 字）/);
  assert.match(text, /```text\n文件内容\n```/);
  assert.equal(/path/.test(text), false, '参数不许漏进来');
});
test('没起服务就不收事件（避免启动瞬间的心跳混进来）', () => {
  const { svc } = rig();
  assert.equal(svc.noteEvent({ id: 'session-x1', cwd: '' }, human(1, Date.now())), false);
});
