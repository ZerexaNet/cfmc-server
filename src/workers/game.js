/**
 * ============================================================================
 * Game Worker — WebSocket 会话管理 + Region 路由 v1.0 (Phase 2/3)
 * ============================================================================
 *
 * 职责 (保持轻量! WS 建立后的所有收发都在 RegionDO 内):
 *   1. 身份验证: Authorization: Bearer <JWT> (生产强制; dev 允许参数自报)
 *   2. [P3] 封禁拦截: WorldManagerDO /banned 缓存查询 → 403 BANNED
 *   3. [P3] 维护模式: 拒绝非管理员新连接 → 503 MAINTENANCE
 *   4. [P2] Region 路由: 显式参数 > WorldManagerDO 上次区域 > (0,0)
 *   5. [P4] 多维度: dim 参数 (overworld/nether/end) 拼进 DO 实例名
 *
 * 为什么验证放在 Game Worker 而不是 RegionDO:
 *   - JWT verify 需要 secret + crypto 计算, 无状态 Worker 可缓存失败结果;
 *   - DO 有状态长驻, 让它远离"大量失败请求"的攻击面 (纵深防御)
 */

import { verifyJWT, getSecret } from '../auth/jwt-handler.js';
import { ERROR_CODES } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

/** 维度注册 (与 utils/constants.DIMENSIONS 一致; 用于实例名合法性校验) */
const DIMS = new Set(['overworld', 'nether', 'end']);

/**
 * 处理 /ws/game 的 WebSocket 升级 (index.js 调用)
 * @returns {Promise<Response>} 101 透传响应, 或 401/403/503 错误
 */
export async function handleGameWebSocket(request, env) {
  const url = new URL(request.url);

  /* ---------- 1. 身份验证 ---------- */
  let identity = null;
  let isAdmin = false;

  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const payload = await verifyJWT(authHeader.slice(7), getSecret(env));
    if (!payload) {
      return errorClose(ERROR_CODES.AUTH_INVALID_TOKEN, 'AccessToken 无效或已过期');
    }
    identity = { uuid: payload.uuid, name: payload.name };
    isAdmin = payload.role === 'admin'; // Auth Worker 登录时写入 JWT
  }

  // dev 兜底: 未带 Token 时允许查询参数自报身份 (本地联调; production 强制 JWT)
  if (!identity) {
    if (env.ENVIRONMENT === 'production') {
      return errorClose(ERROR_CODES.AUTH_REQUIRED, '生产环境必须携带 AccessToken');
    }
    identity = {
      uuid: url.searchParams.get('uuid') ?? crypto.randomUUID(),
      name: url.searchParams.get('name') ?? 'Guest',
    };
  }

  const wm = env.WORLD_MANAGER.get(env.WORLD_MANAGER.idFromName('singleton'));

  /* ---------- 2. 封禁拦截 (P3) ---------- */
  const banRes = await wm.fetch(`https://wm/banned?uuid=${encodeURIComponent(identity.uuid)}&name=${encodeURIComponent(identity.name)}`);
  if (banRes.ok) {
    const { banned } = await banRes.json();
    if (banned && !isAdmin) {
      return errorClose(ERROR_CODES.BANNED, '该账号已被封禁, 如有疑问联系管理员');
    }
  }

  /* ---------- 3. 维护模式 (P3) ---------- */
  const maintRes = await wm.fetch('https://wm/maintenance');
  if (maintRes.ok) {
    const { maintenance } = await maintRes.json();
    if (maintenance && !isAdmin) {
      return errorClose(ERROR_CODES.MAINTENANCE, '服务器维护中, 稍后再来');
    }
  }

  /* ---------- 4. Region 路由 (P2): 显式参数 > 上次区域 > 原点 ---------- */
  const dim = DIMS.has(url.searchParams.get('dim') ?? '') ? url.searchParams.get('dim') : 'overworld';
  let regionKey = null;

  const regionParam = url.searchParams.get('region');
  if (regionParam && /^-?\d+,-?\d+$/.test(regionParam)) {
    regionKey = regionParam; // 客户端显式指定 (跨区传送场景)
  } else {
    // P2: 问 WorldManagerDO 要上次区域 (断线重连恢复的关键)
    const routeRes = await wm.fetch(`https://wm/route?uuid=${encodeURIComponent(identity.uuid)}`);
    if (routeRes.ok) {
      const { region: last } = await routeRes.json();
      if (last && /^-?\d+,-?\d+$/.test(String(last))) regionKey = String(last);
    }
  }
  regionKey ??= '0,0';

  /* ---------- 5. 透传升级 ---------- */
  const target = new URL(request.url);
  target.pathname = '/connect';
  target.search = '';
  target.searchParams.set('uuid', identity.uuid);
  target.searchParams.set('name', identity.name);
  target.searchParams.set('region', regionKey);
  target.searchParams.set('dim', dim);
  target.searchParams.set('admin', isAdmin ? '1' : '0');

  const regionId = env.REGION.idFromName(`region:${dim === 'overworld' ? '' : dim + ':'}${regionKey}`);
  const regionStub = env.REGION.get(regionId);

  logger.info('ws_route', { uuid: identity.uuid, name: identity.name, region: regionKey, dim, admin: isAdmin });

  const forwarded = new Request(target.toString(), request);
  return regionStub.fetch(forwarded);
}

/** 认证/拦截失败统一错误响应 (升级请求不能带 JSON body 语义, 客户端按状态码处理) */
function errorClose(code, message) {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status: code === ERROR_CODES.BANNED ? 403 : code === ERROR_CODES.MAINTENANCE ? 503 : 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
