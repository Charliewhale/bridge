'use strict';
// 快捷键读写：包住 Obsidian 的 hotkeyManager，保证「显示的就是实际生效的」。
//
// 这里有两条从 Obsidian 1.12.7 源码里读出来的硬事实（别再凭感觉写）：
//   1. `setHotkeys` 只改内存（customKeys），**必须再调 `save()`** 才写进 .obsidian/hotkeys.json；
//      不 save 的话，当前这轮还能按，重启/重载插件之后就回到默认——2026-11-22 就是这么翻车的。
//   2. `getHotkeys` **只返回自定义**，默认键在 `getDefaultHotkeys` 里；
//      只读 getHotkeys 会把「有默认键」误显示成「无」。
//
// 另外 `save()` 写的是整个 customKeys 快照，所以一次绑定只调一次即可。

/** 当前生效的绑定：自定义优先，没有就用默认。 */
function readHotkeys(manager, commandId) {
  if (!manager || typeof manager.getHotkeys !== 'function') return [];
  try {
    const custom = manager.getHotkeys(commandId);
    if (Array.isArray(custom)) return custom;
    const fallback = typeof manager.getDefaultHotkeys === 'function' ? manager.getDefaultHotkeys(commandId) : null;
    return Array.isArray(fallback) ? fallback : [];
  } catch {
    return [];
  }
}

function sameBinding(a, b) {
  return (
    Array.isArray(a) &&
    a.length === b.length &&
    a.every(
      (h, i) =>
        h &&
        b[i] &&
        h.key === b[i].key &&
        (Array.isArray(h.modifiers) ? h.modifiers : []).join('+') ===
          (Array.isArray(b[i].modifiers) ? b[i].modifiers : []).join('+')
    )
  );
}

/**
 * 绑定一组快捷键并落盘。
 * @returns {Promise<boolean>} 真的写进 customKeys 且 save 成功才 true。
 */
async function bindHotkey(manager, commandId, list) {
  if (!manager || typeof manager.setHotkeys !== 'function') return false;
  const wanted = Array.isArray(list) ? list : [];
  try {
    manager.setHotkeys(commandId, wanted);
  } catch {
    return false;
  }
  // 回读确认它真收下了：有的组合会被 Obsidian 拒（键位冲突/格式不认），不能假装成功
  const after = readHotkeys(manager, commandId);
  if (!sameBinding(after, wanted)) return false;
  if (typeof manager.save === 'function') {
    try {
      await manager.save();
    } catch {
      return false;
    }
  }
  return true;
}

module.exports = { bindHotkey, readHotkeys };
