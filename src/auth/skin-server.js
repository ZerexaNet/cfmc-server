/**
 * ============================================================================
 * 皮肤站 (Yggdrasil 兼容) 客户端 — "skin_server" 模式的验证后端
 * ============================================================================
 *
 * 支持的皮肤站: ely.by / littleskin.cn / 自建 (URL 可配置, cfmc.md 要求 #5)
 *
 * 必须实现的皮肤站端点 (见 cfmc.md Yggdrasil 兼容性一节):
 *   POST {base}/api/authserver/authenticate   账密登录 → accessToken + profile
 *   POST {base}/api/authserver/refresh        刷新 accessToken
 *   POST {base}/api/authserver/validate       校验 accessToken
 *   POST {base}/api/authserver/invalidate     吊销 accessToken
 *   GET  {base}/api/sessionserver/session/minecraft/profile/{uuid}?unsigned=false
 *
 * 响应契约 (与 Mojang 一致):
 *   { accessToken, clientToken, selectedProfile: { id, name } }
 *   皮肤: properties[].name=="textures", value=Base64(JSON) → SKIN.url
 * ============================================================================
 */

import { decodeTextures, normalizeUuid } from './mojang-api.js';

const TIMEOUT_MS = 8000;

export class SkinServerClient {
  /**
   * @param {string} baseUrl 皮肤站根地址 (如 https://littleskin.cn)
   * @param {string} [clientToken] 客户端标识; 不传则随机 (每次登录独立会话)
   */
  constructor(baseUrl, clientToken = crypto.randomUUID()) {
    this.baseUrl = baseUrl.replace(/\/+$/, ''); // 去尾斜杠
    this.clientToken = clientToken;
  }

  /**
   * 账密认证
   * @param {string} username 皮肤站用户名/邮箱 (注意: 不是游戏内名!)
   * @param {string} password
   * @param {string} [agentName] 一般固定 "Minecraft"
   * @returns {Promise<{ok:boolean, reason?:string, profile?:{uuid,name}, accessToken?:string, skin?:object}>}
   */
  async authenticate(username, password, agentName = 'Minecraft') {
    try {
      const resp = await fetch(`${this.baseUrl}/api/authserver/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: { name: agentName, version: 1 },
          username,
          password,
          clientToken: this.clientToken,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (resp.status === 400) return { ok: false, reason: 'SKIN_BAD_REQUEST' };
      if (resp.status === 403) return { ok: false, reason: 'SKIN_INVALID_CREDENTIALS' }; // 账号或密码错误
      if (!resp.ok) return { ok: false, reason: `SKIN_HTTP_${resp.status}` };

      const data = await resp.json();
      const profile = data.selectedProfile; // 多角色皮肤站可能无 selectedProfile
      if (!profile) return { ok: false, reason: 'SKIN_NO_PROFILE' };

      return {
        ok: true,
        accessToken: data.accessToken,
        profile: { uuid: normalizeUuid(profile.id), name: profile.name },
      };
    } catch {
      return { ok: false, reason: 'SKIN_UNREACHABLE' };
    }
  }

  /**
   * 查询档案并解析皮肤 (签名纹理)
   * @returns {Promise<{uuid, name, skinUrl, capeUrl, model}|null>}
   */
  async fetchProfileWithSkin(uuid) {
    try {
      const resp = await fetch(
        `${this.baseUrl}/api/sessionserver/session/minecraft/profile/${uuid.replace(/-/g, '')}?unsigned=false`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) }
      );
      if (!resp.ok) return null;
      const profile = await resp.json();
      const skin = decodeTextures(profile);
      return { uuid: normalizeUuid(profile.id), name: profile.name, ...skin };
    } catch {
      return null;
    }
  }

  /** 校验 accessToken 是否仍有效 */
  async validate(accessToken) {
    try {
      const resp = await fetch(`${this.baseUrl}/api/authserver/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, clientToken: this.clientToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return resp.status === 204; // yggdrasil 约定: 有效=204
    } catch {
      return false;
    }
  }
}
