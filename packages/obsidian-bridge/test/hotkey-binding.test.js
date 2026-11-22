'use strict';
// 快捷键写入：Obsidian 的 hotkeyManager 只把 setHotkeys 存在内存里，
// 真正落盘要靠 save()（内部是 vault.writeConfigJson('hotkeys', customKeys)）。
// 2026-11-22 的 bug：只 setHotkeys 不 save，面板显示「已设为」，重启/重开面板就回到默认。
const test = require('node:test');
const assert = require('node:assert/strict');

const { bindHotkey, readHotkeys } = require('../src/lib/hotkey-binding.js');

// 按 Obsidian 1.12.7 的真实语义做一个假表：
//   customKeys 只存自定义；getHotkeys 只返回自定义；默认键另一处；save 才落盘。
function fakeManager({ defaults = {}, refuse = false, ignoreWrites = false } = {}) {
  const custom = {};
  const disk = {};
  return {
    disk,
    custom,
    getHotkeys: (id) => custom[id],
    getDefaultHotkeys: (id) => defaults[id],
    setHotkeys(id, list) {
      if (refuse) throw new Error('refused');
      if (ignoreWrites) return;
      custom[id] = list;
    },
    save() {
      for (const k of Object.keys(disk)) delete disk[k];
      Object.assign(disk, JSON.parse(JSON.stringify(custom)));
      return Promise.resolve();
    },
  };
}

const combo = [{ modifiers: ['Mod', 'Alt'], key: 'm' }];

test('绑定必须落盘：只 setHotkeys 不 save，重启就回到默认', async () => {
  const mgr = fakeManager();
  const ok = await bindHotkey(mgr, 'obsidian-bridge:bridge-mark-point', combo);
  assert.equal(ok, true);
  assert.deepEqual(mgr.disk['obsidian-bridge:bridge-mark-point'], combo, '必须调用 save 才会写进 hotkeys.json');
});

test('读当前绑定：没自定义时回落到默认键（面板不该显示「无」）', () => {
  const mgr = fakeManager({ defaults: { 'obsidian-bridge:bridge-mark-point': combo } });
  assert.deepEqual(readHotkeys(mgr, 'obsidian-bridge:bridge-mark-point'), combo);

  const mgr2 = fakeManager({ defaults: { 'obsidian-bridge:bridge-mark-point': combo } });
  mgr2.custom['obsidian-bridge:bridge-mark-point'] = [{ modifiers: ['Mod'], key: 'k' }];
  assert.deepEqual(readHotkeys(mgr2, 'obsidian-bridge:bridge-mark-point'), [{ modifiers: ['Mod'], key: 'k' }], '自定义优先');
});

test('管理器拒收 / 吞掉写入时返回 false，不假装成功', async () => {
  assert.equal(await bindHotkey(fakeManager({ refuse: true }), 'c', combo), false);
  assert.equal(await bindHotkey(fakeManager({ ignoreWrites: true }), 'c', combo), false);
});

test('清除 = 写成空数组（盖住默认），也要落盘', async () => {
  const mgr = fakeManager({ defaults: { c: combo } });
  const ok = await bindHotkey(mgr, 'c', []);
  assert.equal(ok, true);
  assert.deepEqual(mgr.disk.c, []);
  assert.deepEqual(readHotkeys(mgr, 'c'), [], '清掉之后不该回落到默认');
});

test('没有 hotkeyManager（旧版本/无 API）时一律安全地失败', async () => {
  assert.equal(await bindHotkey(null, 'c', combo), false);
  assert.deepEqual(readHotkeys(null, 'c'), []);
});
