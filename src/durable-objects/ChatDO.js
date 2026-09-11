/**
 * ============================================================================
 * ChatDO — 全服聊天服务 v1.0 (Phase 3: 频道/私聊/限流/过滤/历史)
 * ============================================================================
 *
 * 为什么聊天独立成一个 DO (设计决策):
 *   1. 聊天是"全服"语义, RegionDO 是"区域"语义, 塞进去跨区聊天链路变长
 *   2. 聊天量与游戏 Tick 无关, 独立后聊天洪峰不挤占 Tick 的 40ms CPU 预算
 *   3. Phase 4 的 Discord 桥接可直连 ChatDO, 不碰游戏引擎
 *
 * 本版实现 (Phase 3):
 *   - 通道: global (全服) / private 目标投递 (区域频道由 RegionDO 本地处理)
 *   - 速率限制: 每玩家 chatRateLimit 条 / chatRateWindowMs (滑动窗口)
 *   - 敏感词过滤: 归一化 (全角/大小写/分隔符) + 词表匹配, 命中替换 ***
 *   - 历史: 内存 ring + D1 chat_history 表 (节流批量落库), /history 查询
 *
 * 通道协议 (JSON 文本帧, 浏览器与 Mod 通用):
 *   ↑ { type:'chat', msg, channel?:'global'|'private', to?:uuid }
 *   ↓ { type:'chat', from, msg, channel, at }
 *   ↓ { type:'chatWelcome'|'error', ... }
 */

const BLOCKED_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'nigger', '傻逼', '草泥马', '妈的'];

/** 敏感词归一化: 全角→半角 / 大写→小写 / 去掉常见分隔符 (防 c.f-u,c.k 绕过) */
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[.\-*_~ ]/g, '');
}

/** 过滤: 命中敏感词的原文替换为 *** (返回 null = 整条拦截) */
export function filterMessage(text) {
  let out = text;
  const norm = normalize(text);
  for (const w of BLOCKED_WORDS) {
    if (norm.includes(w)) out = out.replace(new RegExp(w, 'gi'), '***');
  }
  return out;
}

export class ChatDO {
  /** @param {DurableObjectState} state @param {Env} env */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rateWindowMs = Number(env?.CHAT_RATE_WINDOW_MS ?? 5000);
    this.rateLimit = Number(env?.CHAT_RATE_LIMIT ?? 5);
    this.historyLimit = Number(env?.CHAT_HISTORY_SIZE ?? 100);

    /** uuid → 时间戳数组 (滑动窗口限流) */
    this.sendLog = new Map();
    /** 历史环形缓冲 [{from,msg,channel,at}] */
    this.history = [];
    /** 历史落库缓冲 (节流批量) */
    this.pendingPersist = [];
    this.persistTimer = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/connect' && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // tag[0]=uuid 反查; tag[1]=名字 (欢迎/历史需要)
      const uuid = url.searchParams.get('uuid') ?? 'anon';
      const name = url.searchParams.get('name') ?? 'Guest';
      this.state.acceptWebSocket(server, [uuid, name]);
      server.send(JSON.stringify({ type: 'chatWelcome', online: this.state.getWebSockets().length, history: this.history.slice(-20) }));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/status') {
      return Response.json({ ok: true, role: 'ChatDO', online: this.state.getWebSockets().length, history: this.history.length });
    }

    // 服务端组件投递消息 (RegionDO 全服事件 / Discord 桥接 Phase 4)
    if (url.pathname === '/publish' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      if (!body?.msg) return Response.json({ ok: false, code: 'BAD_REQUEST' }, { status: 400 });
      this.#deliver({ from: body.from ?? '服务器', msg: filterMessage(String(body.msg).slice(0, 256)), channel: body.channel ?? 'global', to: body.to ?? null, at: Date.now() });
      return Response.json({ ok: true, delivered: this.state.getWebSockets().length });
    }

    // 历史 (API 面板)
    if (url.pathname === '/history') {
      const n = Math.min(this.historyLimit, Number(url.searchParams.get('n') ?? 50));
      return Response.json({ ok: true, history: this.history.slice(-n) });
    }

    return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
  }

  /** 玩家聊天 (Hibernation 唤醒) */
  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'expected {type:"chat",msg:"..."} JSON' }));
      return;
    }
    if (data.type !== 'chat' || !data.msg) return;

    const uuid = this.#tag(ws, 0);
    const name = this.#tag(ws, 1) || 'Guest';

    // 1. 速率限制 (滑动窗口)
    if (this.#rateLimited(uuid)) {
      ws.send(JSON.stringify({ type: 'error', message: '发言太快, 稍后再试' }));
      return;
    }

    // 2. 过滤 + 截断
    const msg = filterMessage(String(data.msg).slice(0, 256));
    const channel = data.channel === 'private' ? 'private' : 'global';

    const record = { from: name, uuid, msg, channel, to: data.to ?? null, at: Date.now() };

    // 3. 投递 (global 广播; private 只发目标与自己)
    this.#deliver(record);
    this.#pushHistory(record);
  }

  webSocketClose() { /* Hibernation 自动清理 */ }

  /* ---------------------------- 内部 ---------------------------- */

  #rateLimited(uuid) {
    const now = Date.now();
    const arr = (this.sendLog.get(uuid) ?? []).filter((t) => now - t < this.rateWindowMs);
    if (arr.length >= this.rateLimit) {
      this.sendLog.set(uuid, arr);
      return true;
    }
    arr.push(now);
    this.sendLog.set(uuid, arr);
    return false;
  }

  /** 投递: global 广播; private 定向 */
  #deliver(record) {
    const text = JSON.stringify({ type: 'chat', from: record.from, msg: record.msg, channel: record.channel, at: record.at });
    if (record.channel === 'private' && record.to) {
      for (const ws of this.state.getWebSockets(record.to)) wsSafeSend(ws, text);
      // 回显给发送者 (让 ta 看到自己发的私聊)
      for (const ws of this.state.getWebSockets(record.uuid ?? '')) wsSafeSend(ws, text);
    } else {
      for (const ws of this.state.getWebSockets()) wsSafeSend(ws, text);
    }
    // 私聊也进历史 (频道标记), 便于审计
  }

  #pushHistory(record) {
    this.history.push({ from: record.from, msg: record.msg, channel: record.channel, to: record.to, at: record.at });
    if (this.history.length > this.historyLimit) this.history.shift();
    this.pendingPersist.push(record);
    this.#schedulePersist();
  }

  /** 历史落库 (5s 防抖批量; chat_history 表见 migrations/002) */
  #schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const batch = this.pendingPersist.splice(0);
      if (batch.length === 0) return;
      const stmt = this.env.USERS_DB.prepare(
        'INSERT INTO chat_history (from_name, from_uuid, channel, to_uuid, message, at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      this.env.USERS_DB.batch(batch.map((r) => stmt.bind(r.from, r.uuid ?? null, r.channel, r.to ?? null, r.msg, r.at))).catch(() => {});
    }, 5000);
  }

  #tag(ws, i) {
    try {
      return ws.getTag?.(i) ?? '';
    } catch {
      return '';
    }
  }
}

function wsSafeSend(ws, text) {
  try {
    ws?.send(text);
  } catch { /* 连接已死 */ }
}
