/**
 * ============================================================================
 * economy.js — 经济系统 (Phase 4: 货币/转账, 服务端权威)
 * ============================================================================
 * 纯逻辑模块: 只算账不存钱。余额真源 = users 库 player_data.coins 列
 * (见 migrations/002); RegionDO 内存缓存 + 变更落盘。
 *
 * 防作弊要点: /pay 服务端校验余额, 拒绝透支; 不存在离线交易 (目标必须在线,
 * 避免名字混淆诈骗)。
 */

export const STARTING_BALANCE = 100;

/** 余额格式化 (整数币, 无小数 — 规避浮点误差) */
export function format(amount) {
  return `${Math.floor(amount)} 金币`;
}

/**
 * 转账校验 (不落库, 只算合法性; RegionDO 据此扣加并广播)
 * @returns {{ok:true, amount:number}|{ok:false, reason:string}}
 */
export function validatePay(fromBalance, amount) {
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: '金额必须为正整数' };
  if (fromBalance < amt) return { ok: false, reason: `余额不足 (当前 ${fromBalance})` };
  return { ok: true, amount: amt };
}

/** 发放上限 (管理员 /grant 单次), 防手滑打崩通胀 */
export const MAX_GRANT = 100_000;
