/**
 * ============================================================================
 * claims.js — 土地保护 (Phase 4)
 * ============================================================================
 * 纯逻辑模块。数据源: WORLD 库 chunk_claims 表 (见 migrations/002),
 * RegionDO 启动/玩家进入时懒加载到内存 Map, 变更走回调写 D1。
 *
 * 规则:
 *   - 认领上限 (默认 16 块/人)
 *   - 已认领区块: 仅所有者与 moderator+ 可修改方块
 *   - admin 永久豁免; moderator 依赖 world.claim.bypass 权限
 */

export const CLAIMS_LIMIT = 16;

/** 内存快照: "cx,cz" → { ownerUuid, claimedAt } */
export class ClaimRegistry {
  constructor(entries = []) {
    this.map = new Map(entries);
  }

  static key(cx, cz) {
    return `${cx},${cz}`;
  }

  get(cx, cz) {
    return this.map.get(ClaimRegistry.key(cx, cz));
  }

  countOf(uuid) {
    let n = 0;
    for (const c of this.map.values()) if (c.ownerUuid === uuid) n++;
    return n;
  }

  claimsOf(uuid) {
    return [...this.map.entries()]
      .filter(([, c]) => c.ownerUuid === uuid)
      .map(([k]) => k);
  }

  /** 认领; 返回 {ok, reason?} */
  claim(cx, cz, uuid, limit = CLAIMS_LIMIT) {
    const k = ClaimRegistry.key(cx, cz);
    if (this.map.has(k)) return { ok: false, reason: '区块已被认领' };
    if (this.countOf(uuid) >= limit) return { ok: false, reason: `达到认领上限 ${limit}` };
    this.map.set(k, { ownerUuid: uuid, claimedAt: Date.now() });
    return { ok: true };
  }

  unclaim(cx, cz, uuid, isMod) {
    const k = ClaimRegistry.key(cx, cz);
    const c = this.map.get(k);
    if (!c) return { ok: false, reason: '该区块未被认领' };
    if (c.ownerUuid !== uuid && !isMod) return { ok: false, reason: '只能放弃自己的认领' };
    this.map.delete(k);
    return { ok: true };
  }

  /**
   * 方块修改检查
   * @param {string} actorUuid @param {{role?:string, extraPerms?:string[]}} actorSession
   */
  canModify(cx, cz, actorUuid, actorSession) {
    const c = this.get(cx, cz);
    if (!c) return { allowed: true };
    if (c.ownerUuid === actorUuid) return { allowed: true };
    if (actorSession?.role === 'admin') return { allowed: true };
    if (actorSession?.extraPerms?.includes('world.claim.bypass') || actorSession?.role === 'moderator') {
      return { allowed: true };
    }
    return { allowed: false, reason: `该区块由 ${c.ownerUuid.slice(0, 8)}… 认领保护` };
  }
}
