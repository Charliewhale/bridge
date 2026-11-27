// 注入行为留痕：每次真的把内容带进系统提示词，要留下一条可回查的事件。
// 状态文件只说明「现在有哪些注入项」，说明不了「哪一轮、哪个会话、带了几次」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInjectionStore } from '../src/core/injection.mjs';

function collect() {
  const events = [];
  return { events, ledger: (ev) => events.push(ev) };
}

test('有一篇该带时，记一条 due（会话、轮次、带了哪几篇）', () => {
  const { events, ledger } = collect();
  const store = createInjectionStore({ ledger });
  store.markCurrent(store.add({ scope: 'global', content: '正文', title: 'G.md', every: 1, times: 0 }));

  store.beginDelivery('s1');

  const due = events.filter((e) => e.type === 'due');
  assert.equal(due.length, 1);
  assert.equal(due[0].sessionId, 's1');
  assert.equal(due[0].round, 1);
  assert.deepEqual(due[0].items.map((x) => x.title), ['G.md']);
  assert.deepEqual(due[0].items.map((x) => x.id), ['inj-1']);
});

test('没到 every 的那一轮不记 due', () => {
  const { events, ledger } = collect();
  const store = createInjectionStore({ ledger });
  store.markCurrent(store.add({ scope: 'local', sessionId: 's1', content: 'x', title: 'L.md', every: 2, times: 0 }));

  store.beginDelivery('s1'); // 第 1 轮：带
  store.beginDelivery('s1'); // 第 2 轮：不带

  assert.deepEqual(events.filter((e) => e.type === 'due').map((e) => e.round), [1]);
});

test('投递回退也留痕：把上一轮的 due 标记成回退', () => {
  const { events, ledger } = collect();
  const store = createInjectionStore({ ledger });
  store.markCurrent(store.add({ scope: 'local', sessionId: 's1', content: 'x', title: 'L.md', every: 1, times: 0 }));

  store.beginDelivery('s1');
  store.rollbackDelivery('s1');

  const rb = events.filter((e) => e.type === 'rollback');
  assert.equal(rb.length, 1);
  assert.equal(rb[0].sessionId, 's1');
  assert.equal(rb[0].round, 1);
});

test('不传 ledger 时行为不变，也不报错', () => {
  const store = createInjectionStore();
  store.markCurrent(store.add({ scope: 'local', sessionId: 's1', content: 'x', title: 'L.md' }));
  assert.doesNotThrow(() => store.beginDelivery('s1'));
  assert.equal(store.carryItems('s1').length, 1);
});

test('ledger 自己抛错不能打断注入', () => {
  const store = createInjectionStore({ ledger: () => { throw new Error('磁盘满了'); } });
  store.markCurrent(store.add({ scope: 'local', sessionId: 's1', content: 'x', title: 'L.md' }));
  assert.doesNotThrow(() => store.beginDelivery('s1'));
  assert.equal(store.carryItems('s1').length, 1);
});

test('真的被提示词段取走时记 render，同一轮只记一次', () => {
  const { events, ledger } = collect();
  const store = createInjectionStore({ ledger });
  store.markCurrent(store.add({ scope: 'local', sessionId: 's1', content: 'x', title: 'L.md' }));
  store.beginDelivery('s1');

  store.carryItems('s1');
  store.carryItems('s1');

  const renders = events.filter((e) => e.type === 'render');
  assert.equal(renders.length, 1);
  assert.equal(renders[0].sessionId, 's1');
  assert.equal(renders[0].round, 1);
  assert.deepEqual(renders[0].items.map((x) => x.title), ['L.md']);
});

test('定了要带但提示词段没来取，只记 due 不记 render', () => {
  const { events, ledger } = collect();
  const store = createInjectionStore({ ledger });
  store.markCurrent(store.add({ scope: 'local', sessionId: 's1', content: 'x', title: 'L.md' }));

  store.beginDelivery('s1');

  assert.equal(events.filter((e) => e.type === 'due').length, 1);
  assert.equal(events.filter((e) => e.type === 'render').length, 0);
});
test('ledger 抛错时通过 onError 报告，注入照常进行', () => {
  const seen = [];
  const store = createInjectionStore({
    ledger: () => {
      throw new Error('盘满了');
    },
    onError: (err) => seen.push(err),
  });
  store.markCurrent(store.add({ scope: 'local', sessionId: 's1', content: 'x', title: 'L.md' }));

  assert.doesNotThrow(() => store.beginDelivery('s1'));
  assert.equal(seen.length, 1, '留痕失败必须有人知道');
  assert.equal(store.carryItems('s1').length, 1, '但注入本身不能受影响');
});