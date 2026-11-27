'use strict';
// Bridge · 设置归一化
// 凡是外部写进来的设置（data.json）都先过这里：非法值回默认，绝不把坏配置带进运行时。

const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  port: 8811,
  defaultLevel: 'read',
  token: '',
  permissions: null,
  ledger: true,
  chatSessionId: '',
  chatOpen: false,
  injectionEnabled: false,
  // 注入节奏：每 N 轮带一次（1 = 每次都带）；times 一共带几次（0 = 不限期）
  // 全局和当前会话各有一套，互不影响。
  globalInjectEvery: 1,
  globalInjectTimes: 0,
  sessionInjectEvery: 1,
  sessionInjectTimes: 0,
  // 旧字段保留兼容：读旧配置时当 session 的默认值，写回时同步成 session 的值。
  injectEvery: 1,
  injectTimes: 0,
  // 会话转录：把 DSH 会话里"谁说了什么、用过什么工具"写进库里。
  // 默认关——装了插件就往别人库里写文件不合适，要用户自己点头。
  transcript: false,
  tokenTtl: 0,
  tokenIssuedAt: 0,
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const LEVELS = new Set(['read', 'write', 'trust']);

function clampEvery(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(99, Math.floor(n)) : 1;
}

function clampTimes(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(99, Math.floor(n)) : 0;
}

function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const port = Number.isInteger(src.port) && src.port >= 1 && src.port <= 65535 ? src.port : DEFAULTS.port;
  const host = typeof src.host === 'string' && LOOPBACK.has(src.host) ? src.host : DEFAULTS.host;
  const defaultLevel = LEVELS.has(src.defaultLevel) ? src.defaultLevel : DEFAULTS.defaultLevel;
  // token 有效期：0 = 永久；负数/垃圾值一律当永久（不放宽也不收紧）。
  const tokenTtl = Number.isFinite(src.tokenTtl) && src.tokenTtl > 0 ? src.tokenTtl : 0;
  const tokenIssuedAt = Number.isFinite(src.tokenIssuedAt) && src.tokenIssuedAt > 0 ? src.tokenIssuedAt : 0;
  const enabled = typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.enabled;
  const token = typeof src.token === 'string' ? src.token : '';
  const permissions = src.permissions && typeof src.permissions === 'object' ? src.permissions : null;
  const ledger = typeof src.ledger === 'boolean' ? src.ledger : DEFAULTS.ledger;
  const chatSessionId = typeof src.chatSessionId === 'string' ? src.chatSessionId : '';
  const chatOpen = typeof src.chatOpen === 'boolean' ? src.chatOpen : false;
  const injectionEnabled = typeof src.injectionEnabled === 'boolean' ? src.injectionEnabled : false;

  // 新字段优先；旧配置只有 injectEvery / injectTimes 时，把它当 session 的默认值。
  const sessionEveryRaw = src.sessionInjectEvery !== undefined ? src.sessionInjectEvery : src.injectEvery;
  const sessionTimesRaw = src.sessionInjectTimes !== undefined ? src.sessionInjectTimes : src.injectTimes;
  const sessionInjectEvery = clampEvery(sessionEveryRaw);
  const sessionInjectTimes = clampTimes(sessionTimesRaw);
  const globalInjectEvery = clampEvery(src.globalInjectEvery);
  const globalInjectTimes = clampTimes(src.globalInjectTimes);

  const transcript = typeof src.transcript === 'boolean' ? src.transcript : DEFAULTS.transcript;

  return {
    enabled,
    host,
    port,
    defaultLevel,
    token,
    permissions,
    ledger,
    chatSessionId,
    chatOpen,
    injectionEnabled,
    globalInjectEvery,
    globalInjectTimes,
    sessionInjectEvery,
    sessionInjectTimes,
    // 兼容旧代码/旧界面
    injectEvery: sessionInjectEvery,
    injectTimes: sessionInjectTimes,
    transcript,
    tokenTtl,
    tokenIssuedAt,
  };
}

// 注入开关只有一个真相源：连接器（真正执行注入的是它）。
// 本地值只是缓存，不一致时以远端为准；远端读不到（没连上/旧版本）就不许乱改本地。
function reconcileInjection({ remote, local } = {}) {
  const known = typeof remote === 'boolean';
  if (!known) return { value: local === true, changed: false, unknown: true };
  const value = remote === true;
  return { value, changed: value !== (local === true) };
}

module.exports = {
  reconcileInjection, DEFAULTS, normalizeSettings, normalizeSettingsSafe: normalizeSettings };
