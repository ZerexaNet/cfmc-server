/**
 * ============================================================================
 * anticheat.js — 基础反作弊: 速度 / 飞行 / 垂直速度检测 (Phase 3)
 * ============================================================================
 * 纯逻辑模块。设计原则 (cfmc.md 要求):
 *   1. 误杀率优先于拦截率 —— 单次超标只标记, 连续/显著超标才回拉校正
 *   2. 校正 = 服务端回拉到上一个合法位置 (客户端预测的标准对应面)
 *   3. 创造/旁观模式豁免飞行检查; 服务端传送后有宽限期
 */

/** 每 tick 水平位移上限 (方块/50ms): 走 0.22 跑 0.33 疾跑 0.45, 留网络抖动余量 */
const MAX_HORIZONTAL_PER_TICK = { survival: 0.7, adventure: 0.7, creative: 2.0, spectator: 16 };
/** 每 tick 垂直位移上限 (跳跃 0.42 / 坠落终端速度放宽) */
const MAX_UP_PER_TICK = { survival: 0.9, creative: 2.0, spectator: 16 };
const MAX_DOWN_PER_TICK = 3.92;
/** 连续 N tick 离地且无明显位移 → 飞行嫌疑 (跳跃滞空 <12 tick) */
const FLY_AIR_TICKS = 25;
/** 服务端传送后的宽限时长 */
const TELEPORT_GRACE_MS = 1500;

export class MovementTracker {
  constructor(gamemode = 'survival') {
    this.gamemode = gamemode;
    /** 上一个被接受的位置 {x,y,z,onGround} */
    this.last = null;
    /** 连续空中 tick 计数 */
    this.airTicks = 0;
    /** 反作弊标记累计 (供 /api 监控与管理员观察) */
    this.flags = 0;
    /** 最近一次合法传送时间戳 (服务端 /tp 后宽限) */
    this.lastTeleportAt = 0;
  }

  setGamemode(gm) {
    this.gamemode = gm;
  }

  /** 服务端传送后调用: 下一次大位移合法 */
  markTeleport(pos) {
    this.lastTeleportAt = Date.now();
    this.last = { ...pos };
    this.airTicks = 0;
  }

  /**
   * 喂入一次移动输入
   * @param {{x:number,y:number,z:number,onGround:boolean}} pos
   * @returns {{action:'accept'}|{action:'correct', pos:object, reason:string, flags:number}}
   */
  feed(pos) {
    if (!this.last) {
      this.last = { ...pos };
      return { action: 'accept' };
    }

    const dx = pos.x - this.last.x;
    const dy = pos.y - this.last.y;
    const dz = pos.z - this.last.z;
    const horizontalSq = dx * dx + dz * dz;
    const grace = Date.now() - this.lastTeleportAt < TELEPORT_GRACE_MS;

    // 1. 传送宽限期内全部放行 (只更新基线, 不累积滞空)
    if (grace) {
      this.last = { ...pos, onGround: pos.onGround };
      this.airTicks = pos.onGround ? 0 : this.airTicks;
      return { action: 'accept' };
    }

    // 2. 水平速度检查 (所有模式)
    const hLim = MAX_HORIZONTAL_PER_TICK[this.gamemode] ?? MAX_HORIZONTAL_PER_TICK.survival;
    if (horizontalSq > hLim * hLim) {
      this.flags++;
      return this.#correct('speed', `水平位移超限 (${Math.sqrt(horizontalSq).toFixed(2)} > ${hLim})`);
    }

    // 3. 垂直速度 + 飞行检查 (生存/冒险)
    if (this.gamemode === 'survival' || this.gamemode === 'adventure') {
      if (dy > MAX_UP_PER_TICK.survival) {
        this.flags++;
        return this.#correct('vertical', `上升速度超限 (${dy.toFixed(2)})`);
      }
      if (dy < -MAX_DOWN_PER_TICK) {
        this.flags++;
        return this.#correct('vertical', `下落速度超限 (${dy.toFixed(2)})`);
      }

      if (!pos.onGround) {
        this.airTicks++;
        if (this.airTicks > FLY_AIR_TICKS && Math.abs(dy) < 0.05) {
          this.flags++;
          return this.#correct('fly', `疑似飞行 (滞空 ${this.airTicks} tick 且无位移)`);
        }
      } else {
        this.airTicks = 0;
      }
    }

    this.last = { ...pos, onGround: pos.onGround };
    return { action: 'accept' };
  }

  #correct(reason, detail) {
    this.airTicks = 0;
    return { action: 'correct', pos: { ...this.last }, reason, detail, flags: this.flags };
  }
}
