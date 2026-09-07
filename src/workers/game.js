/**
 * ============================================================================
 * Game Worker — WebSocket 会话管理 + Region 路由
 * ============================================================================
 *
 * 职责 (保持轻量! WS 建立后的所有收发都在 RegionDO 内):
 *   1. 身份验证: Authorization: Bearer <JWT> (可选; dev 阶段允许匿名)
 *   2. 解析玩家标识: 优先 JWT 内的 uuid/name, 其次查询参数 (dev 自报家门)
 *   3. Region 路由: region=x,z 查询参数 → idFromName → 透传升级请求
 *
 * 为什么验证放在 Game Worker 而不是 RegionDO:
 *   - JWT verify 需要 secret + crypto 计算, 在无状态 Worker 做可以缓存
 *     失败结果; DO 是有状态长驻的, 让它远离"大量失败请求"的攻击面
 *   - DO 内保持纯游戏逻辑, 安全边界前置 (纵深防御)
 *
 * TODO(Phase 2): 路由决策从 region 查询参数迁移到 WorldManagerDO
 *   (按玩家坐标解析应进入的 Region, 处理跨区迁移)
 * ============================================================================
 */

import { verifyJWT, getSecret } from '../auth/jwt-handler.js';
import { ERROR_CODES } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

/**
 * 处理 /ws/game 的 WebSocket 升级 (index.js 调用)
 * @returns {Promise<Response>} 101 透传响应, 或 401/400 错误
 */
export async function handleGameWebSocket(request, env) {
  const url = new URL(request.url);

  /* ---------- 1. 身份验证 ---------- */
  let identity = null;

  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const payload = await verifyJWT(authHeader.slice(7), getSecret(env));
    if (!payload) {
      return errorClose(ERROR_CODES.AUTH_INVALID_TOKEN, 'AccessToken 无效或已过期');
    }
    identity = { uuid: payload.uuid, name: payload.name };
  }

  // dev 兜底: 未带 Token 时允许查询参数自报身份 (Phase 1 验收标准需要;
  // TODO(Phase 2): 生产环境强制 JWT, 移除该分支)
  identity ??= {
    uuid: url.searchParams.get('uuid') ?? crypto.randomUUID(),
    name: url.searchParams.get('name') ?? 'Guest',
  };

  /* ---------- 2. Region 路由 ---------- */
  // TODO(Phase 2): 问 WorldManagerDO 要路由表 (玩家上次所在区域优先)
  const regionParam = url.searchParams.get('region') ?? '0,0';
  const [rx, rz] = regionParam.split(',').map((n) => {
    const v = parseInt(n, 10);
    return Number.isFinite(v) ? v : 0;
  });

  // 把身份写进 URL 传给 DO (DO 不再信任客户端的 uuid 参数, 覆写为已验证值)
  const target = new URL(request.url);
  target.pathname = '/connect';
  target.search = '';
  target.searchParams.set('uuid', identity.uuid);
  target.searchParams.set('name', identity.name);
  target.searchParams.set('region', `${rx},${rz}`);

  const regionId = env.REGION.idFromName(`region:${rx},${rz}`);
  const regionStub = env.REGION.get(regionId);

  logger.info('ws_route', { uuid: identity.uuid, name: identity.name, region: `${rx},${rz}` });

  // 透传升级请求: 101 响应原路返回; 此后 Gateway 不再参与这条连接
  const forwarded = new Request(target.toString(), request);
  return regionStub.fetch(forwarded);
}

/** 认证失败统一返回 401 (升级请求不能返回 JSON body, 客户端按状态码处理) */
function errorClose(code, message) {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
