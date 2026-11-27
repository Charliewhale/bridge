// 注入范围：全局（所有会话）与局部（绑定会话）
// 先写规格，再实现；现有 injection.test / cadence 继续跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInjectionStore } from '../src/core/injection.mjs';

test('全局注入：两个不同会话都能带上', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ scope: 'global', content: '全局正文', title: 'G.md', every: 1, times: 0 }));

  store.beginDelivery('s1');
  assert.deepEqual(store.carryItems('s1').map((x) => x.title), ['G.md']);

  store.beginDelivery('s2');
  assert.deepEqual(store.carryItems('s2').map((x) => x.title), ['G.md']);
});

test('局部注入：只对绑定会话生效', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ scope: 'local', sessionId: 's1', content: '局部正文', title: 'L.md' }));

  store.beginDelivery('s1');
  assert.deepEqual(store.carryItems('s1').map((x) => x.title), ['L.md']);

  store.beginDelivery('s2');
  assert.equal(store.carryItems('s2').length, 0);
});

test('全局上限跨会话累计，带满就从当前列表退场', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ scope: 'global', content: 'G', title: 'G.md', every: 1, times: 2 }));

  store.beginDelivery('s1');
  assert.equal(store.carryItems('s1').length, 1);
  store.tick('s1');
  assert.equal(store.currentItems('s2').length, 1, '才一次，还在');

  store.beginDelivery('s2');
  assert.equal(store.carryItems('s2').length, 1);
  store.tick('s2');
  assert.equal(store.currentItems('s3').length, 0, '两次用满，任何会话都不再带');
});

test('全局 every 按每个会话自己的轮次算', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ scope: 'global', content: 'G', title: 'G.md', every: 2, times: 0 }));

  const hits = [];
  for (let round = 1; round <= 4; round += 1) {
    store.beginDelivery('s1');
    hits.push(store.carryItems('s1').length > 0);
  }
  assert.deepEqual(hits, [true, false, true, false]);

  store.beginDelivery('s2');
  assert.equal(store.carryItems('s2').length, 1, '另一个会话从它自己的第 1 轮重新算');
});

test('当前会话列表 = 全局 + 自己的局部，不带别的会话局部', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ scope: 'global', content: 'G', title: 'G.md' }));
  store.markCurrent(store.add({ scope: 'local', sessionId: 's1', content: 'L1', title: 'L1.md' }));
  store.markCurrent(store.add({ scope: 'local', sessionId: 's2', content: 'L2', title: 'L2.md' }));

  assert.deepEqual(store.currentItems('s1').map((x) => x.title).sort(), ['G.md', 'L1.md']);
  assert.deepEqual(store.currentItems('s2').map((x) => x.title).sort(), ['G.md', 'L2.md']);
});

test('全局和局部可以有同名笔记，不互相覆盖', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ scope: 'global', content: '全局版', title: '同名.md' }));
  store.markCurrent(store.add({ scope: 'local', sessionId: 's1', content: '局部版', title: '同名.md' }));

  assert.equal(store.currentItems('s1').length, 2);
  const local = store.currentItems('s1').find((x) => x.scope === 'local');
  assert.equal(local.content, '局部版');
});

test('clearCurrent 能按范围清：只清全局不动局部', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ scope: 'global', content: 'G', title: 'G.md' }));
  store.markCurrent(store.add({ scope: 'local', sessionId: 's1', content: 'L', title: 'L.md' }));

  store.clearCurrent({ scope: 'global' });
  assert.deepEqual(store.currentItems('s1').map((x) => x.title), ['L.md']);
});

test('旧记录没有 scope 时按局部处理', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ sessionId: 's1', content: '旧', title: 'old.md' }));
  store.beginDelivery('s1');
  assert.equal(store.carryItems('s1').length, 1);
  store.beginDelivery('s2');
  assert.equal(store.carryItems('s2').length, 0);
});

test('forceNext 忽略间隔带一次，之后恢复原节奏', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ scope: 'global', content: 'G', title: 'G.md', every: 10, times: 0 }));
  store.forceNext('s1');
  store.beginDelivery('s1');
  assert.equal(store.carryItems('s1').length, 1);
  store.tick('s1');
  store.beginDelivery('s1');
  assert.equal(store.carryItems('s1').length, 0, '强制只生效一次，之后按 every=10');
});
