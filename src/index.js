/**
 * ============================================================================
 * CFMC-Edge — Gateway Worker 入口
 * ============================================================================
 *
 * 职责 (Phase 1 骨架):
 *   1. TLS 终止后的第一入口: 所有请求先进这里
 *   2. 基础路由分发: 静态信息 / 健康检查 / 认证 / REST API / WebSocket
 *   3. 全局中间件挂载点 (CORS / Logger / RateLimiter, 见 workers/gateway.js)
 *   4. 导出 Durable Object 类 (Workers 平台要求 DO 类必须从入口模块导出)
 *
 * 与原版 Minecraft 服务器的差异:
 *   - 原版: 单进程 MainThread 接收所有 TCP 连接 (Netty), 一个 World 一个 Tick 循环
 *   - 本项目: 无状态 Worker 只做"路由器", 有状态的游戏逻辑全部下沉到
 *     Durable Object (RegionDO = 区域游戏引擎), 每个 Region 独立 Tick
 *
 * 性能考量:
 *   - 入口 Worker 保持零状态、零磁盘访问, P99 处理耗时 < 5ms
 *   - WebSocket 升级请求直接透传给 DO (fetch 转发), Worker 不缓存任何包数据,
 *     避免大包 (ChunkData 可达数百KB) 在 Worker 中产生多余拷贝
 *
 * 待改进 (TODO):
 *   - [ ] Phase 2: 按玩家坐标哈希路由到对应 Region (WorldManagerDO 提供路由表)
 *   - [ ] Phase 3: 接入 Cloudflare WAF Rate Limiting Binding 替代内存限流器
 * ============================================================================
 */

import {
  jsonResponse,
  errorResponse,
  handleOptions,
  withCors,
  RateLimiter,
  logRequest,
} from './workers/gateway.js';
import { handleAuthRequest } from './workers/auth.js';
import { handleGameWebSocket } from './workers/game.js';
import { PROTOCOL_VERSION } from './protocol/packet-definitions.js';

/** DO 类导出 —— 必须在入口模块, 否则 wrangler deploy 校验失败 */
export { WorldManagerDO } from './durable-objects/WorldManagerDO.js';
export { RegionDO } from './durable-objects/RegionDO.js';
export { ChatDO } from './durable-objects/ChatDO.js';

/** 内存限流器 (per-isolate; 生产环境应换成 WAF 规则或 DO 计数器, 见 gateway.js 注释) */
const limiter = new RateLimiter({
  windowMs: 60_000,
  maxRequests: 120, // 每IP每分钟120次: 对登录/REST足够, 不影响WS长连接
});

export default {
  /**
   * 主入口 —— 所有 HTTP/WS 请求
   * @param {Request} request
   * @param {Env} env 绑定 (WORLD_MANAGER/REGION/CHAT/USERS_DB/WORLD_DB/CACHE/BACKUPS...)
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const url = new URL(request.url);

    try {
      // ---------- 0. CORS 预检 (Web 管理面板 Phase 3 会跨域访问) ----------
      if (request.method === 'OPTIONS') {
        return handleOptions(request);
      }

      // ---------- 1. 限流 (仅对非 WebSocket 升级请求生效) ----------
      const isWsUpgrade = request.headers.get('Upgrade') === 'websocket';
      if (!isWsUpgrade) {
        const limited = limiter.check(request);
        if (limited) {
          return withCors(
            errorResponse('RATE_LIMITED', '请求过于频繁, 请稍后再试', 429),
            request
          );
        }
      }

      // ---------- 2. 路由分发 ----------
      const response = await route(request, env, url, ctx);

      // ---------- 3. 统一日志 + CORS 包裹 ----------
      logRequest(request, response, startTime);
      return withCors(response, request);
    } catch (err) {
      // 全局兜底: 任何未捕获异常都不能泄漏堆栈给客户端
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'unhandled_exception',
          path: url.pathname,
          error: err.message,
          stack: err.stack,
        })
      );
      return withCors(
        errorResponse('INTERNAL_ERROR', '服务器内部错误', 500),
        request
      );
    }
  },
};

/**
 * 路由表
 * ----------------------------------------------------------------
 * GET  /            服务信息 (协议版本/能力集, 供客户端 Mod 发现服务)
 * GET  /health      健康检查 (负载均衡/监控探针)
 * GET  /ws/game     WebSocket 升级 → 验证身份 → 转发给 RegionDO (game.js)
 * ANY  /auth/*      认证服务: 登录/刷新/校验/吊销/皮肤 (auth.js)
 * ANY  /api/*       RESTful API (TODO Phase 3)
 */
async function route(request, env, url, ctx) {
  const { pathname } = url;

  // ===== 服务信息 =====
  if (pathname === '/' && request.method === 'GET') {
    return jsonResponse({
      name: 'CFMC-Edge',
      description: 'Serverless Minecraft server on Cloudflare Edge',
      protocolVersion: PROTOCOL_VERSION,
      phase: '2-core', // 当前开发阶段标识, 客户端可据此判断服务端能力
      capabilities: {
        websocket: true,
        chat: true,
        world: true,   // RegionDO v0.1: 超平坦世界 + 方块读写
        auth: true,    // Auth Worker: 四种认证模式
      },
      endpoints: ['/health', '/ws/game', '/auth/*', '/api/* (todo)'],
    });
  }

  // ===== 健康检查 =====
  if (pathname === '/health') {
    return jsonResponse({
      status: 'ok',
      colo: request.cf?.colo ?? 'unknown', // 命中的边缘数据中心
      region: request.cf?.country ?? '??',
      timestamp: Date.now(),
    });
  }

  // ===== WebSocket 游戏入口 (game.js: 身份验证 + Region 路由) =====
  if (pathname === '/ws/game' && request.headers.get('Upgrade') === 'websocket') {
    return handleGameWebSocket(request, env);
  }

  // ===== 认证服务 (auth.js: 四种模式, 子提示词 2) =====
  if (pathname.startsWith('/auth/')) {
    return handleAuthRequest(request, env, url);
  }

  // ===== RESTful API (Phase 3) =====
  if (pathname.startsWith('/api/')) {
    // TODO(Phase 3): 在线人数/服务器统计/Web管理面板数据源
    return errorResponse('NOT_IMPLEMENTED', 'API Worker 将在 Phase 3 实现', 501);
  }

  // ===== 404 兜底 =====
  return errorResponse('NOT_FOUND', `未知路径: ${pathname}`, 404);
}
