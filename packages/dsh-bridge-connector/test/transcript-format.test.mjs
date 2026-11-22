// 转录格式（2026-11-21 定稿）：对话原文 + 工具名 + 工具结果，参数不抄
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEEP_TYPES,
  TOOL_RESULT_LIMIT,
  toTranscriptEvent,
  renderEntry,
  renderHeader,
  clipResult,
  shortIdOf,
  dayOf,
  hhmmssOf,
} from '../src/core/transcript-format.mjs';

const at = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime();

test('进转录的：轮次、对话、工具结果、上下文压缩', () => {
  for (const t of ['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/result', 'compaction/summary']) {
    assert.ok(KEEP_TYPES[t], t);
  }
  for (const t of ['step/start', 'tool/call', 'system/message', 'session']) {
    assert.equal(toTranscriptEvent({ type: t, seq: 1, time: at(2026, 11, 20, 15, 22, 37), data: { turn: 1 } }), null, t);
  }
});

test('轮次当路标：只有一行「第 N 轮开始 / 结束」', () => {
  const start = toTranscriptEvent({ type: 'turn/start', seq: 1, time: at(2026, 11, 20, 15, 22, 37), data: { turn: 52 } });
  assert.equal(start.role, 'turn');
  assert.equal(renderEntry(start), '## 15:22:37 · 第 52 轮开始\n');

  const end = toTranscriptEvent({
    type: 'turn/end', seq: 2, time: at(2026, 11, 20, 15, 33, 10), data: { turn: 52, reason: { kind: 'completed' } },
  });
  assert.equal(renderEntry(end), '## 15:33:10 · 第 52 轮结束（completed）\n');
});

test('没有时间的记录不猜时间', () => {
  assert.equal(toTranscriptEvent({ type: 'turn/start', seq: 1, data: { turn: 1 } }), null);
});

test('user/message：只收真人说的', () => {
  const human = toTranscriptEvent({
    type: 'user/message',
    seq: 10,
    time: at(2026, 11, 20, 15, 22, 37),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '改个名' }] },
  });
  assert.equal(human.role, 'user');
  assert.equal(human.body, '改个名');
  assert.equal(
    toTranscriptEvent({
      type: 'user/message',
      seq: 10,
      time: at(2026, 11, 20, 15, 22, 37),
      data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'x' }] },
    }),
    null
  );
});

test('assistant/message：正文 + 去重后的工具名，参数不进来', () => {
  const ev = toTranscriptEvent({
    type: 'assistant/message',
    seq: 11,
    time: at(2026, 11, 20, 15, 22, 40),
    data: {
      message: {
        content: [
          { type: 'text', text: '我先看看' },
          { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"dir"}' },
          { type: 'tool-call', id: 'call_2', name: 'obsidian_call', arguments: '{"op":"x"}' },
          { type: 'tool-call', id: 'call_3', name: 'pwsh', arguments: '{"command":"ls"}' },
        ],
      },
    },
  });
  assert.equal(ev.body, '我先看看');
  assert.deepEqual(ev.tools, ['pwsh', 'obsidian_call']);
  assert.deepEqual(ev.calls, [
    { id: 'call_1', name: 'pwsh' },
    { id: 'call_2', name: 'obsidian_call' },
    { id: 'call_3', name: 'pwsh' },
  ]);
  assert.equal(renderEntry(ev), '## 15:22:40 · 我\n\n我先看看\n\n> 用了 2 个工具：pwsh、obsidian_call\n');
});

test('tool/result：留结果正文，标成功/失败和字数', () => {
  const ev = toTranscriptEvent({
    type: 'tool/result',
    seq: 12,
    time: at(2026, 11, 20, 15, 22, 42),
    data: {
      message: {
        content: [{ type: 'tool-result', toolCallId: 'call_1', isError: false, content: [{ type: 'text', text: '输出结果' }] }],
      },
    },
  });
  assert.equal(ev.role, 'tool');
  assert.equal(ev.ok, true);
  assert.equal(ev.chars, 4);
  assert.equal(ev.toolOf, 'call_1');
  assert.equal(renderEntry({ ...ev, tool: 'pwsh' }), '## 15:22:42 · 工具 · pwsh · 成功（4 字）\n\n```text\n输出结果\n```\n');
});

test('失败的结果标成失败，而且一个字都不截', () => {
  const long = 'x'.repeat(TOOL_RESULT_LIMIT + 3000);
  const ev = toTranscriptEvent({
    type: 'tool/result',
    seq: 13,
    time: at(2026, 11, 20, 15, 22, 43),
    data: {
      message: {
        content: [{ type: 'tool-result', toolCallId: 'call_9', isError: true, content: [{ type: 'text', text: long }] }],
      },
    },
  });
  assert.equal(ev.ok, false);
  const out = renderEntry({ ...ev, tool: 'edit' });
  assert.match(out, /· 工具 · edit · 失败（5000 字）/);
  assert.ok(out.includes(long), '失败的堆栈要全留');
  assert.equal(/这里留了前/.test(out), false, '失败不该有截断说明');
});

test('空结果不要；正文里带三个反引号时围栏自动加长', () => {
  assert.equal(
    toTranscriptEvent({
      type: 'tool/result',
      seq: 14,
      time: at(2026, 11, 20, 15, 22, 44),
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'c', content: [{ type: 'text', text: '   ' }] }] } },
    }),
    null
  );
  const r = renderEntry({ role: 'tool', timeMs: at(2026, 11, 20, 9, 0, 0), tool: 'read', ok: true, chars: 9, body: '```\nx\n```' });
  assert.ok(r.includes('````text'), '围栏要比正文里最长的反引号还长');
});

test('结果超长就截断，并写明截了多少', () => {
  const long = 'x'.repeat(TOOL_RESULT_LIMIT + 500);
  const c = clipResult(long);
  assert.equal(c.clipped, true);
  assert.equal(c.text.length, TOOL_RESULT_LIMIT);
  assert.equal(c.total, TOOL_RESULT_LIMIT + 500);
  const out = renderEntry({ role: 'tool', timeMs: at(2026, 11, 20, 9, 0, 0), tool: 'read', ok: true, chars: long.length, body: long });
  assert.match(out, /共 2500 字，这里留了前 2000 字/);
});

test('上下文压缩那条保留', () => {
  const ev = toTranscriptEvent({
    type: 'compaction/summary',
    seq: 3,
    time: at(2026, 11, 20, 15, 22, 39),
    data: { message: { content: [{ type: 'text', text: '摘要' }] } },
  });
  assert.equal(ev.role, 'system');
  assert.match(ev.body, /摘要/);
});

test('标题里的称呼和篇头格式', () => {
  assert.equal(renderEntry({ role: 'user', timeMs: at(2026, 11, 20, 9, 5, 6), body: '在吗', tools: [] }), '## 09:05:06 · 你\n\n在吗\n');
  const head = renderHeader({ agent: 'agent.dsh', day: '2026-11-20', label: '会话-x', session: 'session-x', cwd: 'D:\\RAG' });
  assert.match(head, /^# agent\.dsh · 2026-11-20 · 会话-x\n/);
  assert.match(head, /工具参数不记/);
  assert.match(head, /会话 id：`session-x` · cwd：`D:\\RAG`/);
});

test('短名、日期、时刻', () => {
  assert.equal(shortIdOf('session-712f4f31-4faa-49a2-8df3-06b03686990f'), '712f4f31');
  assert.equal(shortIdOf('session-sched-task-3'), 'sched');
  assert.equal(dayOf(new Date(2026, 10, 20, 23, 59, 59).getTime()), '2026-11-20');
  assert.equal(hhmmssOf(new Date(2026, 10, 20, 9, 5, 6).getTime()), '09:05:06');
});
