/**
 * ============================================================================
 * WorldManagerDO — 世界协调者 (全局单例)
 * ============================================================================
 *
 * 定位:
 *   全服唯一实例 (通过 env.WORLD_MANAGER.idFromName("singleton") 获得),
 *   是"逻辑世界"的元数据中心, 本身不跑游戏逻辑、不碰 WebSocket。
 *
 * 职责规划 (按阶段逐步实现):
 *   [Phase 1] 存根: 仅返回状态信息, 验证 DO 绑定可用
 *   [Phase 2] 玩家路由: 记录 玩家UUID → 所在Region 的路由表,
 *             客户端连接 /ws/game 时由 Gateway 询查应进哪个 Region
 *   [Phase 2] 跨区域协调: 玩家跨 Region 移动时的会话迁移 (原版无此概念,
 *             原版一个World一个进程; 本项目世界被切成N个DO, 需要协调者)
 *   [Phase 3] 全服广播: 在线人数统计 / 聊天跨Region转发 / 维护模式开关
 *
 * 为什么需要单例协调者 (设计决策):
 *   RegionDO 之间互相不可见 (DO 实例间只能通过 fetch 通信)。任何
 *   "需要跨 Region 一致视图" 的事情 (路由表/在线列表/全服配置) 都必须
 *   收敛到一个单点 —— 这就是 WorldManagerDO。代价是它可能成为热点,
 *   所以原则是: 它只存"低频变化的元数据", 高频数据永远留在 RegionDO 内。
 *
 * 待改进 (TODO):
 *   - [ ] 路由表持久化到 DO Storage (当前为纯内存, 重启即失)
 *   - [ ] Phase 2: 提供 GET /route?uuid=xxx → { region: "x,z" }
 *   - [ ] 单例热点规避: 只读查询可走 KV 缓存副本 (TTL 5s)
 * ============================================================================
 */

export class WorldManagerDO {
  /** @param {DurableObjectState} state @param {Env} env */
  constructor(state, env) {
    this.state = state;
    this.env = env;

    /**
     * 玩家路由表 (内存态)
     * uuid → { region: "x,z", joinedAt, lastSeenAt }
     * TODO(Phase 2): 由 RegionDO 在玩家加入/离开时主动上报
     */
    this.playerRoutes = new Map();
  }

  /** 处理来自其他 Worker / DO 的内部请求 */
  async fetch(request) {
    const url = new URL(request.url);

    // ---- 状态查询 (调试用) ----
    if (url.pathname === '/status') {
      return Response.json({
        ok: true,
        role: 'WorldManagerDO',
        players: this.playerRoutes.size,
        routes: Object.fromEntries(this.playerRoutes),
        env: this.env.ENVIRONMENT ?? 'unknown',
      });
    }

    // ---- TODO(Phase 2): 玩家路由解析 ----
    // GET /route?uuid=xxx → 302 或 { region }
    // POST /register { uuid, region } → RegionDO 上报玩家进入
    // POST /unregister { uuid }       → RegionDO 上报玩家离开

    return Response.json(
      { ok: false, code: 'NOT_IMPLEMENTED', message: 'WorldManagerDO 存根: 仅支持 /status' },
      { status: 501 }
    );
  }
}
