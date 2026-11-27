'use strict';
// Bridge · 主面板（整合视图）
// 左 1/3：状态、功能按钮、最近操作记录；右 2/3：与 DSH 会话的对话。

const { ItemView, Notice, Modal, Setting, TFolder, MarkdownRenderer } = require('obsidian');
const fs = require('node:fs');
const { parseLedger } = require('./ledger-reader.js');
const { reconcileInjection } = require('./settings.js');
const { pickReplyAnchor } = require('./scroll-anchor.js');
const { HISTORY_LIMIT, transcriptState, mergeTranscript } = require('./session-context.js');
const { rewriteLocalImages } = require('./image-embed.js');
const { displayTextOf } = require('./panel-text.js');
const { tailPathOf, planTree } = require('./session-tree.js');

const VIEW_TYPE = 'bridge-chat';
const RECENT_LIMIT = 15;

function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class BridgeChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
    this.assistantBuffer = '';
    this.steerMode = false; // false = 排队等这一轮结束；true = 打断当前一轮
    this.pending = [];      // 合并盒：连发的消息先攒在这里
    this.pendingTimer = null;
    this.mergeWindowMs = 1500; // 最后一次输入后等这么久再合并发出
    this.sessionId = null;
    // 每切一次会话 +1：历史请求靠它认住自己属于哪一次切换
    this._switchToken = 0;
    this.ac = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Bridge';
  }

  getIcon() {
    return 'message-square';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('bridge-panel');

    const main = root.createDiv({ cls: 'bridge-panel-main' });
    this.sideEl = main.createDiv({ cls: 'bridge-panel-side' });
    this.chatEl = main.createDiv({ cls: 'bridge-panel-chat' });

    this.renderSide();
    this.renderChat();

    // 不做定时轮询：窗口拿回焦点时对一次账（注入开关变了、或者断线期间漏了事件）
    this.registerDomEvent(window, 'focus', () => {
      this.refreshRemoteState();
      this.refreshUsage();
    });

    await this.ensureSession();
    this.refreshRemoteState();
  }

  onClose() {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
    // 用户主动关掉面板：下次启动别再自己弹出来
    this.plugin.settings.chatOpen = false;
    this.plugin.persistSettings();
    this.disconnect();
  }

  // ── 左栏：状态 / 按钮 / 操作记录 ────────────────────────────
  renderSide() {
    const side = this.sideEl;
    side.empty();

    const grid = side.createDiv({ cls: 'bridge-actions' });
    const levelBtn = grid.createEl('button', { cls: 'bridge-action-btn bridge-level-btn', text: '档位 —' });
    this.levelBtn = levelBtn;
    levelBtn.onClickEvent(() => {
      const perms = this.plugin.permissions;
      if (!perms) {
        new Notice('Bridge 服务未运行');
        return;
      }
      const order = ['read', 'write', 'trust'];
      const cur = perms.levelOf('agent.dsh');
      const next = order[(order.indexOf(cur) + 1) % order.length];
      try {
        perms.setLevel('agent.dsh', next);
        new Notice(`DSH 档位：${next}`);
      } catch (err) {
        new Notice(String((err && err.message) || err));
      }
      this.refreshLevel();
    });
    this.refreshLevel();
    const addBtn = (label, fn) => {
      const b = grid.createEl('button', { cls: 'bridge-action-btn', text: label });
      b.onClickEvent(fn);
      return b;
    };
    addBtn('注入', () => this.openInjectionPanel());
    addBtn('复制 token', () => this.plugin.copyToken());
    addBtn('选择会话', () => this.openSessionPicker());
    addBtn('新建会话', () => this.createAndBind());
    addBtn('操作记录', () => this.plugin.openLog());
  }

  refreshLevel() {
    if (!this.levelBtn) return;
    const perms = this.plugin.permissions;
    this.levelBtn.setText(`档位 ${perms ? perms.levelOf('agent.dsh') : '—'}`);
    this.levelBtn.disabled = !perms;
  }

  refreshLocalState() {
    this.refreshLevel();
    if (!this.metaEl) return;    const core = this.plugin.core;
    const parts = [core ? `Bridge ${core.port}` : 'Bridge 未运行', this.sessionId ? `会话 ${this.sessionId.slice(0, 12)}` : '未绑定会话'];
    this.metaEl.setText(parts.join(' · '));
    this.metaEl.toggleClass('is-off', !core);
  }

  refreshRemoteState() {
    if (!this.metaEl) return;
    const local = this.plugin.settings.injectionEnabled === true;
    this.plugin
      .connector()
      .config()
      .then((res) => {
        if (!this.metaEl) return;
        const core = this.plugin.core;
        const parts = [core ? `Bridge ${core.port}` : 'Bridge 未运行', this.sessionId ? `会话 ${this.sessionId.slice(0, 12)}` : '未绑定会话'];
        if (!res || res.ok !== true) parts.push(`注入 ${local ? '开' : '关'}（连接器离线）`);
        else parts.push(`注入 ${res.data.injection ? '开' : '关'}`);
        this.metaEl.setText(parts.join(' · '));
        this.metaEl.toggleClass('is-off', !core);
      })
      .catch(() => {});
  }

  // ── 右栏：对话 ────────────────────────────────────────────
  renderChat() {
    const root = this.chatEl;
    root.empty();

    const header = root.createDiv({ cls: 'bridge-chat-header' });
    this.statusEl = header.createSpan({ cls: 'bridge-chat-status', text: '连接中…' });
    this.sessionEl = header.createSpan({ cls: 'bridge-chat-session', text: '' });
    this.metaEl = root.createDiv({ cls: 'bridge-meta', text: '' });

    this.listEl = root.createDiv({ cls: 'bridge-chat-list' });
    // 是否贴着底部，由「用户自己的滚动」决定，而不是每次重建后再算一遍——
    // 重建那一刻 scrollHeight 还没稳定，算出来的值经常是错的，于是又把人拽到底下。
    this._stickToBottom = true;
    this.listEl.addEventListener('scroll', () => {
      this._stickToBottom = this.isAtBottom();
      this.updateJumpButton();
    });

    // 输入区做成一个整体：上面是输入框，下面一条工具条，靠右排「回底 / 打断 / 发送」
    const inputWrap = root.createDiv({ cls: 'bridge-composer' });
    this.inputEl = inputWrap.createEl('textarea', {
      cls: 'bridge-chat-textarea',
      attr: { placeholder: '跟 DSH 说点什么…（Enter 发送，Shift+Enter 换行）', rows: '3' },
    });
    const bar = inputWrap.createDiv({ cls: 'bridge-composer-bar' });
    // 上下文占用贴左边：还剩多少空间一眼能看到，不用去翻 DSH
    this.usageEl = bar.createDiv({ cls: 'bridge-composer-usage' });
    this.usageEl.setText('上下文 —');

    // 回到底部：一开始禁用，往上翻历史时才亮起来
    this.jumpEl = bar.createEl('button', { cls: 'bridge-composer-btn bridge-jump-bottom', text: '↓' });
    this.jumpEl.title = '回到最底下';
    this.jumpEl.onClickEvent(() => {
      this.scrollToBottom();
      this.updateJumpButton();
    });

    // queue = 排队等这一轮结束；steer = 立刻打断当前这一轮
    this.steerBtn = bar.createEl('button', { cls: 'bridge-composer-btn bridge-chat-steer', text: '打断' });
    this.steerBtn.title = '默认排队（等这一轮结束）。点亮「打断」则立刻插进当前这一轮。';
    this.steerBtn.onClickEvent(() => {
      this.steerMode = !this.steerMode;
      this.steerBtn.toggleClass('is-on', this.steerMode);
      new Notice(this.steerMode ? '发送模式：打断当前一轮' : '发送模式：排队等待');
    });
    this.sendBtn = bar.createEl('button', { cls: 'bridge-composer-btn bridge-chat-send', text: '发送' });
    this.sendBtn.onClickEvent(() => this.send());
    this.inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        this.send();
      }
    });

    this.render();
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.setText(text);
  }

  async ensureSession() {
    const client = this.plugin.connector();
    // 面板一打开就把库目录注册成工作区（后台跑，不阻塞）：
    // 否则从这建的会话在 DSH 侧栏里会一直落进「未分组」。
    if (this.plugin.connector().info()) this.ensureWorkspace().catch(() => {});

    if (!client.info()) {
      this.setStatus('DSH 连接器未就绪');
      this.pushSystem('没有找到 ~/.dsh-bridge/connector.json：确认 DSH 正在运行，并且 dsh-bridge-connector 已加载。');
      return;
    }

    const previous = this.plugin.settings.chatSessionId || '';
    if (previous) {
      // 复用之前先确认它还活着：DSH 那边会删会话、清理归档，
      // 存着的 id 可能是死的，直接绑定会在第一次发送时才炸（resume failed）。
      const alive = await this.sessionExists(previous);
      if (alive) {
        this.bindSession(previous);
        return;
      }
      this.plugin.settings.chatSessionId = '';
      await this.plugin.saveSettings();
      this.pushSystem(
        `上次的会话已经不存在了（${previous.slice(0, 12)}…）。` +
          '点上面「选择会话」挑一个，或者「新建会话」。'
      );
      this.setStatus('未绑定会话');
      return;
    }
    await this.createAndBind();
  }

  // 会话还在不在？读不到列表时不乱判（返回 true，让真正的发送去报错）
  async sessionExists(sessionId) {
    const res = await this.plugin.connector().sessions();
    if (!res || res.ok !== true) return true;
    const items = (res.data && res.data.sessions) || [];
    return items.some((s) => s && s.sessionId === sessionId);
  }

  // 切会话要换掉的不只是 id：窗口里的消息、流式缓冲、合并盒、
  // 上一条会话的补回复轮询，全属于旧会话，一样都不该留在新会话里。
  bindSession(sessionId) {
    this.sessionId = sessionId;
    this.plugin.settings.chatSessionId = sessionId;
    this.plugin.saveSettings();
    this._switchToken += 1;
    this.stashPendingIntoInput();
    this.messages = [];
    this.assistantBuffer = '';
    // 切过去就该看到最新那几条，而不是停在旧会话滚到的位置
    this._stickToBottom = true;
    this._renderAnchor = 'bottom';
    this.render();
    this.setStatus('已连接');
    this.refreshLocalState();
    this.connect();
    this.loadHistory();
    this.refreshUsage();
  }

  // 合并盒（攒着还没发的那几条）在切会话时清掉，但话得留着：
  // 放回输入框，既不会丢，也不会误发到刚切过去的会话里。
  stashPendingIntoInput() {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (!this.pending.length) return;
    const text = this.pending.join('\n');
    this.pending = [];
    if (!this.inputEl) return;
    const current = String(this.inputEl.value || '');
    this.inputEl.value = current.trim() ? current + '\n' + text : text;
  }

  // 拉会话列表 → 弹树（工作区 → 会话），选中就绑定
  async openSessionPicker() {
    const client = this.plugin.connector();
    if (!client.info()) {
      this.pushSystem('连接器未就绪，读不到会话列表。');
      return;
    }
    const res = await client.sessions();
    if (!res || res.ok !== true) {
      this.pushSystem('读会话列表失败：' + ((res && res.error && res.error.message) || '未知原因'));
      return;
    }
    const items = (res.data && res.data.sessions) || [];
    if (!items.length) {
      this.pushSystem('DSH 那边还没有会话。');
      return;
    }
    new SessionTreeModal(this.app, items, this.sessionId, (sessionId) => {
      this.bindSession(sessionId);
      new Notice('已切换会话');
    }, (workspaceId) => {
      this.createAndBind(workspaceId);
    }).open();
  }

  // 确保当前库目录在 DSH 里是一个工作区：没有就注册一个（标题用库名）。
  // 不注册的话，从面板新建的会话在 DSH 侧栏里会落进「未分组」。
  async ensureWorkspace(baseOverride = null) {
    try {
      const base = baseOverride || this.app.vault.adapter.getBasePath();
      if (!base) return null;
      const client = this.plugin.connector();
      const res = await client.workspaces();
      if (!res || res.ok !== true) return null;
      if (res.data && res.data.available === false) return null;
      const norm = (v) => String(v || '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
      const hit = (res.data.workspaces || []).find((w) => norm(w.path) === norm(base));
      if (hit) return hit.workspaceId;
      const created = await client.createWorkspace({ path: base, title: this.app.vault.getName() });
      if (created && created.ok) return created.data.workspaceId;
      return null;
    } catch {
      return null;
    }
  }

  async createAndBind(target = null) {
    const client = this.plugin.connector();
    if (!client.info()) {
      this.pushSystem('连接器未就绪，无法新建会话。');
      return;
    }
    const base = this.app.vault.adapter.getBasePath();
    const targetWorkspaceId = typeof target === 'string' ? target : target && target.workspaceId;
    const targetCwd = target && typeof target === 'object' ? target.cwd : null;
    // 优先用点中的工作区；没有就按那一组的 cwd 注册/查找；再不行才落到当前库。
    // 只传 cwd 不注册工作区时，DSH 侧栏会把会话归到「未分组」——所以这里先确保工作区存在。
    let workspaceId = targetWorkspaceId || null;
    if (!workspaceId && targetCwd) workspaceId = await this.ensureWorkspace(targetCwd);
    if (!workspaceId) workspaceId = await this.ensureWorkspace();
    // workspaceId 和 cwd 只能二选一（DSH 会直接拒），工作区自带路径
    const created = await client.createSession(
      workspaceId ? { workspaceId } : base ? { cwd: base } : {}
    );
    if (!created || created.ok !== true) {
      this.pushSystem('新建会话失败：' + ((created && created.error && created.error.message) || '未知原因'));
      return;
    }
    this.bindSession(created.data.sessionId);
    new Notice('已新建 Bridge 会话');
  }

  // 把会话里最近的消息读回来：面板自己不存历史，消息都在 DSH 那边。
  // 切会话后也是靠它把窗口换成新会话的上下文，所以每次绑定都重拉一次，
  // 并用切换序号认住「这次请求属于哪一次切换」——迟到的结果直接丢掉，
  // 否则慢半拍的上一条会话历史会盖到新会话的窗口上。
  async loadHistory() {
    if (!this.sessionId) return;
    const token = this._switchToken;
    const sessionId = this.sessionId;
    try {
      const res = await this.plugin.connector().transcript(sessionId, HISTORY_LIMIT);
      if (!res || res.ok !== true) return;
      const verdict = transcriptState({
        reqToken: token,
        curToken: this._switchToken,
        reqSession: sessionId,
        curSession: this.sessionId,
      });
      if (verdict !== 'apply') return;
      const items = (res.data && res.data.messages) || [];
      // 日志里有什么拿什么：这一轮还没答完也没关系，
      // 答完的内容会照常走事件补进来
      const history = items.map((m) => ({ role: m.role, text: m.text }));
      // 加载期间可能已经有新消息到了（自己刚发的、事件推来的）：
      // 历史打底，把它们接在后面，同一条不重复
      this.messages = mergeTranscript({ transcript: history, live: this.messages });
      this.render();
    } catch {
      /* 读历史失败不影响发消息 */
    }
  }

  connect() {
    this.disconnect();
    const client = this.plugin.connector();
    const ac = new AbortController();
    this.ac = ac;
    client
      .subscribe(this.sessionId, (event) => this.onEvent(event), ac.signal)
      .catch((err) => {
        if (ac.signal.aborted) return;
        // DSH 一重启，connector 进程重建，SSE 就断了。以前这里只是把状态改成
        // 「连接断开」然后什么都不做——面板从此收不到任何回复。现在自动重连。
        this.setStatus('连接断开，3 秒后重连…');
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (this.ac === ac && !ac.signal.aborted && this.sessionId) {
            this.setStatus('重连中…');
            this.connect();
            // 断线期间漏了什么不知道，重连后拉一次最近的消息兜住
            this.loadHistory();
          }
        }, 3000);
      });
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ac) {
      try {
        this.ac.abort();
      } catch {
        /* ignore */
      }
      this.ac = null;
    }
  }

  onEvent(event) {
    const type = event && event.type;
    if (type === 'turn/start') {
      this.assistantBuffer = '';
      this.setStatus('思考中…');
      return;
    }
    if (type === 'assistant/message') {
      const content = (event.data && event.data.message && event.data.message.content) || [];
      const text = Array.isArray(content)
        ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
        : '';
      // 按行排队吐出来：一次全出现会让人分不清「刚出来的」和「早就在那儿的」
      if (text) {
        this.assistantBuffer = (this.assistantBuffer || '') + text;
        this._renderAnchor = 'reply';
        this.render();
      }
      return;
    }
    if (type === 'turn/end') {
      if (this.assistantBuffer) {
        this.messages.push({ role: 'assistant', text: this.assistantBuffer });
        this.assistantBuffer = '';
        this._renderAnchor = 'reply';
      }
      this.render();
      this.setStatus('就绪');
      this.refreshUsage();
      return;
    }
    if (type === 'tool-call') {
      // 工具名一次一换、跳得厉害；状态行只留一句「执行中」
      this.setStatus('执行中…');
    }
  }

  async send() {
    const text = String((this.inputEl && this.inputEl.value) || '').trim();
    if (!text) return;
    if (!this.sessionId) {
      new Notice('还没有绑定会话');
      return;
    }
    this.inputEl.value = '';
    // 打断模式：语义就是「立刻插进去」，不合并
    if (this.steerMode) {
      await this.deliver([text], true);
      return;
    }
    // 排队模式：先进合并盒，最后一次输入后静默 1.5 秒才真发出去
    this.pending.push(text);
    // 收纳期间也要看得见：攒着不发不等于消失，否则主人以为消息丢了
    this.render();
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.flushPending();
    }, this.mergeWindowMs);
    this.setStatus(`待发送（${this.pending.length} 条，停 ${Math.round(this.mergeWindowMs / 1000)} 秒后合并）…`);
  }

  // 把合并盒里的几条拼成一条发出去
  async flushPending() {
    if (!this.pending.length) return;
    const parts = this.pending.slice();
    this.pending = [];
    this.render();
    await this.deliver(parts, false);
  }

  // 真正投递：parts 多于一条时合并成一段（中间空行分隔，保留原样）
  async deliver(parts, isSteer) {
    const text = parts.join('\n');
    this.messages.push({ role: 'user', text });
    // 自己刚发了话，理应跟到底部看回复
    this._stickToBottom = true;
    this.render();
    this.setStatus(isSteer ? '发送中…' : '排队中…');
    const res = await this.plugin.connector().sendTask({
      message: text,
      sessionId: this.sessionId,
      mode: isSteer ? 'steer' : 'queue',
    });
    if (!res || res.ok !== true) {
      const raw = (res && res.error && res.error.message) || '发送失败';
      this.setStatus('发送失败');
      if (/resume failed|not found/i.test(raw)) {
        this.pushSystem(
          `这个会话已经用不了了：${raw.slice(0, 140)}\n` +
            '点上面「选择会话」换一个，或者「新建会话」。'
        );
      } else {
        this.pushSystem(raw);
      }
      return;
    }
    // 投出去了：状态往前推一格，别一直停在「排队中」——那是在等投递，不是等回复。
    this.setStatus('已发出，等待回复…');
  }

  openInjectionPanel() {
    new InjectionPanelModal(this.app, this.plugin, this).open();
  }

  // ── 注入 ─────────────────────────────────────────────────
  pickNote(scope = 'local') {
    if (!this.plugin.settings.injectionEnabled) {
      this.pushSystem('注入已关闭。到 设置 → 社区插件 → Bridge 里打开「启用注入」。');
      return;
    }
    new NoteTreePickerModal(this.app, (file) => {
      this.injectFile(file, '', scope);
    }).open();
  }

  async injectCurrentNote(scope = 'local') {
    if (!this.plugin.settings.injectionEnabled) {
      this.pushSystem('注入已关闭。到 设置 → 社区插件 → Bridge 里打开「启用注入」。');
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.pushSystem('当前没有打开的笔记。');
      return;
    }
    const activeView = this.app.workspace.activeLeaf && this.app.workspace.activeLeaf.view;
    const editor = activeView && activeView.editor;
    const selection = editor && typeof editor.getSelection === 'function' ? editor.getSelection() : '';
    await this.injectFile(file, selection, scope);
  }

  // 注入面板里选的节奏：每几轮带一次、一共带几次

  // 上下文占用：窗口有多大、这次请求用了多少（数据来自连接器读会话日志）
  refreshUsage() {
    if (!this.usageEl) return Promise.resolve();
    const sessionId = this.sessionId;
    if (!sessionId) {
      this.usageEl.setText('上下文 —');
      return Promise.resolve();
    }
    const fmt = (n) => {
      const v = Number(n) || 0;
      if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
      if (v >= 1000) return Math.round(v / 1000) + 'k';
      return String(v);
    };
    return this.plugin
      .connector()
      .usage(sessionId)
      .then((res) => {
        if (!this.usageEl || this.sessionId !== sessionId) return;
        const data = (res && res.ok === true && res.data) || null;
        if (!data) {
          this.usageEl.setText('上下文 —');
          return;
        }
        const percent = Number(data.percent);
        const hasPercent = Number.isFinite(percent);
        const text = hasPercent
          ? '上下文 ' + percent.toFixed(1) + '%' +
            (data.window ? '（' + fmt(data.used) + ' / ' + fmt(data.window) + '）' : '')
          : '上下文 ' + fmt(data.used) + ' tokens';
        this.usageEl.setText(text);
        this.usageEl.toggleClass('is-warn', hasPercent && percent >= 70 && percent < 90);
        this.usageEl.toggleClass('is-danger', hasPercent && percent >= 90);
      })
      .catch(() => {
        if (this.usageEl && this.sessionId === sessionId) this.usageEl.setText('上下文 —');
      });
  }
  cadenceOfInject(scope = 'local') {
    const s = this.plugin.settings || {};
    const global = scope === 'global';
    const every = Number(global ? s.globalInjectEvery : s.sessionInjectEvery);
    const times = Number(global ? s.globalInjectTimes : s.sessionInjectTimes);
    return {
      every: Number.isFinite(every) && every >= 1 ? Math.min(99, Math.floor(every)) : 1,
      times: Number.isFinite(times) && times > 0 ? Math.min(99, Math.floor(times)) : 0,
    };
  }

  async injectFile(file, selection = '', scope = 'local') {
    if (scope === 'local' && !this.sessionId) {
      this.pushSystem('还没有绑定会话。');
      return;
    }
    try {
      // 只送路径，不送正文：连接器每轮自己去读磁盘，笔记改了注入就跟着变。
      // 未保存的改动本来就不该被注入——读到的是磁盘上的那一份。
      const base = this.app.vault.adapter.getBasePath();
      const absPath = base ? String(base).replace(/[\\/]+$/, '') + '/' + file.path : null;
      const res = await this.plugin.connector().inject({
        scope,
        sessionId: scope === 'local' ? this.sessionId : undefined,
        path: file.path,
        absPath,
        content: selection || '',
        title: file.path,
        kind: 'note',
        // 节奏：每 every 轮带一次；times 一共带几次（0 = 不限期）
        ...this.cadenceOfInject(scope),
      });
      if (res && res.ok) {
        const extra = selection ? `（另附选中 ${selection.length} 字）` : '';
        const { every, times } = this.cadenceOfInject(scope);
        const life =
          (every === 1 ? '每轮都带' : `每 ${every} 轮带一次`) +
          (times === 0 ? '，不限次数' : `，共 ${times} 次`);
        const where = scope === 'global' ? '全局' : '当前会话';
        this.pushSystem(`已注入《${file.path}》${extra}——${where}，${life}，实时跟随磁盘内容。`);
        this.refreshRemoteState();
      } else {
        this.pushSystem('注入失败：' + ((res && res.error && res.error.message) || '未知原因'));
      }
    } catch (err) {
      this.pushSystem('注入失败：' + String((err && err.message) || err));
    }
  }

  pushSystem(text) {
    this.messages.push({ role: 'system', text });
    this.render();
  }

  // 渲染用的基准路径：相对图片、相对附件按「正在看的那篇」解析。
  // 空字符串会让相对路径全部解析失败，图就显示不出来。
  sourcePathForRender() {
    try {
      const file = this.app.workspace.getActiveFile();
      if (file && file.path) return file.path;
    } catch {
      /* 没有活动文件就退回库根 */
    }
    return '';
  }

  // 库外的本地绝对路径（agent 存的截图之类）Obsidian 不会自己去读，
  // 先读成 data URL 再交给渲染器，图才真的显示出来。
  prepareMarkdown(text) {
    const body = String(text || '');
    try {
      return rewriteLocalImages(body, {
        vaultRoot: this.app.vault.adapter.getBasePath(),
        readFile: (target) => fs.readFileSync(target),
      });
    } catch {
      return body;
    }
  }

  // Obsidian 自带渲染器；失败就退回纯文本，不能让一条消息把面板弄崩。
  renderMarkdown(el, text) {
    const body = String(text || '');
    try {
      MarkdownRenderer.render(this.app, this.prepareMarkdown(body), el, this.sourcePathForRender(), this);
    } catch {
      el.setText(body);
    }
  }

  // 是否已经贴在最底下（往上翻看历史时不该被拽回来）
  isAtBottom() {
    const el = this.listEl;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  scrollToBottom() {
    const el = this.listEl;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  // 元素相对列表内容的位置和高度。用 rect 差值算，不受 offsetParent 影响。
  rectInList(node) {
    const el = this.listEl;
    if (!el || !node) return null;
    const nr = node.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return { top: nr.top - er.top + el.scrollTop, height: nr.height };
  }

  // 一行有多高：优先用计算样式；拿到 "normal" 就按字号估。
  lineHeightOf(node) {
    try {
      const cs = window.getComputedStyle(node);
      const lh = parseFloat(cs.lineHeight);
      if (Number.isFinite(lh) && lh > 0) return lh;
      const fs = parseFloat(cs.fontSize);
      if (Number.isFinite(fs) && fs > 0) return fs * 1.6;
    } catch {
      /* 拿不到就算了，锚点会退回气泡底部 */
    }
    return null;
  }

  // 让最后一条 AI 回复紧贴着我说的那句话出现：
  // 短消息从它顶部看起，长消息只留最后两行——回复的开头始终紧接在下面。
  // 具体算法见 scroll-anchor.js。
  scrollToReplyAnchor() {
    const el = this.listEl;
    if (!el) return;
    const kids = Array.from(el.children || []);
    let assistantTop = null;
    let userNode = null;
    let seenReply = false;
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const node = kids[i];
      if (!node.classList) continue;
      if (!seenReply) {
        if (node.classList.contains('bridge-msg-assistant')) {
          assistantTop = this.rectInList(node)?.top ?? null;
          seenReply = true;
        }
        continue;
      }
      // 回复上面最近的那句我说的话（待发气泡在回复后面，不会走到这里）
      if (node.classList.contains('bridge-msg-user')) {
        userNode = node;
        break;
      }
    }
    const userRect = userNode ? this.rectInList(userNode) : null;
    const target = pickReplyAnchor({
      userTop: userRect ? userRect.top : null,
      userHeight: userRect ? userRect.height : null,
      assistantTop,
      viewHeight: el.clientHeight,
      lineHeight: userNode ? this.lineHeightOf(userNode) : null,
    });
    // 没有可对齐的回复（比如刚打开会话）：还是滚到底
    if (target === null) {
      this.scrollToBottom();
      return;
    }
    el.scrollTop = Math.max(0, target);
  }

  updateJumpButton() {
    if (!this.jumpEl) return;
    // 在工具条里，不靠隐藏来腾位置——那样按钮会跳来跳去；
    // 改成「不可用」：位置固定，只是变灰
    const away = !this.isAtBottom();
    this.jumpEl.toggleClass('is-disabled', !away);
    this.jumpEl.title = away ? '回到最底下' : '已经在最底下了';
  }

  render() {
    if (!this.listEl) return;
    // 渲染前先记住有没有贴在底部：新消息进来时，
    // 正在往上翻的人不该被拽到底下，什么也没看清
    const stick = this._stickToBottom !== false;
    const keepTop = this.listEl.scrollTop;
    this.listEl.empty();
    for (const msg of this.messages) {
      // 时间戳、坐标行、压缩摘要这些不是主人敲的字：剥掉，剥空了就不占位
      const shown = displayTextOf(msg);
      if (!shown) continue;
      const el = this.listEl.createDiv({ cls: `bridge-msg bridge-msg-${msg.role}` });
      // 助手回复按 Markdown 渲染（代码块、列表、图片），用户自己的话保持纯文本
      if (msg.role === 'assistant') this.renderMarkdown(el, shown);
      else el.setText(shown);
    }
    if (this.assistantBuffer) {
      const el = this.listEl.createDiv({ cls: 'bridge-msg bridge-msg-assistant bridge-msg-streaming' });
      this.renderMarkdown(el, this.assistantBuffer);
    }
    // 合并盒里还攒着的：按顺序摆出来，标成「待发」，
    // 让主人知道这几句还没出去、还会合并成一条
    if (this.pending.length) {
      for (const text of this.pending) {
        const el = this.listEl.createDiv({ cls: 'bridge-msg bridge-msg-user bridge-msg-pending' });
        el.setText(text);
      }
    }
    if (stick) {
      // 刚发完自己的话就是要看自己的话（bottom）；
      // AI 回复进来则停在回复开头（reply），不让长回复把人带到底下。
      if (this._renderAnchor === 'reply') this.scrollToReplyAnchor();
      else this.scrollToBottom();
    } else {
      this.listEl.scrollTop = keepTop;
    }
    this._renderAnchor = 'bottom';
    this.updateJumpButton();
  }
}

class InjectionPanelModal extends Modal {
  constructor(app, plugin, view) {
    super(app);
    this.plugin = plugin;
    this.view = view;
    this.baseline = null;
    this.draft = null;
    this.dirty = false;
    this.busy = false;
    this.activeScope = 'global';
    this.applyBtn = null;
    this.cancelBtn = null;
    this.lists = {};
    this.statusEl = null;
    this.dirtyEl = null;
  }

  onOpen() {
    this.modalEl.addClass('bridge-inject-modal');
    this.load()
      .catch(() => {})
      .finally(() => this.render());
  }

  onClose() {
    this.contentEl.empty();
  }

  clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  normalizeItem(item) {
    return {
      id: String(item.id || ''),
      scope: item.scope === 'global' ? 'global' : 'local',
      sessionId: item.sessionId || (item.scope === 'global' ? '*' : ''),
      title: item.title || null,
      path: item.path || null,
      absPath: item.absPath || null,
      every: Number(item.every) || 1,
      times: Number(item.times) || 0,
      used: Number(item.used) || 0,
      remaining: Number(item.remaining) || 0,
      length: Number(item.length) || 0,
      content: '',
    };
  }

  async load() {
    const client = this.plugin.connector();
    let enabled = this.plugin.settings.injectionEnabled === true;
    let items = [];
    try {
      const cfg = await client.config();
      if (cfg && cfg.ok === true && cfg.data) enabled = cfg.data.injection === true;
    } catch {
      /* 连接器离线就用本地缓存，不阻断面板打开 */
    }
    try {
      const res = await client.injectStatus(this.view.sessionId);
      if (res && res.ok === true && Array.isArray(res.data.current)) {
        items = res.data.current.map((x) => this.normalizeItem(x));
      }
    } catch {
      /* 同上 */
    }
    const globalItems = items.filter((x) => x.scope === 'global');
    const localItems = items.filter((x) => x.scope !== 'global');
    const s = this.plugin.settings;
    const pick = (list, every, times) =>
      list.length ? { every: list[0].every, times: list[0].times } : { every, times };
    this.baseline = {
      enabled,
      global: pick(globalItems, s.globalInjectEvery, s.globalInjectTimes),
      session: pick(localItems, s.sessionInjectEvery, s.sessionInjectTimes),
      items: items.map((x) => ({ ...x })),
    };
    this.draft = this.clone(this.baseline);
    this.dirty = false;
  }

  snapshotKey(d) {
    if (!d) return '';
    const items = (d.items || [])
      .map((x) => [x.scope, x.sessionId || '', x.path || '', x.title || '', x.every, x.times, x.content || ''].join('|'))
      .sort();
    return JSON.stringify({
      enabled: d.enabled === true,
      global: [d.global.every, d.global.times],
      session: [d.session.every, d.session.times],
      items,
    });
  }

  markDirty() {
    this.dirty = this.snapshotKey(this.baseline) !== this.snapshotKey(this.draft);
    if (this.dirtyEl) this.dirtyEl.setText(this.dirty ? '有未应用的改动' : '');
    this.updateButtons();
  }

  updateButtons() {
    const disabled = !this.dirty || this.busy;
    if (this.applyBtn) this.applyBtn.setDisabled(disabled);
    if (this.cancelBtn) this.cancelBtn.setDisabled(disabled);
  }

  render() {
    const c = this.contentEl;
    c.empty();
    c.createEl('h3', { text: '注入' });
    c.createEl('p', {
      text: '改动暂存，应用后写入连接器。',
      cls: 'setting-item-description',
    });
    if (!this.draft) {
      c.createEl('p', { text: '读取注入状态失败，请先确认连接器在线。' });
      return;
    }

    this.statusEl = c.createDiv({
      cls: 'bridge-line',
      text: `连接器：${this.baseline.enabled ? '开' : '关'}`,
    });
    this.dirtyEl = c.createDiv({ cls: 'bridge-line bridge-dirty', text: '' });

    new Setting(c)
      .setName('启用注入')
      .addToggle((t) =>
        t.setValue(this.draft.enabled).onChange((v) => {
          this.draft.enabled = v;
          this.markDirty();
        }),
      );

    const tabs = c.createDiv({ cls: 'bridge-inject-tabs' });
    for (const [scope, label] of [['global', '全局'], ['local', '当前会话']]) {
      const btn = tabs.createEl('button', {
        cls: 'bridge-inject-tab' + (this.activeScope === scope ? ' is-active' : ''),
        text: label,
      });
      btn.onClickEvent(() => {
        this.activeScope = scope;
        this.render();
      });
    }

    this.lists = {};
    if (this.activeScope === 'local') {
      this.renderScope(c, 'local', '当前会话注入', '仅当前会话。');
    } else {
      this.renderScope(c, 'global', '全局注入', '所有会话可用；上限跨会话累计。');
    }

    const bar = new Setting(c);
    bar.settingEl.addClass('bridge-inject-actions');
    bar
      .addButton((b) => {
        this.applyBtn = b;
        b.setButtonText('应用').setCta().onClick(() => this.apply());
      })
      .addButton((b) => {
        this.cancelBtn = b;
        b.setButtonText('取消').onClick(() => this.cancel());
      });
    this.updateButtons();
  }

  renderScope(c, scope, title, desc) {
    const box = c.createDiv({ cls: 'bridge-inject-scope' });
    box.createEl('h4', { text: title });
    box.createEl('p', { text: desc, cls: 'setting-item-description' });
    this.lists[scope] = box.createDiv({ cls: 'bridge-injected-list' });
    this.renderCadence(box, scope);
    new Setting(box)
      .addButton((b) =>
        b.setButtonText('注入当前笔记').onClick(() => this.addCurrentNote(scope)),
      )
      .addButton((b) =>
        b.setButtonText('选择笔记…').onClick(() => this.pickNote(scope)),
      )
      .addButton((b) =>
        b.setButtonText('清除本区').onClick(() => this.clearScope(scope)),
      );
    this.renderList(scope);
  }

  renderCadence(c, scope) {
    const settingsKey = scope === 'global' ? 'global' : 'session';
    const cadence = this.draft[settingsKey];
    const describeEvery = (n) => (n === 1 ? '每轮都带' : '每 ' + n + ' 轮带一次');
    const describeTimes = (n) => (n === 0 ? '不限期' : '共 ' + n + ' 次');
    let everyInput = null;
    let timesInput = null;
    let everyDrop = null;
    let timesDrop = null;

    new Setting(c)
      .setName('注入间隔')
      .setDesc('每 N 轮带一次')
      .addDropdown((dd) => {
        everyDrop = dd;
        return dd
          .addOption('1', '每轮都带')
          .addOption('2', '每 2 轮')
          .addOption('3', '每 3 轮')
          .addOption('5', '每 5 轮')
          .addOption('custom', '自定义…')
          .setValue([1, 2, 3, 5].includes(cadence.every) ? String(cadence.every) : 'custom')
          .onChange((v) => {
            if (v === 'custom') {
              if (everyInput && !String(everyInput.getValue() || '').trim()) {
                everyInput.setValue(String(cadence.every > 1 ? cadence.every : 3));
              }
              return;
            }
            this.setCadence(scope, 'every', v);
            if (everyInput) everyInput.setValue('');
            new Notice('注入间隔：' + describeEvery(this.draft[settingsKey].every) + '（待应用）');
          });
      })
      .addText((txt) => {
        everyInput = txt;
        if (![1, 2, 3, 5].includes(cadence.every)) txt.setValue(String(cadence.every));
        txt.setPlaceholder('自定义 1-99').onChange((raw) => {
          const s = String(raw == null ? '' : raw).trim();
          if (!s) return;
          if (everyDrop) everyDrop.setValue('custom');
          this.setCadence(scope, 'every', s);
          new Notice('注入间隔：' + describeEvery(this.draft[settingsKey].every) + '（待应用）');
        });
      });

    new Setting(c)
      .setName('注入次数')
      .setDesc('0 = 不限期')
      .addDropdown((dd) => {
        timesDrop = dd;
        return dd
          .addOption('0', '不限期')
          .addOption('1', '只带 1 次')
          .addOption('3', '共 3 次')
          .addOption('5', '共 5 次')
          .addOption('custom', '自定义…')
          .setValue([0, 1, 3, 5].includes(cadence.times) ? String(cadence.times) : 'custom')
          .onChange((v) => {
            if (v === 'custom') {
              if (timesInput && !String(timesInput.getValue() || '').trim()) {
                timesInput.setValue(String(cadence.times > 0 ? cadence.times : 3));
              }
              return;
            }
            this.setCadence(scope, 'times', v);
            if (timesInput) timesInput.setValue('');
            new Notice('注入次数：' + describeTimes(this.draft[settingsKey].times) + '（待应用）');
          });
      })
      .addText((txt) => {
        timesInput = txt;
        if (![0, 1, 3, 5].includes(cadence.times)) txt.setValue(String(cadence.times));
        txt.setPlaceholder('自定义 0-99').onChange((raw) => {
          const s = String(raw == null ? '' : raw).trim();
          if (!s) return;
          if (timesDrop) timesDrop.setValue('custom');
          this.setCadence(scope, 'times', s);
          new Notice('注入次数：' + describeTimes(this.draft[settingsKey].times) + '（待应用）');
        });
      });
  }

  setCadence(scope, key, raw) {
    const settingsKey = scope === 'global' ? 'global' : 'session';
    const n = Number(raw);
    if (key === 'every') {
      this.draft[settingsKey].every = Number.isFinite(n) && n >= 1 ? Math.min(99, Math.floor(n)) : 1;
    } else {
      this.draft[settingsKey].times = Number.isFinite(n) && n > 0 ? Math.min(99, Math.floor(n)) : 0;
    }
    this.markDirty();
    this.renderList('global');
    this.renderList('local');
  }

  itemsFor(scope) {
    return this.draft.items.filter((x) => x.scope === scope);
  }

  renderList(scope) {
    const el = this.lists[scope];
    if (!el) return;
    el.empty();
    const globalItems = this.itemsFor('global');
    const localItems = this.itemsFor('local');
    const inherited = scope === 'local' ? globalItems : [];
    const own = scope === 'local' ? localItems : globalItems;
    const total = own.length + inherited.length;
    if (total === 0) {
      el.setText('已注入：无');
      return;
    }
    if (scope === 'local') {
      el.createDiv({
        cls: 'bridge-line',
        text: `全局 ${inherited.length} · 本会话 ${own.length}`,
      });
    } else {
      el.createDiv({ cls: 'bridge-line', text: `已注入 ${own.length} 篇：` });
    }
    const rows = [
      ...inherited.map((item) => ({ item, source: '全局', removable: false })),
      ...own.map((item) => ({ item, source: scope === 'local' ? '本会话' : '', removable: true })),
    ];
    for (const { item, source, removable } of rows) {
      const row = el.createDiv({ cls: 'bridge-injected-item' });
      row.createSpan({
        cls: 'bridge-injected-name',
        text:
          `《${item.title || '（无标题）'}》 · ${source ? source + ' · ' : ''}${item.length || 0} 字` +
          (Number(item.every) > 1 ? ` · 每 ${item.every} 轮` : '') +
          (Number(item.times) > 0 ? ` · 共 ${item.times} 次` : ''),
      });
      if (removable) {
        const edit = row.createEl('button', {
          cls: 'bridge-injected-edit',
          text: '✎',
          attr: { 'aria-label': '编辑这篇的间隔和次数', title: '编辑间隔和次数' },
        });
        edit.onClickEvent(() => this.editItem(item.id));
        const x = row.createEl('button', {
          cls: 'bridge-injected-x',
          text: '×',
          attr: { 'aria-label': '移除这篇', title: '移除这篇' },
        });
        x.onClickEvent(() => this.removeItem(item.id));
      }
    }
  }

  editItem(id) {
    const item = this.draft.items.find((x) => x.id === id);
    if (!item) return;
    new InjectionParamsModal(this.app, {
      title: '编辑注入参数',
      every: item.every,
      times: item.times,
      onSave: (every, times) => {
        item.every = every;
        item.times = times;
        item.remaining = times > 0 ? Math.max(0, times - (Number(item.used) || 0)) : 0;
        this.markDirty();
        this.renderList('global');
        this.renderList('local');
      },
    }).open();
  }

  removeItem(id) {
    this.draft.items = this.draft.items.filter((x) => x.id !== id);
    this.markDirty();
    this.renderList('global');
    this.renderList('local');
  }

  clearScope(scope) {
    this.draft.items = this.draft.items.filter((x) => x.scope !== scope);
    this.markDirty();
    this.renderList('global');
    this.renderList('local');
  }

  addCurrentNote(scope) {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice('当前没有打开的笔记');
      return;
    }
    const activeView = this.app.workspace.activeLeaf && this.app.workspace.activeLeaf.view;
    const editor = activeView && activeView.editor;
    const selection = editor && typeof editor.getSelection === 'function' ? editor.getSelection() : '';
    const base = this.draft[scope === 'global' ? 'global' : 'session'];
    new InjectionParamsModal(this.app, {
      title: '注入当前笔记',
      every: base.every,
      times: base.times,
      onSave: (every, times) => this.addFile(file, selection, scope, every, times),
    }).open();
  }

  pickNote(scope) {
    const base = this.draft[scope === 'global' ? 'global' : 'session'];
    new NoteTreePickerModal(
      this.app,
      (file, every, times) => this.addFile(file, '', scope, every, times),
      { every: base.every, times: base.times },
    ).open();
  }

  addFile(file, selection, scope, every = null, times = null) {
    const base = this.app.vault.adapter.getBasePath();
    const absPath = base ? String(base).replace(/[\\/]+$/, '') + '/' + file.path : null;
    const title = file.path;
    const idx = this.draft.items.findIndex((x) => x.scope === scope && x.title === title);
    const existing = idx >= 0 ? this.draft.items[idx] : null;
    const settingsKey = scope === 'global' ? 'global' : 'session';
    const baseParams = this.draft[settingsKey];
    const normalizedEvery = Number.isFinite(Number(every)) && Number(every) >= 1
      ? Math.min(99, Math.floor(Number(every)))
      : baseParams.every;
    const normalizedTimes = Number.isFinite(Number(times)) && Number(times) > 0
      ? Math.min(99, Math.floor(Number(times)))
      : 0;
    const item = {
      id: existing ? existing.id : 'draft-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      scope,
      sessionId: scope === 'global' ? '*' : this.view.sessionId,
      title,
      path: file.path,
      absPath,
      every: normalizedEvery,
      times: normalizedTimes,
      used: existing ? existing.used : 0,
      remaining: normalizedTimes > 0 ? Math.max(0, normalizedTimes - (existing ? existing.used : 0)) : 0,
      length: (selection || '').length,
      content: selection || '',
    };
    if (idx >= 0) this.draft.items[idx] = item;
    else this.draft.items.push(item);
    this.markDirty();
    this.renderList('global');
    this.renderList('local');
  }

  cancel() {
    if (!this.dirty || this.busy) return;
    this.draft = this.clone(this.baseline);
    this.dirty = false;
    this.render();
    new Notice('已取消，回到打开面板时的状态');
  }

  async apply() {
    if (!this.dirty || this.busy) return;
    this.busy = true;
    this.updateButtons();
    const client = this.plugin.connector();
    try {
      const cfg = await client.setInjection(this.draft.enabled);
      if (!cfg || cfg.ok !== true) throw new Error('启用状态同步失败');

      const s = this.plugin.settings;
      s.globalInjectEvery = this.draft.global.every;
      s.globalInjectTimes = this.draft.global.times;
      s.sessionInjectEvery = this.draft.session.every;
      s.sessionInjectTimes = this.draft.session.times;
      await this.plugin.saveSettings();

      const baseById = new Map(this.baseline.items.map((x) => [x.id, x]));
      const draftIds = new Set(this.draft.items.map((x) => x.id));
      for (const old of this.baseline.items) {
        if (!draftIds.has(old.id)) await client.clearInjection(old.id);
      }
      for (const item of this.draft.items) {
        const old = baseById.get(item.id);
        const changed = !old || old.every !== item.every || old.times !== item.times || (item.content || '') !== (old.content || '');
        if (!changed) continue;
        if (old) await client.clearInjection(old.id);
        const res = await client.inject({
          scope: item.scope,
          sessionId: item.scope === 'local' ? this.view.sessionId : undefined,
          path: item.path,
          absPath: item.absPath,
          content: item.content || '',
          title: item.title,
          kind: 'note',
          every: item.every,
          times: item.times,
        });
        if (!res || res.ok !== true) {
          throw new Error('同步注入项失败：' + ((res && res.error && res.error.message) || '未知原因'));
        }
      }

      const refreshed = await client.refreshInjection(this.view.sessionId);
      await this.load();
      this.busy = false;
      this.render();
      new Notice(
        refreshed && refreshed.ok === true
          ? '已应用；下一条消息会立即带上注入'
          : '已应用；连接器未升级，重启 DSH 后「立即带一次」才会生效',
      );
    } catch (err) {
      this.busy = false;
      this.updateButtons();
      new Notice('应用失败：' + String((err && err.message) || err));
      await this.load();
      this.render();
    }
  }
}

class InjectionParamsModal extends Modal {
  constructor(app, { title = '注入参数', every = 1, times = 0, onSave = null } = {}) {
    super(app);
    this.title = title;
    this.every = Number(every) || 1;
    this.times = Number(times) || 0;
    this.onSave = onSave;
  }

  onOpen() {
    this.modalEl.addClass('bridge-params-modal');
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  render() {
    const c = this.contentEl;
    c.empty();
    c.createEl('h3', { text: this.title });
    new Setting(c)
      .setName('注入间隔')
      .setDesc('每 N 轮带一次')
      .addText((t) =>
        t
          .setValue(String(this.every))
          .setPlaceholder('1-99')
          .onChange((v) => {
            const n = Number(v);
            this.every = Number.isFinite(n) && n >= 1 ? Math.min(99, Math.floor(n)) : 1;
          }),
      );
    new Setting(c)
      .setName('注入次数')
      .setDesc('0 = 不限期')
      .addText((t) =>
        t
          .setValue(String(this.times))
          .setPlaceholder('0-99')
          .onChange((v) => {
            const n = Number(v);
            this.times = Number.isFinite(n) && n > 0 ? Math.min(99, Math.floor(n)) : 0;
          }),
      );
    new Setting(c)
      .addButton((b) => b.setButtonText('取消').onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText('保存').setCta().onClick(() => {
          this.close();
          try {
            this.onSave?.(this.every, this.times);
          } catch {
            /* 回调异常不外抛 */
          }
        }),
      );
  }
}

class NoteTreePickerModal extends Modal {
  constructor(app, onPick, defaults = {}) {
    super(app);
    this.onPick = onPick;
    this.expanded = new Set();
    this.selectedPath = null;
    this.every = Number(defaults.every) || 1;
    this.times = Number(defaults.times) || 0;
  }

  onOpen() {
    this.modalEl.addClass('bridge-tree-modal');
    const active = this.app.workspace.getActiveFile();
    if (active) {
      this.selectedPath = active.path;
      let parent = active.parent;
      while (parent) {
        if (parent.path && parent.path !== '/') this.expanded.add(parent.path);
        parent = parent.parent;
      }
    }
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  render() {
    const c = this.contentEl;
    c.empty();
    c.createEl('h3', { text: '添加注入' });
    c.createDiv({ cls: 'setting-item-description', text: '选一篇笔记，再设这篇自己的间隔和次数。' });
    this.treeEl = c.createDiv({ cls: 'bridge-tree' });
    this.treeEl.style.maxHeight = '44vh';
    this.treeEl.style.overflowY = 'auto';
    const root = this.app.vault.getRoot();
    this.renderFolder(root, this.treeEl, 0);

    new Setting(c)
      .setName('注入间隔')
      .setDesc('每 N 轮带一次')
      .addText((t) =>
        t
          .setValue(String(this.every))
          .setPlaceholder('1-99')
          .onChange((v) => {
            const n = Number(v);
            this.every = Number.isFinite(n) && n >= 1 ? Math.min(99, Math.floor(n)) : 1;
          }),
      );
    new Setting(c)
      .setName('注入次数')
      .setDesc('0 = 不限期')
      .addText((t) =>
        t
          .setValue(String(this.times))
          .setPlaceholder('0-99')
          .onChange((v) => {
            const n = Number(v);
            this.times = Number.isFinite(n) && n > 0 ? Math.min(99, Math.floor(n)) : 0;
          }),
      );

    new Setting(c)
      .addButton((b) => b.setButtonText('取消').onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText('添加').setCta().onClick(() => this.confirm()),
      );
  }

  confirm() {
    const file = this.selectedPath ? this.app.vault.getAbstractFileByPath(this.selectedPath) : null;
    if (!file) {
      new Notice('先选一篇笔记');
      return;
    }
    this.close();
    try {
      this.onPick?.(file, this.every, this.times);
    } catch {
      /* 回调异常不外抛 */
    }
  }

  sortedChildren(folder) {
    const items = Array.isArray(folder.children) ? [...folder.children] : [];
    return items.sort((a, b) => {
      const af = a instanceof TFolder ? 0 : 1;
      const bf = b instanceof TFolder ? 0 : 1;
      if (af !== bf) return af - bf;
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
  }

  renderFolder(folder, parentEl, depth) {
    for (const child of this.sortedChildren(folder)) {
      if (child instanceof TFolder) {
        const open = this.expanded.has(child.path);
        const row = parentEl.createDiv({ cls: 'bridge-tree-row bridge-tree-folder' });
        row.style.paddingLeft = depth * 14 + 'px';
        row.createSpan({ cls: 'bridge-tree-arrow', text: open ? '▾' : '▸' });
        row.createSpan({ cls: 'bridge-tree-name', text: child.name });
        row.onClickEvent(() => {
          if (open) this.expanded.delete(child.path);
          else this.expanded.add(child.path);
          this.render();
        });
        if (open) this.renderFolder(child, parentEl, depth + 1);
        continue;
      }
      if (String(child.extension || '').toLowerCase() !== 'md') continue;
      const selected = child.path === this.selectedPath;
      const row = parentEl.createDiv({
        cls: 'bridge-tree-row bridge-tree-file' + (selected ? ' is-selected' : ''),
      });
      row.dataset.path = child.path;
      row.style.paddingLeft = depth * 14 + 16 + 'px';
      row.createSpan({ cls: 'bridge-tree-name', text: child.basename || child.name });
      row.onClickEvent(() => {
        this.selectedPath = child.path;
        const rows = this.treeEl.querySelectorAll('.bridge-tree-file');
        for (const el of rows) el.toggleClass('is-selected', el.dataset.path === child.path);
      });
    }
  }
}

// ── 会话选择树（工作区 → 会话）────────────────────────────

// 会话名优先用 DSH 的标题；没有就降级成「目录 · 时间 · 短 id」——总比一串 uuid 强。
function sessionLabel(s) {
  if (s && s.title) return s.title;
  const when = s && s.updatedAt ? new Date(s.updatedAt) : null;
  const stamp = when && !Number.isNaN(when.getTime())
    ? `${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ` +
      `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
    : '';
  return [tailPathOf(s && s.cwd, 1), stamp, String((s && s.sessionId) || '').slice(-6)].filter(Boolean).join(' · ');
}

class SessionTreeModal extends Modal {
  constructor(app, sessions, currentId, onPick, onNew) {
    super(app);
    this.sessions = sessions || [];
    this.currentId = currentId || null;
    this.onPick = onPick;
    this.onNew = onNew || (() => {});
    this.expanded = new Set();
  }

  onOpen() {
    this.modalEl.addClass('bridge-tree-modal');
    // 默认全部收起：某个工作区可能有几十个会话，一展开就把其他工作区
    // 全挤到滚动区下面，看起来像「只有几个工作区」。要点哪个再展开哪个。
    // 但当前会话所在的那个必须展开——不然你根本看不见自己在哪一篇。
    const plan = planTree(this.sessions, this.currentId);
    if (plan.currentKey) this.expanded.add(plan.currentKey);
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  render() {
    const c = this.contentEl;
    c.empty();
    c.createEl('h3', { text: '选择 DSH 会话' });
    // 分组依据是 DSH 的工作区注册表（不是会话的 cwd）：
    // 按 cwd 分会多出 DSH 界面里根本没有的「工作区」，两边对不上。
    // 归档会话在 DSH 里也不显示，这里一并过滤。
    const plan = planTree(this.sessions, this.currentId);
    const { groups, visible, archivedCount, hiddenBlank } = plan;
    const hidden = [
      archivedCount ? `${archivedCount} 个归档` : '',
      hiddenBlank ? `${hiddenBlank} 个空白会话` : '',
    ].filter(Boolean).join('、');
    c.createDiv({
      cls: 'setting-item-description',
      text:
        `共 ${groups.size} 个工作区 · ${visible.length} 个会话` +
        (hidden ? `（已隐藏 ${hidden}）` : '') +
        '。点工作区展开，点会话切换。',
    });

    const latestOf = (list) => Math.max(0, ...list.map((x) => Date.parse(x.updatedAt) || 0));
    const ordered = [...groups.entries()].sort((a, b) => latestOf(b[1]) - latestOf(a[1]));

    const tree = c.createDiv({ cls: 'bridge-tree' });
    for (const [cwd, list] of ordered) {
      const rows = [...list].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
      const open = this.expanded.has(cwd);
      const head = tree.createDiv({ cls: 'bridge-tree-row bridge-tree-folder' });
      head.createSpan({ cls: 'bridge-tree-arrow', text: open ? '▾' : '▸' });
      const hasCurrent = rows.some((s) => s.sessionId === this.currentId);
      head.createSpan({ cls: 'bridge-tree-name', text: `${cwd}（${rows.length}）${hasCurrent ? ' · 当前' : ''}` });
      head.onClickEvent(() => {
        if (this.expanded.has(cwd)) this.expanded.delete(cwd);
        else this.expanded.add(cwd);
        this.render();
      });
      if (!open) continue;
      // 这个工作区下也可以直接新建（不用回面板点「新建会话」）。
      // 组里旧会话可能没有 workspaceId，所以把这一组的 cwd 也带上，
      // 让 createAndBind 去注册/查找这个 cwd 的工作区，而不是退回当前库。
      const wsId = rows.find((x) => x.workspaceId)?.workspaceId || null;
      // 别叫 cwd：外层 for 的分组键就叫 cwd，同名会把它遮住并触发 TDZ。
      const groupCwd = rows.find((x) => x.cwd)?.cwd || null;
      const addRow = tree.createDiv({ cls: 'bridge-tree-row bridge-tree-new' });
      addRow.style.paddingLeft = '20px';
      addRow.createSpan({ cls: 'bridge-tree-name', text: '＋ 在此工作区新建会话' });
      addRow.onClickEvent(() => {
        this.close();
        try { this.onNew({ workspaceId: wsId, cwd: groupCwd }); } catch { /* ignore */ }
      });
      for (const s of rows) {
        const active = s.sessionId === this.currentId;
        const row = tree.createDiv({
          cls: 'bridge-tree-row bridge-tree-file' + (active ? ' is-selected' : ''),
        });
        row.style.paddingLeft = '16px';
        // 和选择笔记一样用行内标记，当前会话加个圆点，不另起一行文字说明
        if (active) row.createSpan({ cls: 'bridge-tree-dot', text: '●' });
        row.createSpan({ cls: 'bridge-tree-name', text: sessionLabel(s) });
        row.onClickEvent(() => {
          this.close();
          try {
            this.onPick(s.sessionId);
          } catch {
            /* 回调异常不外抛 */
          }
        });
      }
    }
  }
}

module.exports = { BridgeChatView, VIEW_TYPE, NoteTreePickerModal, InjectionPanelModal, SessionTreeModal };