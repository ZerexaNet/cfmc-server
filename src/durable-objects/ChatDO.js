/**
 * ============================================================================
 * ChatDO — 聊天服务 (可选独立 DO)
 * ============================================================================
 *
 * 为什么聊天独立成一个 DO (设计决策):
 *   1. 聊天是"全服"语义, 而聊天是 RegionDO 是"区域"语义;
 *      若塞进 RegionDO, 跨区域聊天要走 WorldManagerDO 中转, 链路变长
 *   2. 聊天量与游戏 Tick 无关, 独立后聊天洪峰不会挤占 Tick 的 CPU 预算
 *      (cfmc.md: 单次 tick CPU < 40ms 是硬约束)
 *   3. Phase 4 计划的 Discord 桥接可以直连 ChatDO, 不用碰游戏引擎
 *
 * 当前状态: 骨架存根 —— 简单文本广播 (JSON over WebSocket),
 *           已可支撑 Phase 1 验收标准 "2人能同时在线互聊"。
 *
 * 待改进 (TODO):
 *   - [ ] Phase 1 验收: Mod 侧按 P 键连接后即可用此 DO 互聊
 *   - [ ] Phase 3: 消息频道 (全局/区域/私聊) + 敏感词过滤 + 速率限制
 *   - [ ] Phase 3: 聊天历史持久化 (D1, 滚动保留 N 条)
 *   - [ ] 协议升级: 改用 ChatMessagePacket (0x09/0x17) 二进制帧
 * ============================================================================
 */

export class ChatDO {
  /** @param {DurableObjectState} state @param {Env} env */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ---- 聊天 WebSocket 升级 (客户端 Mod 直连 /ws/chat → Gateway 转发至此) ----
    if (url.pathname === '/connect' && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Hibernation 模式: 空闲休眠零费用, 与 RegionDO 同策略
      this.state.acceptWebSocket(server, [url.searchParams.get('uuid') ?? 'anon']);
      server.send(JSON.stringify({ type: 'chatWelcome', online: this.state.getWebSockets().size }));

      return new Response(null, { status: 101, webSocket: client });
    }

    // ---- 状态查询 ----
    if (url.pathname === '/status') {
      return Response.json({ ok: true, role: 'ChatDO', online: this.state.getWebSockets().size });
    }

    // ---- 服务端其他组件投递消息 (如 RegionDO 转发游戏内事件) ----
    if (url.pathname === '/publish' && request.method === 'POST') {
      const body = await request.text();
      this.#broadcast(body);
      return Response.json({ ok: true, delivered: this.state.getWebSockets().size });
    }

    return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
  }

  /** 收到玩家聊天 → 广播 */
  webSocketMessage(ws, message) {
    // TODO(Phase 3): 速率限制 (每玩家每秒≤5条) + 敏感词过滤
    try {
      const data = JSON.parse(message);
      if (data.type !== 'chat') return; // 只认聊天文本帧
      const payload = JSON.stringify({
        type: 'chat',
        from: data.name ?? this.#uuidOf(ws),
        msg: String(data.msg ?? '').slice(0, 256), // 长度硬截断, 防超大包
        at: Date.now(),
      });
      this.#broadcast(payload);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'expected {type:"chat",msg:"..."} JSON' }));
    }
  }

  webSocketClose(ws) {
    // Hibernation 模式下断开的连接会被平台自动清理, 无需手工删除
  }

  #broadcast(text) {
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(text);
      } catch { /* ignore */ }
    }
  }

  #uuidOf(ws) {
    try {
      return ws.getTag?.(0) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
