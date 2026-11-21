// /vault：插件把库根目录推上来，连接器据此决定转录写哪儿
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startConnector } from '../src/core/server.mjs';

const hdr = { 'content-type': 'application/json', 'x-bridge-token': 'tok' };

async function boot(t) {
  let root = '';
  const transcriptStore = {
    setRoot(next) {
      root = String(next || '');
    },
    get root() {
      return root;
    },
  };
  const server = await startConnector({
    sessions: { list: async () => ({ items: [] }), create: async () => ({ sessionId: 's1' }), prompt: async () => ({ accepted: true }) },
    token: 'tok',
    host: '127.0.0.1',
    port: 0,
    injectionState: { on: true },
    injectionFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')), 'inj.json'),
    obsidianProbe: { editorState: async () => ({ ok: false }) },
    transcriptStore,
  });
  t.after(() => server.close());
  return { server, base: server.url, transcriptStore };
}

test('推库路径进来就记下，能读回去', async (t) => {
  const ctx = await boot(t);
  let res = await fetch(`${ctx.base}/vault`, { headers: hdr });
  assert.equal((await res.json()).data.root, '');

  res = await fetch(`${ctx.base}/vault`, {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify({ path: 'D:\\个人数据\\辞玖' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.root, 'D:\\个人数据\\辞玖');
  assert.equal(ctx.transcriptStore.root, 'D:\\个人数据\\辞玖');

  res = await fetch(`${ctx.base}/vault`, { headers: hdr });
  assert.equal((await res.json()).data.root, 'D:\\个人数据\\辞玖');
});

test('空路径等于「现在没有库」，不写坏别处', async (t) => {
  const ctx = await boot(t);
  await fetch(`${ctx.base}/vault`, { method: 'POST', headers: hdr, body: JSON.stringify({ path: 'D:\\个人数据\\辞玖' }) });
  const res = await fetch(`${ctx.base}/vault`, { method: 'POST', headers: hdr, body: JSON.stringify({ path: '' }) });
  assert.equal((await res.json()).data.root, '');
});
