/**
 * ============================================================================
 * 游戏常量 — 方块 / 实体 / 维度 / 引擎参数
 * ============================================================================
 *
 * ⚠️ 方块状态 ID (Block State ID) 与 Minecraft 版本强绑定!
 *    下表数值对齐 1.20.4 (与 cfmc-client 的 fabric.mod.json depends 声明一致),
 *    来源 wiki.vg "Block States" 全量列表。
 *    TODO(Phase 2): 写一个代码生成脚本从 piston-meta 版本清单导出完整
 *    block-state 映射, 替换本文件的手工片段 (手工只保留高频方块做参考)。
 *
 * 为什么用"全局状态ID + 调色板":
 *   一个方块状态 = 方块类型 + 全部属性组合 (如 oak_stairs[face=east,...]),
 *   1.20.4 约有 26000+ 个状态 ID。区块存储时用调色板 (本区块出现的ID去重表)
 *   + 索引数组, 单 Section 存储从 4KB+ 压到通常 <1KB (cfmc.md ChunkData 包)。
 * ============================================================================
 */

/** 引擎与网络参数 (默认值; 运行时可被 wrangler.toml [vars] 覆盖) */
export const DEFAULTS = {
  /** Tick 周期 (ms) — 20 TPS, 与原版一致 */
  TICK_RATE_MS: 50,
  /** 每 N tick 批量持久化一次脏区块 (100 tick = 5s) */
  PERSIST_INTERVAL_TICKS: 100,
  /** 每 N tick 保存玩家数据到 D1 (1200 tick = 60s) */
  PLAYER_SAVE_INTERVAL_TICKS: 1200,
  /** 单 tick CPU 预算 (ms) — 超过即熔断剩余逻辑, 留余量给平台 (要求: <40ms) */
  TICK_CPU_BUDGET_MS: 40,
  /** 心跳超时 (ms) — 超时未收到 KeepAlive 判定掉线 */
  HEARTBEAT_TIMEOUT_MS: 30_000,
  /** 区块缓存上限 (LRU) — 256 区块 ≈ 峰值内存 <80MB 的经验值 */
  CHUNK_CACHE_SIZE: 256,
  /** 默认视距 (区块) */
  VIEW_DISTANCE: 6,
  /** 单区域最大玩家数 */
  MAX_PLAYERS_PER_REGION: 25,
  /** Payload 压缩阈值 (字节) — 与 packet-definitions 保持一致 */
  COMPRESSION_THRESHOLD: 256,
};

/** 区块几何 (1.18+ 世界规格, 与原版一致) */
export const CHUNK = {
  SIZE_X: 16,
  SIZE_Z: 16,
  /** 单 Section 高度 */
  SECTION_HEIGHT: 16,
  /** 单 Section 方块数 = 16^3 = 4096 */
  SECTION_VOLUME: 4096,
  /** Section 索引范围: section_y = floor(worldY / 16), 世界 Y ∈ [-64, 384) */
  MIN_SECTION_Y: -4,
  MAX_SECTION_Y: 19,
  /** 世界 Y 范围 (含虚空上下限) */
  MIN_Y: -64,
  MAX_Y: 320,
};

/** 维度注册表 (ID 对齐原版维度编号) */
export const DIMENSIONS = {
  OVERWORLD: { id: 0, name: 'minecraft:overworld', minY: -64, maxY: 320, sections: 24 },
  NETHER: { id: -1, name: 'minecraft:the_nether', minY: 0, maxY: 256, sections: 16 },
  END: { id: 1, name: 'minecraft:the_end', minY: 0, maxY: 256, sections: 16 },
};

/**
 * 方块命名空间名 (v2 全协议支持的存储主键)
 * ----------------------------------------------------------------
 * v2 起线上协议/存储层以"名字符串"为准, 数字 stateId 仅剩参考价值
 * (不同 MC 版本同一方块的数字 ID 不同, 名字跨版本稳定)。
 * @readonly
 * @enum {string}
 */
export const BLOCK_NAMES = {
  AIR: 'minecraft:air',
  STONE: 'minecraft:stone',
  GRASS_BLOCK: 'minecraft:grass_block',
  DIRT: 'minecraft:dirt',
  BEDROCK: 'minecraft:bedrock',
  COBBLESTONE: 'minecraft:cobblestone',
  OAK_PLANKS: 'minecraft:oak_planks',
};

/**
 * 高频方块状态 ID 参考 (1.20.4)
 * ⚠️ 仅覆盖骨架开发/调试所需; 完整映射 Phase 2 用脚本生成
 * ⚠️ v2 已废弃数字 ID 传输, 此表仅保留给 Phase 3 原版协议翻译层用
 * @readonly
 * @enum {number}
 */
export const BLOCKS = {
  AIR: 0,
  STONE: 1,
  GRANITE: 2,
  DIORITE: 4,
  ANDESITE: 6,
  GRASS_BLOCK: 8,
  DIRT: 9,
  COBBLESTONE: 14,
  OAK_PLANKS: 15,
  BEDROCK: 33,
  WATER: 65, // level=0
  LAVA: 84, // level=0
  SAND: 254,
  GRAVEL: 289,
  GOLD_ORE: 291,
  IRON_ORE: 305,
  COAL_ORE: 334,
  OAK_LOG: 373, // axis=y
  OAK_LEAVES: 594, // distance=1, persistent=false 等 (状态ID随属性不同而不同!)
  GLASS: 4132,
  DIAMOND_ORE: 3282,
  // ⚠️ 以上数值以 wiki.vg Block States (1.20.4) 为准, 调试时请抽查校验
};

/**
 * 实体类型注册表
 * ----------------------------------------------------------------
 * 设计说明: 原版协议实体类型有独立数字 ID 空间; Phase 1/2 我们只用
 * player + 少量生物, 数字 ID 暂按 wiki.vg entity_type 顺序的近似值登记,
 * TODO(Phase 4 怪物AI前): 用脚本对齐精确 ID, 当前仅名称有契约效力。
 * @readonly
 */
export const ENTITY_TYPES = {
  PLAYER: { name: 'minecraft:player', id: -1 }, // 玩家不占原版 entity_type 表, 用 -1 特殊标记
  ITEM: { name: 'minecraft:item', id: 41, todo: 'id待校验' },
  ZOMBIE: { name: 'minecraft:zombie', id: 117, todo: 'id待校验' },
  SKELETON: { name: 'minecraft:skeleton', id: 112, todo: 'id待校验' },
  CREEPER: { name: 'minecraft:creeper', id: 99, todo: 'id待校验' },
  PIG: { name: 'minecraft:pig', id: 91, todo: 'id待校验' },
  ARROW: { name: 'minecraft:arrow', id: 2, todo: 'id待校验' },
};

/** 游戏模式 (对齐原版 GamemodeCommand 编号) */
export const GAMEMODES = { SURVIVAL: 0, CREATIVE: 1, ADVENTURE: 2, SPECTATOR: 3 };

/** 认证模式 (Auth Worker 子提示词 2 使用; 与 wrangler.toml DEFAULT_AUTH_MODE 对应) */
export const AUTH_MODES = {
  ONLINE: 'online', // 强制正版: sessionserver.mojang.com hasJoined 校验
  OFFLINE: 'offline', // 离线: UUID = nameUUIDFromBytes("OfflinePlayer:"+name)
  SKIN_SERVER: 'skin_server', // 自定义 Yggdrasil 皮肤站 (ely.by / littleskin / 自建)
  HYBRID: 'hybrid', // 有正版Token走正版, 否则降级离线+皮肤站
};

/** 标准化错误码 (Auth/协议层共用, 客户端按 code 分支处理) */
export const ERROR_CODES = {
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH', // 握手协议版本不一致
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  AUTH_MODE_UNSUPPORTED: 'AUTH_MODE_UNSUPPORTED',
  REGION_FULL: 'REGION_FULL', // 超过 MAX_PLAYERS_PER_REGION
  RATE_LIMITED: 'RATE_LIMITED',
  BANNED: 'BANNED', // Phase 3: 封禁拦截 (game.js 路由前检查)
  MAINTENANCE: 'MAINTENANCE', // Phase 3: 维护模式
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

/* ==========================================================================
 * Phase 3/4 常量
 * ======================================================================== */

/** 反作弊/重连/实体/经济参数 ([vars] 可覆盖, 见 resolveConfig) */
export const PHASE_DEFAULTS = {
  /** 断线重连宽限 (ms): 期内同 uuid 重连恢复原状态 */
  RECONNECT_GRACE_MS: 60_000,
  /** 单区域实体上限 (怪物 AI) */
  MAX_ENTITIES_PER_REGION: 12,
  /** 聊天速率限制: 窗口内条数 / 窗口 ms */
  CHAT_RATE_LIMIT: 5,
  CHAT_RATE_WINDOW_MS: 5_000,
  /** 聊天历史滚动保留条数 (ChatDO 内存 ring + D1) */
  CHAT_HISTORY_SIZE: 100,
  /** 监控告警 webhook 节流 (同级别消息最小间隔 ms) */
  ALERT_THROTTLE_MS: 60_000,
};

/**
 * 将 wrangler.toml [vars] (字符串) 合并进默认配置
 * ----------------------------------------------------------------
 * 为什么集中处理: [vars] 里全是字符串, 每处使用点都 parseInt 既啰嗦又易错;
 * 统一在这里做 类型转换 + 越界钳制 (clamp), 下游拿到的永远是安全数字。
 * @param {Env} env
 */
export function resolveConfig(env = {}) {
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const int = (raw, fallback) => {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    environment: env.ENVIRONMENT ?? 'development',
    authMode: env.DEFAULT_AUTH_MODE ?? AUTH_MODES.HYBRID,
    skinServerUrl: env.DEFAULT_SKIN_SERVER ?? 'https://ely.by',
    tickRateMs: clamp(int(env.TICK_RATE_MS, DEFAULTS.TICK_RATE_MS), 10, 200), // 5~100 TPS 允许范围
    persistIntervalMs: clamp(int(env.PERSIST_INTERVAL_MS, DEFAULTS.PERSIST_INTERVAL_TICKS * DEFAULTS.TICK_RATE_MS), 1000, 60_000),
    viewDistance: clamp(int(env.VIEW_DISTANCE, DEFAULTS.VIEW_DISTANCE), 2, 16), // 原版上限 32, 服务端按16封顶省内存
    maxPlayersPerRegion: clamp(int(env.MAX_PLAYERS_PER_REGION, DEFAULTS.MAX_PLAYERS_PER_REGION), 1, 100),
    compressionThreshold: clamp(int(env.COMPRESSION_THRESHOLD, DEFAULTS.COMPRESSION_THRESHOLD), 0, 4096),

    // ---- Phase 3/4 ----
    reconnectGraceMs: clamp(int(env.RECONNECT_GRACE_MS, PHASE_DEFAULTS.RECONNECT_GRACE_MS), 0, 600_000),
    maxEntitiesPerRegion: clamp(int(env.MAX_ENTITIES_PER_REGION, PHASE_DEFAULTS.MAX_ENTITIES_PER_REGION), 0, 64),
    chatRateLimit: clamp(int(env.CHAT_RATE_LIMIT, PHASE_DEFAULTS.CHAT_RATE_LIMIT), 1, 60),
    chatRateWindowMs: clamp(int(env.CHAT_RATE_WINDOW_MS, PHASE_DEFAULTS.CHAT_RATE_WINDOW_MS), 1000, 60_000),
    chatHistorySize: clamp(int(env.CHAT_HISTORY_SIZE, PHASE_DEFAULTS.CHAT_HISTORY_SIZE), 10, 1000),
    alertWebhookUrl: env.ALERT_WEBHOOK_URL ?? '', // 监控告警 (Secret 推荐而非 vars)
    alertThrottleMs: PHASE_DEFAULTS.ALERT_THROTTLE_MS,
    regionChatHistorySize: PHASE_DEFAULTS.CHAT_HISTORY_SIZE,
  };
}
