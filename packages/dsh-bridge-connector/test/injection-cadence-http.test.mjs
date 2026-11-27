// 注入节奏走 HTTP：/inject 收 every/times/scope；
// 轮次由 DSH 的 turn/start 推进（测试里直接调 server.injections 模拟）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startConnector } from '../src/core/server.mjs';

function fakeSessions(promptImpl) {
  return {
    list: async () => ({ items: [{ sessionId: 's1', cwd: 'D:/a', running: false, updatedAt: 5000 }] }),
    create: async () => ({ sessionId: 's1' }),
    prompt: promptImpl || (async () => ({ accepted: true })),
  };
}

async function boot(t, promptImpl) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inj-cad-')), 'injections.json');
  const server = await startConnector({
    sessions: fakeSessions(promptImpl),
    token: 'tok',
    host: '127.0.0.1',
    port: 0,
    clientTimeZone: 'Asia/Shanghai',
    injectionState: { on: true },
    injectionFile: file,
    obsidianProbe: { editorState: async () => ({ ok: false }) },
  });
  t.after(() => server.close());
  return { base: server.url, token: 'tok', server };
}

const hdr = { 'content-type': 'application/json', 'x-bridge-token': 'tok' };

async function inject(ctx, body) {
  const res = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ sessionId: 's1', content: '正文', title: 'A.md', ...body }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function status(ctx, sessionId) {
  const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const res = await fetch(`${ctx.base}/inject${q}`, { headers: hdr });
  return (await res.json()).data;
}

async function task(ctx) {
  const res = await fetch(`${ctx.base}/task`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ sessionId: 's1', message: '嗯' }),
  });
  return res.status;
}

/** 模拟 DSH 的一轮：turn/start 定名单，turn/end 清理用满的。 */
function round(ctx, sessionId = 's1') {
  ctx.server.injections.beginDelivery(sessionId);
  const carried = ctx.server.injections.carryItems(sessionId);
  ctx.server.injections.tick(sessionId);
  return carried.length;
}

test('一共 1 次：投一条就退场', async (t) => {
  const ctx = await boot(t);
  await inject(ctx, { times: 1 });
  assert.equal((await status(ctx)).current[0].remaining, 1);
  assert.equal(await task(ctx), 200);
  round(ctx);
  assert.equal((await status(ctx)).current.length, 0);
});

test('一共 2 次：投两条之后退场，中间还剩 1 次', async (t) => {
  const ctx = await boot(t);
  await inject(ctx, { times: 2 });
  await task(ctx);
  round(ctx);
  assert.equal((await status(ctx)).current[0].used, 1);
  assert.equal((await status(ctx)).current[0].remaining, 1);
  await task(ctx);
  round(ctx);
  assert.equal((await status(ctx)).current.length, 0);
});

test('每 2 轮带一次：只有单数轮记用量', async (t) => {
  const ctx = await boot(t);
  await inject(ctx, { every: 2 });
  round(ctx); // 第 1 轮：到期
  assert.equal((await status(ctx)).current[0].used, 1);
  round(ctx); // 第 2 轮：不到期
  assert.equal((await status(ctx)).current[0].used, 1);
  round(ctx); // 第 3 轮：到期
  assert.equal((await status(ctx)).current[0].used, 2);
});

test('投递失败：用量和轮次都不前进', async (t) => {
  const ctx = await boot(t, async () => {
    throw new Error('boom');
  });
  await inject(ctx, { times: 2 });
  assert.equal(await task(ctx), 500);
  const now = await status(ctx);
  assert.equal(now.current.length, 1);
  assert.equal(now.current[0].used, 0, '没投出去不该记用量');
});

test('/inject 状态带出节奏字段，界面才能显示', async (t) => {
  const ctx = await boot(t);
  await inject(ctx, { every: 3, times: 5 });
  const item = (await status(ctx)).current[0];
  assert.equal(item.every, 3);
  assert.equal(item.times, 5);
  assert.equal(item.used, 0);
  assert.equal(item.remaining, 5);
  assert.equal(item.scope, 'local');
});

test('全局注入：s1 / s2 都能带上，状态里 scope=global', async (t) => {
  const ctx = await boot(t);
  const saved = await inject(ctx, { scope: 'global', sessionId: undefined, times: 0, title: 'G.md' });
  assert.equal(saved.data.scope, 'global');
  assert.equal(saved.data.sessionId, '*');

  assert.equal(round(ctx, 's1'), 1);
  assert.equal(round(ctx, 's2'), 1);
  assert.equal((await status(ctx, 's1')).current.length, 1);
  assert.equal((await status(ctx, 's2')).current.length, 1);
});

test('局部注入：只对绑定会话生效', async (t) => {
  const ctx = await boot(t);
  await inject(ctx, { scope: 'local', sessionId: 's1' });
  assert.equal(round(ctx, 's1'), 1);
  assert.equal(round(ctx, 's2'), 0);
  assert.equal((await status(ctx, 's2')).current.length, 0);
});

test('clear 支持按 scope 清：清全局不动局部', async (t) => {
  const ctx = await boot(t);
  await inject(ctx, { scope: 'global', sessionId: undefined, title: 'G.md' });
  await inject(ctx, { scope: 'local', sessionId: 's1', title: 'L.md' });

  const res = await fetch(`${ctx.base}/inject/clear`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ scope: 'global' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await status(ctx, 's1')).current.map((x) => x.title), ['L.md']);
});

test('refresh 强制下一次投递忽略间隔，并把路径带出来给面板应用', async (t) => {
  const ctx = await boot(t);
  await inject(ctx, { every: 10, path: 'A.md', absPath: 'D:/tmp/A.md' });
  const item = (await status(ctx)).current[0];
  assert.equal(item.path, 'A.md', 'GET /inject 要带 path，面板改参数时才能重新注入');

  const res = await fetch(`${ctx.base}/inject/refresh`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ sessionId: 's1' }),
  });
  assert.equal(res.status, 200);
  assert.equal(round(ctx, 's1'), 1, 'refresh 后下一次投递要忽略 every 带一次');
});
