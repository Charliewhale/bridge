// 转录格式：只留人和人说的话，工具只记「用了什么」，不搬参数和回显。
// 2026-11-21 定的形状（辞玖：转录里工具参数等冗余太多，只留简洁对话 + 工具名）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEEP_TYPES,
  toTranscriptEvent,
  renderEntry,
  renderHeader,
  shortIdOf,
  dayOf,
  hhmmssOf,
} from '../src/core/transcript-format.mjs';

const at = (iso) => Date.parse(iso);

test('只认对话和上下文压缩；轮次、工具回显、系统提示都不进转录', () => {
  assert.ok(KEEP_TYPES['user/message']);
  assert.ok(KEEP_TYPES['assistant/message']);
  assert.ok(KEEP_TYPES['compaction/summary']);
  for (const t of ['step/start', 'tool/call', 'tool/result', 'turn/start', 'turn/end', 'system/message', 'session']) {
    assert.equal(
      toTranscriptEvent({ type: t, seq: 1, time: at('2026-11-20T15:22:37+08:00'), data: { turn: 1 } }),
      null,
      t + ' 不该进转录'
    );
  }
});

test('没有时间的记录不猜时间', () => {
  assert.equal(
    toTranscriptEvent({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] } }),
    null
  );
});

test('user/message：只收真人说的，正文原样', () => {
  const human = toTranscriptEvent({
    type: 'user/message',
    seq: 10,
    time: at('2026-11-20T15:22:37+08:00'),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '改个名' }] },
  });
  assert.equal(human.role, 'user');
  assert.equal(human.body, '改个名');
  assert.deepEqual(human.tools, []);

  const plugin = toTranscriptEvent({
    type: 'user/message',
    seq: 10,
    time: at('2026-11-20T15:22:37+08:00'),
    data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'policy changed' }] },
  });
  assert.equal(plugin, null);
});

test('assistant/message：只有正文，工具只留名字不搬参数', () => {
  const ev = toTranscriptEvent({
    type: 'assistant/message',
    seq: 11,
    time: at('2026-11-20T15:22:40+08:00'),
    data: {
      message: {
        content: [
          { type: 'text', text: '我先看看' },
          { type: 'tool-call', name: 'pwsh', arguments: '{"command":"dir"}' },
          { type: 'tool-call', name: 'obsidian_call', arguments: '{"op":"x"}' },
          { type: 'tool-call', name: 'pwsh', arguments: '{"command":"ls"}' },
        ],
      },
    },
  });
  assert.equal(ev.role, 'assistant');
  assert.equal(ev.body, '我先看看');
  assert.deepEqual(ev.tools, ['pwsh', 'obsidian_call']);
  assert.equal(renderEntry(ev), '## 15:22:40 · 我\n\n我先看看\n\n> 用了 2 个工具：pwsh、obsidian_call\n');
});

test('只调工具不说话的那条也要留个痕，别整条消失', () => {
  const ev = toTranscriptEvent({
    type: 'assistant/message',
    seq: 12,
    time: at('2026-11-20T15:22:41+08:00'),
    data: { message: { content: [{ type: 'tool-call', name: 'obsidian_exec', arguments: '{}' }] } },
  });
  assert.equal(ev.body, '');
  assert.equal(renderEntry(ev), '## 15:22:41 · 我\n\n（没有文字）\n\n> 用了 1 个工具：obsidian_exec\n');
});

test('thinking 默认不收，要的话折进 details', () => {
  const rec = {
    type: 'assistant/message',
    seq: 13,
    time: at('2026-11-20T15:22:41+08:00'),
    data: { message: { content: [{ type: 'text', text: '答' }, { type: 'reasoning', text: '想' }] } },
  };
  assert.equal(toTranscriptEvent(rec).body, '答');
  assert.match(toTranscriptEvent(rec, { withReasoning: true }).body, /<details><summary>思考<\/summary>[\s\S]*想/);
});

test('上下文压缩那一条保留（对话里会引用它）', () => {
  const ev = toTranscriptEvent({
    type: 'compaction/summary',
    seq: 3,
    time: at('2026-11-20T15:22:39+08:00'),
    data: { message: { content: [{ type: 'text', text: '摘要' }] } },
  });
  assert.equal(ev.role, 'system');
  assert.equal(ev.body, '（上下文被压缩，摘要如下）\n\n摘要');
});

test('标题按「你 / 我」写，一眼看出是谁在说', () => {
  assert.equal(
    renderEntry({ role: 'user', timeMs: at('2026-11-20T09:05:06+08:00'), body: '在吗', tools: [] }),
    '## 09:05:06 · 你\n\n在吗\n'
  );
  assert.equal(
    renderEntry({ role: 'system', timeMs: at('2026-11-20T09:05:06+08:00'), body: 'x', tools: [] }),
    '## 09:05:06 · 系统\n\nx\n'
  );
});

test('篇头带会话 id 和 cwd，格式稳定', () => {
  assert.equal(
    renderHeader({ agent: 'agent.dsh', day: '2026-11-20', label: '会话-5bc95a76', session: 'session-5bc95a76-651d', cwd: 'D:\\RAG' }),
    '# agent.dsh · 2026-11-20 · 会话-5bc95a76\n\n' +
      '> 由 dsh-bridge-connector 从 DSH 会话日志**按会话**组装；只留对话和用过的工具名，工具参数与回显不抄。同一会话后续内容**直接追加在文末**（跨天才新建一篇）。\n>\n' +
      '> 会话 id：`session-5bc95a76-651d` · cwd：`D:\\RAG`\n\n'
  );
});

test('会话短名、日期、时刻按本地时区', () => {
  assert.equal(shortIdOf('session-712f4f31-4faa-49a2-8df3-06b03686990f'), '712f4f31');
  assert.equal(shortIdOf('session-sched-task-3'), 'sched');
  assert.equal(shortIdOf(''), '');
  assert.equal(dayOf(Date.parse('2026-11-20T23:59:59+08:00')), '2026-11-20');
  assert.equal(dayOf(Date.parse('2026-11-21T00:00:01+08:00')), '2026-11-21');
  assert.equal(hhmmssOf(Date.parse('2026-11-20T09:05:06+08:00')), '09:05:06');
});
