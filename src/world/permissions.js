/**
 * ============================================================================
 * permissions.js — 权限系统 (Phase 3)
 * ============================================================================
 * 纯逻辑模块 (零平台依赖, 可单测)。
 *
 * 角色: player < moderator < admin
 *   player    — 默认; 聊天/移动/方块交互/基本命令
 *   moderator — + 踢人/越权保护/广播类命令
 *   admin(OP) — + 封禁/授权/经济发放/全服广播
 *
 * 存储约定: 角色存 users 库 player_data.role (TEXT, 缺省 'player',
 *           见 migrations/002); bans 表独立。RegionDO 内存缓存, 变更时写回 D1。
 */

export const ROLES = {
  PLAYER: 'player',
  MODERATOR: 'moderator',
  ADMIN: 'admin',
};

/** 角色继承链: 高角色自动拥有低角色全部权限 */
const ROLE_ORDER = [ROLES.PLAYER, ROLES.MODERATOR, ROLES.ADMIN];

/** 各角色的权限节点集 (自定义权限 = 节点字符串, 保留扩展) */
const PERMISSION_NODES = {
  [ROLES.PLAYER]: new Set([
    'chat.send',
    'chat.private',
    'world.interact',   // 挖掘/放置
    'tp.self',          // /tp 自己
    'economy.pay',
    'claim.create',
  ]),
  [ROLES.MODERATOR]: new Set([
    'player.kick',
    'player.list',
    'world.claim.bypass', // 越过土地保护
    'admin.say',
    'admin.tps',
  ]),
  [ROLES.ADMIN]: new Set([
    'player.ban',
    'player.unban',
    'player.op',
    'player.gamemode',
    'admin.broadcast',
    'admin.save',
    'economy.grant',
  ]),
};

/** 判断角色是否至少达到目标等级 */
export function roleAtLeast(role, target) {
  const ri = ROLE_ORDER.indexOf(role ?? ROLES.PLAYER);
  const ti = ROLE_ORDER.indexOf(target);
  return ri >= 0 && ti >= 0 && ri >= ti;
}

/**
 * 权限检查主入口
 * @param {{role?: string, extraPerms?: string[]}} player 会话 (含内存扩展权限)
 * @param {string} node 权限节点, 如 'player.kick'
 */
export function hasPermission(player, node) {
  if (!player) return false;
  const role = player.role ?? ROLES.PLAYER;
  if (!ROLE_ORDER.includes(role)) return false;
  // 继承: admin 拥有 moderator+player 全部节点 (构建时按序展开)
  const idx = ROLE_ORDER.indexOf(role);
  for (let i = 0; i <= idx; i++) {
    if (PERMISSION_NODES[ROLE_ORDER[i]]?.has(node)) return true;
  }
  return player.extraPerms?.includes(node) ?? false;
}

/** 角色合法化 (未知值兜底 player) */
export function normalizeRole(role) {
  return ROLE_ORDER.includes(role) ? role : ROLES.PLAYER;
}
