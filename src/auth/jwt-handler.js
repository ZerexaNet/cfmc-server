/**
 * ============================================================================
 * JWT 签发/验证 — HS256, 基于 Web Crypto (Workers 原生支持)
 * ============================================================================
 *
 * 设计决策:
 *   - AccessToken: JWT (HS256), 15 分钟过期 — 无状态校验, Gateway/RegionDO
 *     本地 verify 即可, 不查库 (每次WS握手都验证, 查库会烧 D1 配额)
 *   - RefreshToken: 不透明随机串 (前缀 + UUIDv4), 存 KV (7 天), 可吊销
 *     → 双 Token 结构, 与 OAuth2 惯例一致
 *   - 密钥来源: env.AUTH_JWT_SECRET (wrangler secret put AUTH_JWT_SECRET,
 *     一键部署时由向导提示输入, 模板见 .dev.vars.example)
 *     ⚠️ 未配置时回退到 KV 自动生成的随机密钥 (每部署唯一, 重启不失效);
 *        KV 不可用时才退到 dev 密钥 —— 仅限本地开发, 生产必须显式配置!
 *
 * 与原版 Minecraft 认证的差异:
 *   原版是"一次性会话验证" (session join → hasJoined); 我们在这之上
 *   叠加了可持续的 JWT 会话层, 服务于 WS 重连与 REST API 鉴权。
 * ============================================================================
 */

/** Base64URL 编码 (JWT 标准字母表: -_ 替代 +/, 无填充) */
function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64URL 解码 */
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const DEV_FALLBACK_SECRET = 'cfmc-dev-insecure-secret-change-me';

/**
 * 从环境取签名密钥 (async: 允许 KV 兑底路径)
 *
 * 为什么不直接用固定 dev 密钥: 固定串是公开已知的 —— 忘配 Secret 的部署
 * 等于"任何人可伪造任意玩家会话"。改为首次缺失时生成 64hex 随机值并
 * 持久化到 KV (key: jwt_secret_auto), 既保证每个部署唯一, 又保证重启/
 * 冷启动后签名密钥稳定 (已签发的 Token 不会批量失效)。
 * 显式配置 Secret 后优先级更高, KV 值自然废弃。
 */
export async function getSecret(env) {
  const s = env?.AUTH_JWT_SECRET;
  if (s) return s;

  try {
    if (env?.CACHE) {
      let key = await env.CACHE.get('jwt_secret_auto');
      if (!key) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        key = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
        await env.CACHE.put('jwt_secret_auto', key);
      }
      console.warn(JSON.stringify({
        level: 'warn',
        msg: 'AUTH_JWT_SECRET 未配置, 使用 KV 自动生成密钥 (每次部署唯一; 生产请 wrangler secret put AUTH_JWT_SECRET)',
      }));
      return key;
    }
  } catch { /* KV 故障则继续走 dev 密钥 */ }

  console.warn(JSON.stringify({ level: 'warn', msg: 'AUTH_JWT_SECRET 未配置且 KV 不可用, 使用不安全 dev 密钥 (严禁生产!)' }));
  return DEV_FALLBACK_SECRET;
}

/** 派生 HMAC 密钥 (Workers 每请求环境隔离, Key 无法跨请求缓存; 短Token下开销可忽略) */
async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * 签发 JWT
 * @param {object} payload 必含 { uuid, name, mode }; 会自动补 iat/exp
 * @param {string} secret
 * @param {number} ttlSeconds 有效期 (默认 900 = 15 分钟)
 * @returns {Promise<string>} token
 */
export async function signJWT(payload, secret, ttlSeconds = 900) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };

  const signingInput =
    b64urlEncode(new TextEncoder().encode(JSON.stringify(header))) +
    '.' +
    b64urlEncode(new TextEncoder().encode(JSON.stringify(body)));

  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return signingInput + '.' + b64urlEncode(new Uint8Array(sig));
}

/**
 * 验证 JWT
 * @returns {Promise<object|null>} 合法返回 payload; 非法/过期返回 null
 *   (调用方只判 null, 不抛异常 — 认证失败是正常业务路径而非错误)
 */
export async function verifyJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const key = await importKey(secret);
    const sigOk = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1])
    );
    if (!sigOk) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (typeof payload.exp !== 'number' || Math.floor(Date.now() / 1000) >= payload.exp) {
      return null; // 已过期
    }
    return payload;
  } catch {
    return null;
  }
}

/** 生成不透明 RefreshToken (KV 存储 key: "rt:" + token) */
export function generateRefreshToken() {
  return 'rt_' + crypto.randomUUID().replace(/-/g, '');
}

/** RefreshToken 在 KV 中的 TTL (秒): 7 天 */
export const REFRESH_TTL_SECONDS = 7 * 24 * 3600;
