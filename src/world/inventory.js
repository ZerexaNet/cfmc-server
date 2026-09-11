/**
 * ============================================================================
 * inventory.js — 背包模型 (Phase 3: 完整 36 格 + 装备 + 副手)
 * ============================================================================
 * 纯逻辑模块。物品栈 = { item: "minecraft:diamond_sword", count: 1, extra?: object }。
 *
 * 槽位布局 (与客户端约定一致):
 *   0–8   快捷栏
 *   9–35  主背包
 *   36–39 盔甲 (靴/腿/胸/头)
 *   40    副手
 *
 * 网络同步:
 *   - 上线/背包变更整包 → S2C WindowItems (0x0F)
 *   - 单格变更 → S2C SetSlot (0x0E)
 *   C2S ContainerClick (0x1B) 在 RegionDO 分派到这里处理。
 */

export const INVENTORY_SIZE = 41;

/** 创建空背包 (可带初始物品, Phase 2 出生物资) */
export function create(initial = []) {
  const inv = { slots: new Array(INVENTORY_SIZE).fill(null), held: 0, cursor: null, nextId: 1 };
  for (const { slot, item, count } of initial) {
    if (slot >= 0 && slot < INVENTORY_SIZE) inv.slots[slot] = makeStack(item, count);
  }
  return inv;
}

export function makeStack(item, count = 1) {
  return { item, count: Math.max(1, Math.min(64, count)) };
}

/** 序列化为 JSON (存 player_data.inventory, 供断线重连恢复) */
export function serialize(inv) {
  return JSON.stringify({
    slots: inv.slots,
    held: inv.held,
    // cursor 不持久化: 掉线时持着的东西留在背包逻辑外, 丢入背包失败则丢弃 (防复制)
  });
}

/** 反序列化 (损坏数据静默回退空背包 — 永不让玩家因数据问题进不了服) */
export function deserialize(json) {
  try {
    const raw = typeof json === 'string' ? JSON.parse(json) : json;
    if (!raw || !Array.isArray(raw.slots)) return create();
    const inv = create();
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = raw.slots[i];
      inv.slots[i] = s && s.item ? makeStack(s.item, s.count ?? 1) : null;
    }
    inv.held = Number.isInteger(raw.held) ? Math.min(8, Math.max(0, raw.held)) : 0;
    return inv;
  } catch {
    return create();
  }
}

/**
 * 容器点击: 简化交换模型 (点击 = 拿起/放下/交换; 无右键分半/shift 整理, 保持协议最小集)
 * @returns {boolean} 是否发生变更 (调用方决定是否广播 SetSlot/WindowItems)
 */
export function handleClick(inv, slot, button = 0) {
  if (slot < 0 || slot >= INVENTORY_SIZE) return false;
  const target = inv.slots[slot];

  if (inv.cursor) {
    if (!target) {
      inv.slots[slot] = inv.cursor;
      inv.cursor = null;
    } else if (target.item === inv.cursor.item) {
      // 同类合并 (超 64 退回光标)
      const total = target.count + inv.cursor.count;
      target.count = Math.min(64, total);
      inv.cursor = total > 64 ? makeStack(inv.cursor.item, total - 64) : null;
    } else {
      inv.slots[slot] = inv.cursor;
      inv.cursor = target;
    }
    return true;
  }

  if (target) {
    inv.cursor = target;
    inv.slots[slot] = null;
    return true;
  }
  return false;
}

/** 获得物品 (优先叠加快捷栏, 再找空位; 返回是否全部入包) */
export function addItem(inv, item, count = 1) {
  let left = count;
  for (let i = 0; i < INVENTORY_SIZE && left > 0; i++) {
    const s = inv.slots[i];
    if (s && s.item === item && s.count < 64) {
      const take = Math.min(64 - s.count, left);
      s.count += take;
      left -= take;
    }
  }
  for (let i = 0; i < INVENTORY_SIZE && left > 0; i++) {
    if (!inv.slots[i]) {
      const take = Math.min(64, left);
      inv.slots[i] = makeStack(item, take);
      left -= take;
    }
  }
  return left === 0;
}

/** 放置方块时消耗手持 1 个 (生存模式; 返回消耗是否成功) */
export function consumeHeld(inv) {
  const s = inv.slots[inv.held];
  if (!s) return false;
  if (--s.count <= 0) inv.slots[inv.held] = null;
  return true;
}

/** 切换快捷栏槽位 */
export function setHeld(inv, slot) {
  if (slot >= 0 && slot <= 8) inv.held = slot;
}

/** 整包快照 (WindowItems payload: slots 数组原样) */
export function snapshot(inv) {
  return inv.slots.map((s) => (s ? { item: s.item, count: s.count } : null));
}
