/**
 * ============================================================================
 * 版本适配器 — 按客户端 MC 版本族定制服务端行为
 * ============================================================================
 *
 * 为什么需要适配器 (全协议支持的第二块拼图):
 *   CFMC v2 线上协议已经版本中立 (方块走名字符串), 但仍有一层"版本语义"
 *   无法完全回避 —— 例如 legacy 客户端 (1.8~1.12.2) 的 Mod 需要把
 *   "minecraft:grass_block" 翻译回它那个版本的数字 ID / 旧命名
 *   ("minecraft:grass")。适配器把这层差异收敛在一个接口后面:
 *
 *     服务端逻辑 (版本无关) → 适配器 (版本语义) → 线上协议 (CFMC v2)
 *
 * 现状 (v2 首版): 适配器目前承担
 *   1. 握手 ACK 的能力协商字段 (adapter 名/支持范围)
 *   2. 方块名的规范化与校验 (legacy 族做旧名兼容映射)
 *   3. 每版本行为开关 (聊天格式/高度上限), 供后续 Phase 直接消费
 *
 * TODO(Phase 3+): 原版协议直连翻译 (无 Mod 客户端经 ViaVersion 式翻译层)
 *   届时 legacyPalettes/numeric 映射表在此扩展 —— 接口已预留。
 * ============================================================================
 */

import { MC_PROTOCOLS, OLDEST_PROTOCOL, LATEST_PROTOCOL } from './version-registry.js';

/**
 * @typedef {Object} HandshakeDecision
 * @property {boolean} accept
 * @property {string} adapter  适配器名 ('legacy'|'flat'|'modern'|'generic')
 * @property {string} reason
 * @property {Object} [versionInfo]
 */

/**
 * @typedef {Object} AdapterCapabilities
 * @property {string} chatFormat        'json' | 'legacy'
 * @property {number} worldHeightMin
 * @property {number} worldHeightMax
 * @property {boolean} nameSpacedBlocks 方块 ID 是否带命名空间 (1.13+)
 */

/** 适配器基类 —— 子类只覆写有差异的部分 */
export class ProtocolAdapter {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
  }

  /** 该族客户端的能力描述 (随 HandshakeAck 下发) */
  capabilities() {
    return {
      chatFormat: 'json',
      worldHeightMin: -64,
      worldHeightMax: 320,
      nameSpacedBlocks: true,
    };
  }

  /**
   * 规范化客户端上报的方块名 → 服务端存储格式
   * 默认: 已带命名空间直接用; 裸名补 minecraft: 前缀
   * @param {string} name
   * @returns {string|null} null = 非法方块名 (拒绝)
   */
  normalizeBlockName(name) {
    if (typeof name !== 'string') return null;
    const n = name.trim().toLowerCase();
    // 长度闸门 + 字符白名单: minecraft:stone / oak_stairs[facing=east]
    if (n.length === 0 || n.length > 128) return null;
    if (!/^[a-z0-9_\-\.]+(:[a-z0-9_\-\.\/]+)?(\[[a-z0-9_=\,\.\-]+\])?$/.test(n)) return null;
    return n.includes(':') ? n : `minecraft:${n}`;
  }

  /** 服务端方块名 → 该族客户端期望的名字 (legacy 族覆写做旧名映射) */
  toClientBlockName(name) {
    return name;
  }

  /** 握手 ACK 里下发的支持范围 (默认全范围) */
  supportedRange() {
    return { min: OLDEST_PROTOCOL, max: LATEST_PROTOCOL };
  }
}

/** Legacy 族 (1.8~1.12.2): 数字方块 ID 时代的兼容层 */
export class LegacyAdapter extends ProtocolAdapter {
  constructor() {
    super('legacy');
    /** 1.13 flattening 改名表 (反向): 现名 → 旧名 (客户端 Mod 侧再映射数字 ID)
     *  只列高频方块; 完整表见数据生成器 TODO(Phase 3) */
    this.legacyNames = new Map([
      ['minecraft:grass_block', 'minecraft:grass'],
      ['minecraft:short_grass', 'minecraft:tallgrass'],
      ['minecraft:oak_planks', 'minecraft:planks'],
      ['minecraft:dirt_path', 'minecraft:grass_path'],
    ]);
  }

  capabilities() {
    return { chatFormat: 'legacy', worldHeightMin: 0, worldHeightMax: 256, nameSpacedBlocks: false };
  }

  toClientBlockName(name) {
    return this.legacyNames.get(name) ?? name;
  }
}

/** Flat 族 (1.13~1.20.1): 现代字符串 ID, 但部分老版本无 1.18 高度扩展 */
export class FlatAdapter extends ProtocolAdapter {
  constructor() {
    super('flat');
  }

  capabilities() {
    // 高度: 1.14.4 以下仍是 [0,256); 精确 per-proto 区分 Phase 2 (此刻统一按新高度,
    // 老版本 Mod 侧 clamp 即可 —— 方块数据按 section 独立编码, 不受影响)
    return { chatFormat: 'json', worldHeightMin: -64, worldHeightMax: 320, nameSpacedBlocks: true };
  }
}

/** Modern 族 (1.20.2+): 与 CFMC v2 协议同期设计的版本, 无历史包袱 */
export class ModernAdapter extends ProtocolAdapter {
  constructor() {
    super('modern');
  }
}

/** Generic 兜底: 未知协议号 / 未上报版本 (浏览器调试、v1 老客户端) */
export class GenericAdapter extends ProtocolAdapter {
  constructor() {
    super('generic');
  }
}

/** 适配器单例表 (无状态, 全局复用) */
const ADAPTERS = {
  legacy: new LegacyAdapter(),
  flat: new FlatAdapter(),
  modern: new ModernAdapter(),
  generic: new GenericAdapter(),
};

/**
 * 选择适配器 (RegionDO 握手时调用)
 * @param {string} familyName 'legacy' | 'flat' | 'modern' | 'generic'
 * @returns {ProtocolAdapter}
 */
export function selectAdapter(familyName) {
  return ADAPTERS[familyName] ?? ADAPTERS.generic;
}

/** 供日志/ACK 使用的适配器名列表 */
export function adapterNames() {
  return Object.keys(ADAPTERS);
}

/** 测试/调试辅助: 重置 (仅单测使用) */
export function _adaptersForTest() {
  return ADAPTERS;
}

// 保留 MC_PROTOCOLS 引用避免 tree-shaking 误判 (供未来 numeric 调色板翻译用)
void MC_PROTOCOLS;
