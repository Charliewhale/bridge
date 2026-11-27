// 注入审计账本：只追加，一行一条事件。
// 目的不是复现内容，而是回答「这一轮到底带没带、带了什么、哪个会话」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/core/injection-ledger.mjs';

function tmpFile(name = 'ledger.jsonl') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-ledger-'));
  return path.join(dir, 'nested', name);
}

function lines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
}

test('append 一条事件，落成一行合法 JSON 且带时间戳', () => {
  const file = tmpFile();
  const ledger = createLedger({ file, now: () => 1700000000000 });

  ledger.append({ type: 'deliver', sessionId: 's1', round: 3, items: [{ id: 'inj-1' }] });

  assert.equal(fs.existsSync(file), true, '父目录要自动创建');
  const row = JSON.parse(lines(file)[0]);
  assert.equal(row.type, 'deliver');
  assert.equal(row.sessionId, 's1');
  assert.equal(row.round, 3);
  assert.equal(row.ts, 1700000000000);
  assert.equal(row.iso, new Date(1700000000000).toISOString());
});

test('多次 append 是追加，不覆盖前面的行', () => {
  const file = tmpFile();
  let t = 1000;
  const ledger = createLedger({ file, now: () => (t += 1) });

  ledger.append({ type: 'deliver', round: 1 });
  ledger.append({ type: 'deliver', round: 2 });
  ledger.append({ type: 'rollback', round: 2 });

  const rows = lines(file).map((x) => JSON.parse(x));
  assert.deepEqual(rows.map((x) => x.type), ['deliver', 'deliver', 'rollback']);
  assert.deepEqual(rows.map((x) => x.round), [1, 2, 2]);
});

test('read 按行返回最近的若干条', () => {
  const file = tmpFile();
  let t = 0;
  const ledger = createLedger({ file, now: () => (t += 1) });
  for (let i = 1; i <= 5; i += 1) ledger.append({ type: 'deliver', round: i });

  assert.deepEqual(ledger.read(2).map((x) => x.round), [4, 5]);
  assert.equal(ledger.read().length, 5);
});

test('文件不存在时 read 返回空数组，不抛错', () => {
  const ledger = createLedger({ file: tmpFile('nothing.jsonl') });
  assert.deepEqual(ledger.read(), []);
});

test('坏行被跳过，好行照读', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"type":"deliver","round":1}\nnot json\n{"type":"deliver","round":2}\n', 'utf8');

  assert.deepEqual(createLedger({ file }).read().map((x) => x.round), [1, 2]);
});

test('显式 file=null 时 append 不落盘也不报错（默认落标准路径）', () => {
  const ledger = createLedger({ file: null });
  assert.doesNotThrow(() => ledger.append({ type: 'deliver', round: 1 }));
  assert.deepEqual(ledger.read(), []);
});

// —— 错误边界：写不进账本时必须报告，不能静默 ——
test('账本写失败通过 onError 报出来，不静默丢', () => {
  const seen = [];
  const ledger = createLedger({
    file: unwritableFile(),
    onError: (err) => seen.push(err),
  });

  assert.doesNotThrow(() => ledger.append({ type: 'deliver', round: 1 }));
  assert.equal(seen.length, 1, '写失败必须让调用方知道');
  assert.ok(String(seen[0].message || seen[0]).length > 0, '错误信息不能是空的');
});

test('没给 onError 时写失败也不炸，且 read 仍返回空', () => {
  const ledger = createLedger({ file: unwritableFile() });
  assert.doesNotThrow(() => ledger.append({ type: 'deliver', round: 1 }));
  assert.deepEqual(ledger.read(), []);
});

// 跨平台的「写不进去」：先建一个普通文件，再让路径穿过它，
// 在文件底下建目录，Windows 和 Linux 都报 ENOTDIR。
// 别用 Z: 这种盘符：Linux 上反斜杠只是文件名字符，会真的写成功。
function unwritableFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inj-bad-"));
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x", "utf8");
  return path.join(blocker, "ledger.jsonl");
}

