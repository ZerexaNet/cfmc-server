/**
 * ============================================================================
 * API Worker — RESTful API (Phase 3): Web 管理面板的数据源
 * ============================================================================
 *
 * 端点总览 (均带 CORS, 面板可独立部署在 Pages):
 *   公开 (只读统计):
 *     GET /api/stats                     总览: 在线/区域/运行时长/指标
 *     GET /api/online                    在线玩家列表 (含所在区域)
 *     GET /api/chat/history?n=50         最近聊天 (审计)
 *   管理 (需 X-Admin-Token, 值 = Secret ADMIN_TOKEN):
 *     GET    /api/admin/overview         + 各区域 /status 聚合
 *     POST   /api/admin/broadcast        { message } → WM 扇出全服
 *     POST   /api/admin/kick             { uuid, reason }
 *     POST   /api/admin/ban              { name, reason }
 *     DELETE /api/admin/ban              { name } → 解封
 *     GET    /api/admin/bans             封禁列表
 *     POST   /api/admin/maintenance      { enabled } → 维护开关
 *
 * 鉴权设计: 面板是无状态静态页, Token 由使用者输入、localStorage 保存,
 * 每个管理请求带 X-Admin-Token 头; Worker 用 timing-safe 比较防时序侧信道。
 */

import { logger } from '../utils/logger.js';

/** 汇总 helper: 拿 WM 单例 stub */
function wmStub(env) {
  return env.WORLD_MANAGER.get(env.WORLD_MANAGER.idFromName('singleton'));
}

/** timing-safe 字符串比较 (长度不同直接 false) */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 处理 /api/* (index.js 调用)
 * @returns {Promise<Response>}
 */
export async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname; // /api/...
  const adminToken = env.ADMIN_TOKEN ?? '';

  try {
    /* ---------- 公开只读端点 ---------- */
    if (path === '/api/stats' && request.method === 'GET') {
      const res = await wmStub(env).fetch('https://wm/stats');
      return Response.json(await res.json());
    }
    if (path === '/api/online' && request.method === 'GET') {
      const res = await wmStub(env).fetch('https://wm/online');
      return Response.json(await res.json());
    }
    if (path === '/api/chat/history' && request.method === 'GET') {
      const chat = env.CHAT.get(env.CHAT.idFromName('singleton'));
      const res = await chat.fetch(`https://chat/history?n=${encodeURIComponent(url.searchParams.get('n') ?? '50')}`);
      return Response.json(await res.json());
    }

    /* ---------- 管理端点: 鉴权闸门 ---------- */
    if (path.startsWith('/api/admin/')) {
      if (!adminToken) {
        return Response.json(
          { ok: false, code: 'ADMIN_TOKEN_MISSING', message: '服务端未配置 ADMIN_TOKEN Secret, 管理接口不可用' },
          { status: 501 }
        );
      }
      const provided = request.headers.get('X-Admin-Token') ?? '';
      if (!safeEqual(provided, adminToken)) {
        logger.warn('admin_auth_fail', { path, ip: request.headers.get('cf-connecting-ip') });
        return Response.json({ ok: false, code: 'FORBIDDEN', message: '管理员令牌无效' }, { status: 403 });
      }

      const body = request.method === 'POST' || request.method === 'DELETE'
        ? await request.json().catch(() => ({}))
        : {};

      switch (`${request.method} ${path}`) {
        case 'GET /api/admin/overview': {
          // 聚合所有活跃区域的 /status (玩家所在区域即"活跃区域")
          const statsRes = await wmStub(env).fetch('https://wm/online');
          const { online = [] } = await statsRes.json();
          const regionKeys = [...new Set(online.map((o) => o.region).filter(Boolean))];
          const regions = await Promise.all(
            regionKeys.map(async (key) => {
              try {
                const stub = env.REGION.get(env.REGION.idFromName(`region:${key}`));
                const r = await stub.fetch('https://do/status');
                return { region: key, ...(await r.json()) };
              } catch {
                return { region: key, ok: false };
              }
            })
          );
          return Response.json({ ok: true, online: online.length, regions });
        }
        case 'POST /api/admin/broadcast': {
          if (!body.message) return Response.json({ ok: false, message: 'message 必填' }, { status: 400 });
          const res = await wmStub(env).fetch('https://wm/broadcast', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: String(body.message).slice(0, 256) }),
          });
          return Response.json(await res.json());
        }
        case 'POST /api/admin/kick': {
          if (!body.uuid) return Response.json({ ok: false, message: 'uuid 必填' }, { status: 400 });
          // 找到玩家所在区域 → RegionDO /kick
          const res = await wmStub(env).fetch(`https://wm/route?uuid=${encodeURIComponent(body.uuid)}`);
          const { region } = await res.json();
          if (!region) return Response.json({ ok: false, message: '玩家不在线' }, { status: 404 });
          const stub = env.REGION.get(env.REGION.idFromName(`region:${region}`));
          const kr = await stub.fetch('https://do/kick', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: body.uuid, reason: body.reason ?? '管理员操作' }),
          });
          return Response.json(await kr.json());
        }
        case 'POST /api/admin/ban': {
          if (!body.name) return Response.json({ ok: false, message: 'name 必填' }, { status: 400 });
          const res = await wmStub(env).fetch('https://wm/ban', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: body.name, uuid: body.uuid, reason: body.reason ?? '', by: 'panel' }),
          });
          return Response.json(await res.json());
        }
        case 'DELETE /api/admin/ban': {
          const res = await wmStub(env).fetch('https://wm/unban', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: body.name }),
          });
          return Response.json(await res.json());
        }
        case 'GET /api/admin/bans': {
          const res = await wmStub(env).fetch('https://wm/bans');
          return Response.json(await res.json());
        }
        case 'POST /api/admin/maintenance': {
          const res = await wmStub(env).fetch('https://wm/maintenance', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!body.enabled }),
          });
          return Response.json(await res.json());
        }
        default:
          return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
      }
    }

    return Response.json({ ok: false, code: 'NOT_FOUND', message: '未知 API 端点' }, { status: 404 });
  } catch (err) {
    logger.error('api_error', { path, error: err.message });
    return Response.json({ ok: false, code: 'INTERNAL_ERROR', message: err.message }, { status: 500 });
  }
}
