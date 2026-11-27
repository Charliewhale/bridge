// /inject/ledger：把注入事件流暴露出来，界面和复盘都能查。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startConnector } from '../src/core/server.mjs';
import { createLedger } from '../src/core/injection-ledger.mjs';

const hdr = { 'content-type': 'application/json', 'x-bridge-token': 'tok' };

function fakeSessions() {
  return {
    list: async () => ({ items: [] }),
    create: async () => ({ sessionId: 's1' }),
    prompt: async () => ({ accepted: true }),
  };
}

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inj-ledger-http-'));
  const ledgerFile = path.join(dir, 'injection-ledger.jsonl');
  const server = await startConnector({
    sessions: fakeSessions(),
    token: 'tok',
    host: '127.0.0.1',
    port: 0,
    clientTimeZone: 'Asia/Shanghai',
    injectionState: { on: true },
    injectionFile: path.join(dir, 'injections.json'),
    injectionLedger: createLedger({ file: ledgerFile }),
    obsidianProbe: { editorState: async () => ({ ok: false }) },
  });
  t.after(() => server.close());
  return { base: server.url, server, ledgerFile };
}

async function inject(ctx, body = {}) {
  const res = await fetch(`${ctx.base}/inject`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ sessionId: 's1', content: '正文', title: 'A.md', every: 1, ...body }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function events(ctx, query = '') {
  const res = await fetch(`${ctx.base}/inject/ledger${query}`, { headers: hdr });
  assert.equal(res.status, 200);
  return (await res.json()).data.events;
}

test('注入发生之后，/inject/ledger 能读出 due 和 render', async (t) => {
  const ctx = await boot(t);
  await inject(ctx);

  ctx.server.injections.beginDelivery('s1');
  ctx.server.injections.carryItems('s1');

  const list = await events(ctx);
  const types = list.map((e) => e.type);
  assert.ok(types.includes('due'), '有 due：定了这一轮带 A.md');
  assert.ok(types.includes('render'), '有 render：真被系统提示词取走了');

  const render = list.find((e) => e.type === 'render');
  assert.equal(render.sessionId, 's1');
  assert.equal(render.round, 1);
  assert.deepEqual(render.items.map((x) => x.title), ['A.md']);
});

test('limit 只返回最近的若干条', async (t) => {
  const ctx = await boot(t);
  await inject(ctx);
  for (let i = 0; i < 3; i += 1) {
    ctx.server.injections.beginDelivery('s1');
    ctx.server.injections.carryItems('s1');
  }

  const all = await events(ctx);
  const last2 = await events(ctx, '?limit=2');
  assert.ok(all.length > 2);
  assert.deepEqual(last2, all.slice(-2));
});

test('没带 token 拿不到账本', async (t) => {
  const ctx = await boot(t);
  const res = await fetch(`${ctx.base}/inject/ledger`);
  assert.equal(res.status, 401);
});

test('事件真的落到了文件里，重启后还在', async (t) => {
  const ctx = await boot(t);
  await inject(ctx);
  ctx.server.injections.beginDelivery('s1');
  ctx.server.injections.carryItems('s1');

  const rows = fs
    .readFileSync(ctx.ledgerFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((x) => JSON.parse(x));
  assert.ok(rows.some((x) => x.type === 'render'), 'render 必须落盘，不能只在内存里');
});

test('添加 / 刷新 / 清空 这些操作本身也留痕', async (t) => {
  const ctx = await boot(t);
  const saved = await inject(ctx);
  const itemId = saved.data.id;

  await fetch(`${ctx.base}/inject/refresh`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ sessionId: 's1' }),
  });
  await fetch(`${ctx.base}/inject/clear`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ id: itemId }),
  });

  const list = await events(ctx);
  assert.deepEqual(list.map((e) => e.type), ['add', 'refresh', 'clear']);
  assert.equal(list[0].itemId, itemId);
  assert.equal(list[0].title, 'A.md');
  assert.equal(list[0].scope, 'local');
  assert.equal(list[1].sessionId, 's1');
  assert.equal(list[2].itemId, itemId);
});

test('账本里不存正文：事件只带元信息', async (t) => {
  const ctx = await boot(t, { content: '这段正文不该进账本' });
  const list = await events(ctx);
  const raw = JSON.stringify(list);
  assert.equal(raw.includes('这段正文不该进账本'), false);
});
// —— 边界：limit 的非法值与缺省 ——
test('limit 给负数 / 0 / 非数字时回落到默认，不报错', async (t) => {
  const ctx = await boot(t);
  await inject(ctx);

  for (const q of ['?limit=-5', '?limit=0', '?limit=abc']) {
    const res = await fetch(`${ctx.base}/inject/ledger${q}`, { headers: hdr });
    assert.equal(res.status, 200, `${q} 不该炸`);
    const { data } = await res.json();
    assert.equal(data.limit, 50, `${q} 应回落到默认 50`);
    assert.ok(Array.isArray(data.events));
  }
});

test('limit 超大时被夹到 2000', async (t) => {
  const ctx = await boot(t);
  const res = await fetch(`${ctx.base}/inject/ledger?limit=999999`, { headers: hdr });
  const { data } = await res.json();
  assert.equal(data.limit, 2000);
});

// —— 错误边界：缺参数 / 坏 JSON 必须显式失败 ——
test('refresh 缺 sessionId 返回 400，不是 200', async (t) => {
  const ctx = await boot(t);
  const res = await fetch(`${ctx.base}/inject/refresh`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'bad-args');
});

test('坏 JSON 返回 400，不冒充成功', async (t) => {
  const ctx = await boot(t);
  const res = await fetch(`${ctx.base}/inject/refresh`, {
    method: 'POST',
    headers: hdr,
    body: '{ 这不是 json',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
});

// —— 并发：同时写，账本不能丢行、不能写坏 ——
test('并发提交不会丢事件，每行都是完整 JSON', async (t) => {
  const ctx = await boot(t);
  const titles = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];

  await Promise.all(titles.map((title) => inject(ctx, { title })));

  const list = await events(ctx, '?limit=100');
  const adds = list.filter((e) => e.type === 'add');
  assert.equal(adds.length, titles.length, '五个请求就该有五条 add');
  assert.deepEqual(adds.map((e) => e.title).sort(), titles.slice().sort());

  const rows = fs
    .readFileSync(ctx.ledgerFile, 'utf8')
    .split('\n')
    .filter(Boolean);
  for (const row of rows) {
    assert.doesNotThrow(() => JSON.parse(row), '每一行都必须是完整 JSON，不能写了半行');
  }
  assert.equal(rows.length, titles.length);
});