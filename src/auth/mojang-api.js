/**
 * ============================================================================
 * Mojang 官方认证 API 客户端 — "online" 模式的验证后端
 * ============================================================================
 *
 * 原版 Yggdrasil 验证流程 (wiki.vg Authentication):
 *   1. 客户端启动时向 Mojang 登录, 拿到 accessToken
 *   2. 客户端连接服务器时, 双方协商 serverId (服务端随机串+公钥哈希)
 *   3. 客户端 POST sessionserver.mojang.com/session/minecraft/join
 *   4. 服务端 GET  sessionserver.mojang.com/session/minecraft/hasJoined
 *      ?username=NAME&serverId=SERVER_ID → 200+profile = 验证通过
 *
 * 本项目的适配 (与原版差异):
 *   客户端 Mod 无法拿到服务端公钥 (我们不是原版服务器), 因此简化:
 *   - 客户端把 accessToken 直接经握手/登录接口交给服务端
 *   - 服务端用 hasJoined?username=NAME&serverId=CLIENT_JOIN_SERVER_ID 验证
 *   TODO(Phase 3): 引入服务端随机 nonce 一次性防重放 (记录已用 nonce)
 * ============================================================================
 */

const SESSION_SERVER = 'https://sessionserver.mojang.com';

/** 请求超时 (ms) — 外部API不可达时快速失败, 别拖死 Auth Worker */
const TIMEOUT_MS = 8000;

/**
 * 验证正版玩家 (hasJoined)
 * @param {string} username 玩家名
 * @param {string} serverId 客户端 join 时使用的 serverId
 * @returns {Promise<{ok: boolean, profile?: {uuid: string, name: string}, reason?: string}>}
 */
export async function hasJoined(username, serverId) {
  try {
    const resp = await fetchWithTimeout(
      `${SESSION_SERVER}/session/minecraft/hasJoined?username=${encodeURIComponent(username)}&serverId=${encodeURIComponent(serverId)}`
    );

    // 注意: hasJoined 验证失败返回 204 No Content, 不是 4xx!
    if (resp.status === 204) {
      return { ok: false, reason: 'MOJANG_REJECT' };
    }
    if (!resp.ok) {
      return { ok: false, reason: `MOJANG_HTTP_${resp.status}` };
    }

    const profile = await resp.json();
    return {
      ok: true,
      profile: {
        uuid: normalizeUuid(profile.id), // Mojang 返回无横杠 → 标准化
        name: profile.name,
      },
    };
  } catch (err) {
    return { ok: false, reason: 'MOJANG_UNREACHABLE' };
  }
}

/**
 * 查询玩家档案 (含纹理, 可要求签名纹理)
 * @param {string} uuid 无横杠或标准格式
 * @param {boolean} signed 是否要求签名 (yggdrasil 公钥签名, 验证皮肤真伪)
 */
export async function fetchProfile(uuid, signed = false) {
  const id = normalizeUuid(uuid);
  const url = `${SESSION_SERVER}/session/minecraft/profile/${id}${signed ? '?unsigned=false' : ''}`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) return null;
  return await resp.json(); // { id, name, properties: [{name:"textures", value: base64}] }
}

/**
 * 从 profile 的 textures property 中提取皮肤 URL 与模型
 * (cfmc.md: Base64 解码 JSON → textures.SKIN.url / metadata.model)
 * @returns {{skinUrl: string|null, capeUrl: string|null, model: 'slim'|'wide'}}
 */
export function decodeTextures(profile) {
  const result = { skinUrl: null, capeUrl: null, model: 'wide' };
  try {
    const texProp = profile?.properties?.find((p) => p.name === 'textures');
    if (!texProp) return result;

    const decoded = JSON.parse(atob(texProp.value));
    if (decoded.textures?.SKIN) {
      result.skinUrl = decoded.textures.SKIN.url;
      result.model = decoded.textures.SKIN.metadata?.model === 'slim' ? 'slim' : 'wide';
    }
    if (decoded.textures?.CAPE) {
      result.capeUrl = decoded.textures.CAPE.url;
    }
  } catch { /* 纹理解析失败不影响登录, 保持默认 */ }
  return result;
}

/** 无横杠 → 带横杠标准 UUID 格式 */
export function normalizeUuid(uuid) {
  const raw = uuid.replace(/-/g, '').toLowerCase();
  if (raw.length !== 32) throw new Error(`非法 UUID: ${uuid}`);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

/** 带 timeouts 的 fetch (AbortController; Workers 支持) */
async function fetchWithTimeout(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
