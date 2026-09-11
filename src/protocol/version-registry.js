/**
 * ============================================================================
 * MC 协议版本注册表 — "所有协议支持"的单一数据源
 * ============================================================================
 *
 * 设计目标 (2025-09 全协议改造):
 *   服务端不锁死某个 MC 版本 —— 任何版本的 CFMC Mod 客户端都能连。
 *   实现方式:
 *     1. CFMC 私有协议 (v2) 的线上格式与 MC 版本完全解耦:
 *        - 方块以名字符串传输 ("minecraft:stone"), 不用 numeric stateId
 *        - 区块调色板下发名字符串, 客户端 Mod 用自己版本的注册表解析
 *     2. 本注册表只负责: 识别客户端版本 → 选适配器 → 协商能力
 *
 * 协议号数据源: wiki.vg "Protocol version numbers" (截至 1.21.8, 2025-08)
 *   ⚠️ Mojang 每个正式版都可能换协议号 —— 新版本发布后在此表加一行即可,
 *      无需改动任何其他代码 (这是"加版本=改一行"的设计承诺)。
 *
 * 版本族 (FAMILY) 划分依据:
 *   - LEGACY (1.8~1.12.2): 方块无命名空间 ID (1.13 flattening 之前),
 *     聊天是 legacy § 颜色码, 区块数据按"列" (column) 组织
 *   - FLAT   (1.13~1.20.1): 字符串方块 ID, 世界高度 1.18+ 扩到 [-64,320)
 *   - MODERN (1.20.2+): 原版引入 Configuration 状态机与签名聊天 ——
 *     但 CFMC Mod 走私有协议, 不受原版状态机约束, 影响仅限功能集差异
 * ============================================================================
 */

/**
 * MC 版本 → 协议号映射 (按协议号升序)
 * key = 该协议号代表的主要版本, aliases = 同协议号的其他版本
 * @readonly
 * @type {Array<{proto: number, version: string, aliases?: string[]}>}
 */
export const MC_PROTOCOLS = [
  { proto: 47,  version: '1.8',    aliases: ['1.8.3', '1.8.7', '1.8.9'] },
  { proto: 107, version: '1.9',    aliases: [] },
  { proto: 108, version: '1.9.1',  aliases: [] },
  { proto: 110, version: '1.9.4',  aliases: ['1.10', '1.10.2'] },
  { proto: 210, version: '1.11',   aliases: [] },
  { proto: 316, version: '1.11.2', aliases: ['1.12', '1.12.1'] },
  { proto: 340, version: '1.12.2', aliases: [] },
  { proto: 393, version: '1.13',   aliases: ['1.13.1', '1.13.2'] },
  { proto: 404, version: '1.13.2', aliases: [] },
  { proto: 480, version: '1.14',   aliases: ['1.14.1', '1.14.2', '1.14.3'] },
  { proto: 498, version: '1.14.4', aliases: [] },
  { proto: 575, version: '1.15',   aliases: ['1.15.1'] },
  { proto: 578, version: '1.15.2', aliases: [] },
  { proto: 735, version: '1.16',   aliases: [] },
  { proto: 751, version: '1.16.1', aliases: ['1.16.2', '1.16.3'] },
  { proto: 754, version: '1.16.5', aliases: ['1.16.4'] },
  { proto: 755, version: '1.17',   aliases: [] },
  { proto: 756, version: '1.17.1', aliases: [] },
  { proto: 757, version: '1.18',   aliases: ['1.18.1'] },
  { proto: 758, version: '1.18.2', aliases: [] },
  { proto: 759, version: '1.19',   aliases: [] },
  { proto: 760, version: '1.19.1', aliases: ['1.19.2'] },
  { proto: 761, version: '1.19.3', aliases: [] },
  { proto: 762, version: '1.19.4', aliases: [] },
  { proto: 763, version: '1.20.1', aliases: [] },
  { proto: 764, version: '1.20.2', aliases: [] },
  { proto: 765, version: '1.20.4', aliases: ['1.20.3'] },
  { proto: 766, version: '1.20.6', aliases: ['1.20.5'] },
  { proto: 767, version: '1.21',   aliases: ['1.21.1'] },
  { proto: 768, version: '1.21.3', aliases: ['1.21.2'] },
  { proto: 769, version: '1.21.4', aliases: [] },
  { proto: 770, version: '1.21.5', aliases: [] },
  { proto: 771, version: '1.21.6', aliases: [] },
  { proto: 772, version: '1.21.8', aliases: ['1.21.7'] },
];

/** 协议号 → 条目的 O(1) 索引 (模块加载时构建一次) */
const PROTO_INDEX = new Map();
for (const entry of MC_PROTOCOLS) PROTO_INDEX.set(entry.proto, entry);

/** 支持范围: 最老 1.8 (47) ~ 最新已收录 (772)。
 *  超出范围的客户端: 未知协议号仍可连接 (generic 适配器兜底),
 *  只是在握手 ACK 里提示 "未识别版本"。 */
export const OLDEST_PROTOCOL = MC_PROTOCOLS[0].proto;
export const LATEST_PROTOCOL = MC_PROTOCOLS[MC_PROTOCOLS.length - 1].proto;

/**
 * 版本族
 * @readonly
 * @enum {{ name: string, minProto: number, maxProto: number, desc: string }}
 */
export const VERSION_FAMILIES = {
  LEGACY: {
    name: 'legacy',
    minProto: 47,
    maxProto: 340, // 1.8 ~ 1.12.2: 数字方块 ID 时代
    desc: '方块数字 ID / legacy 聊天码 / 列式区块',
  },
  FLAT: {
    name: 'flat',
    minProto: 393,
    maxProto: 763, // 1.13 ~ 1.20.1: flattening 后字符串 ID 时代
    desc: '命名空间方块 ID / JSON 文本组件 / 高度 [-64,320)',
  },
  MODERN: {
    name: 'modern',
    minProto: 764,
    maxProto: 9999, // 1.20.2+: 原版配置状态机时代 (CFMC 私有协议不受其约束)
    desc: '1.20.2+ 功能集; CFMC 走私有协议无状态机负担',
  },
};

/**
 * 由协议号查版本信息
 * @param {number} proto 客户端 MC 协议号
 * @returns {{ proto:number, version:string, aliases:string[], family:string, known:boolean }}
 *          known=false 表示未收录 (仍允许连接, generic 适配器兜底)
 */
export function getMcVersionInfo(proto) {
  const entry = PROTO_INDEX.get(proto);
  if (entry) {
    return {
      proto,
      version: entry.version,
      aliases: entry.aliases ?? [],
      family: familyOf(proto),
      known: true,
    };
  }
  // 未收录: 按范围归族 (未来版本自动落入 MODERN 族)
  return { proto, version: `unknown(${proto})`, aliases: [], family: familyOf(proto), known: false };
}

/** 协议号 → 版本族名 */
export function familyOf(proto) {
  if (proto <= VERSION_FAMILIES.LEGACY.maxProto) return 'legacy';
  if (proto <= VERSION_FAMILIES.FLAT.maxProto) return 'flat';
  return 'modern';
}

/**
 * 握手决策: 服务端应如何对待这个客户端
 * @param {number} clientProto 客户端上报的 MC 协议号 (0 = 未上报, 如 v1 协议的老客户端)
 * @returns {import('./version-adapters.js').HandshakeDecision}
 */
export function decideHandshake(clientProto) {
  if (!clientProto || clientProto <= 0) {
    // v1 老客户端 / 浏览器调试: 接受, generic 适配器 (能力按最小集)
    return { accept: true, adapter: 'generic', reason: 'client-did-not-report-mc-protocol' };
  }
  const info = getMcVersionInfo(clientProto);
  return {
    accept: true, // 全协议支持: 任何协议号都接受
    adapter: info.family, // legacy / flat / modern
    reason: info.known ? 'ok' : 'unknown-proto-fallback-generic-capabilities',
    versionInfo: info,
  };
}

/** 供 GET / 服务信息与握手 ACK 使用: 简化的支持范围描述 */
export function supportSummary() {
  return {
    mcProtocolMin: OLDEST_PROTOCOL,
    mcProtocolMax: LATEST_PROTOCOL,
    versions: `1.8 ~ ${MC_PROTOCOLS[MC_PROTOCOLS.length - 1].version}`,
    families: ['legacy', 'flat', 'modern'],
    note: '方块以命名空间 ID 传输, 线上协议与 MC 版本解耦',
  };
}
