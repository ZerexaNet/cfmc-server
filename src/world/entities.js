/**
 * ============================================================================
 * entities.js — 实体系统与怪物 AI (Phase 4: 僵尸/猪的基本行为)
 * ============================================================================
 * 纯逻辑模块: AI 决策输出"期望速度", 方块碰撞通过注入的 world 回调完成。
 * RegionDO 每 tick 调 tickAll(), 并把位移/销毁广播出去 (EntityMove/EntityDestroy)。
 *
 * 设计约束:
 *   - 单区域实体上限 (默认 12), 无人在线不生成 (DO 休眠零成本的前提)
 *   - 攻击只对"区域内玩家"生效, 伤害走 UpdateHealth 回包
 *   - 全部行为确定性伪随机 (seeded LCG), 保证可测性
 */

import { Vec3 } from '../utils/math3d.js';
import { ENTITY_TYPES } from '../utils/constants.js';

/** AI 类型注册表: tick(state, ctx) 返回期望位移向量 */
const AI = {
  /** 僵尸: 白天游荡, 夜晚追最近玩家并攻击 */
  zombie: {
    health: 20,
    speed: 0.08,
    attackDamage: 3,
    attackRange: 1.6,
    attackCooldownTicks: 20,
    tick(e, ctx) {
      const target = ctx.nearestPlayer(e.pos, 24);
      if (target && ctx.isNight()) {
        // 追击 (水平方向归一化)
        const dx = target.pos.x - e.pos.x;
        const dz = target.pos.z - e.pos.z;
        const len = Math.hypot(dx, dz) || 1;
        e.yaw = (Math.atan2(-dx, dz) * 180) / Math.PI;
        if (len > this.attackRange) return { vx: (dx / len) * this.speed, vy: e.vy, vz: (dz / len) * this.speed };
        // 攻击冷却
        if (ctx.tick - e.lastAttackTick >= this.attackCooldownTicks) {
          e.lastAttackTick = ctx.tick;
          ctx.damagePlayer(target.uuid, this.attackDamage, e.id);
        }
        return { vx: 0, vy: e.vy, vz: 0 };
      }
      return wander(e, ctx, this.speed * 0.5);
    },
  },
  /** 猪: 纯游荡 (食物来源占位) */
  pig: {
    health: 10,
    speed: 0.05,
    tick(e, ctx) {
      return wander(e, ctx, this.speed);
    },
  },
};

/** 游荡: 每 40-80 tick 随机换一次方向, 撞墙 (前方不可通行) 也换向 */
function wander(e, ctx, speed) {
  if (e.wanderTicksLeft-- <= 0) {
    e.wanderTicksLeft = 40 + (ctx.random() * 40) | 0;
    e.wanderYaw = ctx.random() * Math.PI * 2;
  }
  const vx = Math.sin(e.wanderYaw) * speed;
  const vz = Math.cos(e.wanderYaw) * speed;
  e.yaw = (e.wanderYaw * 180) / Math.PI;
  // 简单地面物理: 只在"下一格可站立"时移动 (world.canStand 回调)
  if (!ctx.canStand(e.pos.x + vx, e.pos.y, e.pos.z + vz)) {
    e.wanderTicksLeft = 0;
    return { vx: 0, vy: e.vy, vz: 0 };
  }
  return { vx, vy: e.vy, vz };
}

/** 确定性伪随机 (LCG) — 同 seed 同行为序列, 便于回归测试 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 0x100000000);
}

export class EntityWorld {
  constructor({ maxEntities = 12, hostilesPerPlayer = 1 } = {}) {
    /** entityId → entity { id, type, ai, pos, vy, yaw, health, lastAttackTick, wanderTicksLeft, wanderYaw } */
    this.entities = new Map();
    this.nextId = 1;
    this.maxEntities = maxEntities;
    this.hostilesPerPlayer = hostilesPerPlayer;
    this.spawnCooldown = 0;
  }

  /** 手动生成 (测试/管理命令用) */
  spawn(typeName, x, y, z, seed = Date.now()) {
    const t = ENTITY_TYPES[typeName?.toUpperCase()];
    const ai = AI[typeName?.toLowerCase()];
    if (!ai) return null;
    const e = {
      id: this.nextId++,
      type: typeName.toLowerCase(),
      pos: new Vec3(x, y, z),
      vy: 0,
      yaw: 0,
      health: ai.health,
      lastAttackTick: -999,
      wanderTicksLeft: 0,
      wanderYaw: 0,
      random: lcg(seed + this.nextId),
    };
    this.entities.set(e.id, e);
    return e;
  }

  despawn(id) {
    return this.entities.delete(id);
  }

  /** 伤害实体 (玩家攻击) — 返回是否致死 (调用方广播销毁/掉落) */
  damage(id, amount) {
    const e = this.entities.get(id);
    if (!e) return { dead: false, health: 0 };
    e.health -= amount;
    if (e.health <= 0) {
      this.entities.delete(id);
      return { dead: true, health: 0, type: e.type, pos: e.pos };
    }
    return { dead: false, health: e.health };
  }

  /**
   * 每 tick 推进 AI + 物理
   * @param {object} ctx 注入回调:
   *   tick, isNight(), random() 不用 (实体自带), nearestPlayer(pos,range) → {uuid,pos}|null,
   *   damagePlayer(uuid, amount, byEntityId), canStand(x,y,z) → boolean,
   *   onEntityMove(entity), broadcast helpers 由 RegionDO 在回调中处理
   */
  tickAll(ctx) {
    for (const e of this.entities.values()) {
      const ai = AI[e.type];
      if (!ai) continue;
      const move = ai.tick.call(ai, e, { ...ctx, random: e.random, tick: ctx.tick });
      // 应用位移 (垂直: 重力; 地形收敛交给 canStand/区域边界)
      e.vy = Math.max(e.vy - 0.04, -1.5);
      e.pos.set(e.pos.x + move.vx, e.pos.y + move.vy, e.pos.z + move.vz);
      if (move.vx !== 0 || move.vz !== 0 || move.vy !== 0) ctx.onEntityMove(e);
    }

    // 生成器: 有玩家 & 敌对数不足 & 冷却结束 → 在随机玩家 16-32 格外刷怪
    if (this.spawnCooldown > 0) this.spawnCooldown--;
    const players = ctx.playersList();
    if (this.entities.size < this.maxEntities && this.spawnCooldown === 0 && players.length > 0) {
      const hostiles = [...this.entities.values()].filter((e) => e.type === 'zombie').length;
      if (hostiles < players.length * this.hostilesPerPlayer) {
        const p = players[(ctx.random01() * players.length) | 0];
        const angle = ctx.random01() * Math.PI * 2;
        const dist = 16 + ctx.random01() * 16;
        const x = p.pos.x + Math.sin(angle) * dist;
        const z = p.pos.z + Math.cos(angle) * dist;
        if (ctx.canStand(x, p.pos.y, z)) {
          const e = this.spawn('zombie', x, p.pos.y, z, (ctx.random01() * 1e9) | 0);
          if (e) {
            this.spawnCooldown = 100; // 5 秒
            ctx.onEntitySpawn(e);
          }
        }
      }
    }
  }

  stats() {
    const byType = {};
    for (const e of this.entities.values()) byType[e.type] = (byType[e.type] ?? 0) + 1;
    return { total: this.entities.size, byType };
  }
}
