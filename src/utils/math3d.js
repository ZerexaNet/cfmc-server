/**
 * 3D 数学工具 — 向量 / AABB 碰撞 (Phase 2 物理引擎的地基)
 *
 * 与原版 Minecraft 的差异:
 *   原版物理在服务端权威计算 + 客户端预测; 本项目 Phase 1/2 服务端只做
 *   "防穿墙"级别的验证 (AABB vs 方块), 全量物理 (流体/活塞推动) Phase 4。
 *
 * 坐标约定 (与原版一致):
 *   - 方块坐标是整数格; 实体位置是浮点 (脚底中心)
 *   - AABB 用 [minX,maxX]×[minY,maxY]×[minZ,maxZ] 闭区间
 */

/** 简单三维向量 (可变对象, 避免每 tick 大量分配导致 GC 压力) */
export class Vec3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x, y, z) {
    this.x = x; this.y = y; this.z = z;
    return this;
  }

  /** 欧氏距离平方 (避免 sqrt, 高频比较用它) */
  distanceSquaredTo(o) {
    const dx = this.x - o.x, dy = this.y - o.y, dz = this.z - o.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** 水平面 (XZ) 距离平方 — 用于视距/同步范围过滤 */
  horizontalDistanceSquaredTo(o) {
    const dx = this.x - o.x, dz = this.z - o.z;
    return dx * dx + dz * dz;
  }

  clone() {
    return new Vec3(this.x, this.y, this.z);
  }
}

/**
 * 轴对齐包围盒 (AABB)
 * 典型玩家碰撞箱: 宽 0.6, 高 1.8 → fromFeet(pos) 生成
 */
export class AABB {
  constructor(minX, minY, minZ, maxX, maxY, maxZ) {
    this.minX = minX; this.minY = minY; this.minZ = minZ;
    this.maxX = maxX; this.maxY = maxY; this.maxZ = maxZ;
  }

  /** 由实体脚底位置 + 尺寸生成碰撞箱 */
  static fromFeet(pos, width = 0.6, height = 1.8) {
    const half = width / 2;
    return new AABB(pos.x - half, pos.y, pos.z - half, pos.x + half, pos.y + height, pos.z + half);
  }

  intersects(o) {
    return this.minX < o.maxX && this.maxX > o.minX &&
           this.minY < o.maxY && this.maxY > o.minY &&
           this.minZ < o.maxZ && this.maxZ > o.minZ;
  }

  /** 平移 (返回新对象, 原对象常被复用为"当前帧箱") */
  offset(dx, dy, dz) {
    return new AABB(this.minX + dx, this.minY + dy, this.minZ + dz,
                    this.maxX + dx, this.maxY + dy, this.maxZ + dz);
  }
}

/** 区块坐标换算: 世界坐标 → 区块坐标 (负数也要正确! 位运算 >> 4 即 floor 除 16) */
export function worldToChunk(x, z) {
  return { cx: x >> 4, cz: z >> 4 };
}

/** 世界坐标 → Section 索引 (Y): section_y = floor(worldY/16), 范围 -4..19 */
export function worldYToSectionY(y) {
  return Math.floor(y / 16);
}

/** 世界坐标 → Section 内部索引 (Y<<8 | Z<<4 | X, 与原版打包顺序一致) */
export function worldToSectionIndex(x, y, z) {
  return ((y & 0xf) << 8) | ((z & 0xf) << 4) | (x & 0xf);
}

/** 数值钳制 */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
