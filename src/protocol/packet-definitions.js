/**
 * ============================================================================
 * 协议包定义 — CFMC 自定义二进制协议 (Phase 1 最小集)
 * ============================================================================
 *
 * ⚠️ 本文件是客户端 Mod (Java) 与服务端 (JS) 的"契约", 两端必须逐字一致!
 *    cfmc-client 对应文件: protocol/CFMCPacketRegistry.java
 *    任何变更必须同步两端并递增 PROTOCOL_VERSION (要求 #10)。
 *
 * 帧格式 (Frame Format):
 * ┌──────────────┬──────────────┬──────────┬──────────────┐
 * │ Length       │ PacketID     │ Flags    │ Payload      │
 * │ VarInt       │ VarInt       │ Byte     │ Byte[]       │
 * │ (不含自身)    │              │          │              │
 * └──────────────┴──────────────┴──────────┴──────────────┘
 *
 * 与原版 Minecraft 协议的差异:
 *   1. 原版走 TCP + 状态机 (Handshake/Status/Login/Play); 本协议走 WebSocket
 *      消息帧, 连接建立即等价于"已进入 Play 状态", 无状态迁移
 *   2. 原版压缩由 zlib 前置长度域控制; 本协议用 1 字节 Flags 位域标记,
 *      支持按包决策压缩 (小包不压, 省 CPU)
 *   3. 包 ID 空间与 wiki.vg 完全不同 —— 这是私有协议, 仅服务于本项目
 *
 * 编号规则:
 *   0x01–0x0F  Clientbound  (S→C 服务端下发)
 *   0x10–0x1F  Serverbound  (C→S 客户端上报)
 *   预留 0x20+  供 Phase 4 扩展 (背包容器/实体元数据/粒子效果...)
 *
 * 待改进 (TODO):
 *   - [ ] packet-reader.js / packet-writer.js (VarInt 编解码, 子提示词后续)
 *   - [ ] compression.js (LZ4/Zstd, Phase 2)
 *   - [ ] 各包 Payload 的逐字段编解码器 (先从 P0 包开始)
 * ============================================================================
 */

/** 协议版本 —— 不兼容变更时 +1, 握手阶段两端协商
 *
 * v1 → v2 (2025-09 全协议支持改造):
 *   1. ClientHandshake (0x10) 尾部追加 mcVersion(String) + mcProtocol(VarInt)
 *   2. HandshakeAck (0x01) 尾部追加 adapter(String) + mcProtoMin/max(VarInt)
 *   3. BlockPlace (0x15) stateId(VarInt) → blockName(String) —— 版本中立!
 *   4. ChunkData (0x03) 调色板 numeric ID → 名字符串
 *   5. BlockUpdate (0x04) stateId(VarInt) → blockName(String)
 *   兼容策略: 新字段一律尾部追加, 旧端读到旧字段长度即停 → 旧客户端连新服务端
 *   仅缺新能力不会崩 (要求 #10 向前兼容)。
 */
export const PROTOCOL_VERSION = 2;

/** 单包大小硬上限 (1 MiB)。原版为 2 MiB (2^21);
 *  本项目区块走调色板压缩, 实测单 Section < 8KB, 1MiB 已非常宽裕 */
export const MAX_PACKET_SIZE = 1 << 20;

/** 超过此大小的 Payload 才启用压缩 (字节)。小包压缩得不偿失:
 *  Zstd 压缩耗时 (~50µs) > WS 传输 256 字节的增量耗时 */
export const COMPRESSION_THRESHOLD = 256;

/**
 * Flags 位域 (1 字节)
 * @readonly
 * @enum {number}
 */
export const PACKET_FLAGS = {
  /** 0x01 — Payload 已压缩 (LZ4/Zstd, Phase 2 启用) */
  COMPRESSED: 0x01,
  /** 0x02 — Payload 已加密 (Phase 2: AES-GCM, 会话密钥握手时协商) */
  ENCRYPTED: 0x02,
  /** 0x04 — 高优先级: 允许插队发送 (如 Disconnect/KeepAlive) */
  HIGH_PRIORITY: 0x04,
  // Bit 3-7: 保留, 客户端必须忽略未知位 (向前兼容)
};

/**
 * Clientbound 包 (S→C)
 * ----------------------------------------------------------------
 * priority: P0=加入游戏必需 / P1=核心玩法 / P2=锦上添花
 * 实现顺序严格按优先级 (cfmc.md 包注册表)。
 *
 * @readonly
 * @enum {{ id: number, name: string, priority: 'P0'|'P1'|'P2', desc: string }}
 */
export const CLIENTBOUND = {
  HANDSHAKE_ACK: { id: 0x01, name: 'HandshakeAck', priority: 'P0', desc: '握手确认 + 协商参数 (协议版本/视距/适配器/MC协议范围) — v2 尾部追加 adapter+mcProto 范围' },
  JOIN_GAME: { id: 0x02, name: 'JoinGame', priority: 'P0', desc: '加入游戏: 实体ID/游戏模式/维度/出生点' },
  CHUNK_DATA: { id: 0x03, name: 'ChunkData', priority: 'P0', desc: '区块数据 (完整/增量), 调色板(名字符串)+LongArray 编码 — v2: 方块名版本中立' },
  BLOCK_UPDATE: { id: 0x04, name: 'BlockUpdate', priority: 'P1', desc: '单方块变化通知 — v2: blockName(String) 替代 stateId' },
  ENTITY_SPAWN: { id: 0x05, name: 'EntitySpawn', priority: 'P1', desc: '实体生成 (含玩家以外实体)' },
  ENTITY_MOVE: { id: 0x06, name: 'EntityMove', priority: 'P0', desc: '实体位置/朝向更新 (可批量多个实体, 差量编码)' },
  ENTITY_DESTROY: { id: 0x07, name: 'EntityDestroy', priority: 'P2', desc: '实体销毁' },
  PLAYER_INFO: { id: 0x08, name: 'PlayerInfo', priority: 'P1', desc: '玩家列表增删改 (加入/离开/Ping)' },
  CHAT_MESSAGE: { id: 0x09, name: 'ChatMessage', priority: 'P2', desc: '聊天消息 (JSON 文本组件)' },
  DISCONNECT: { id: 0x0A, name: 'Disconnect', priority: 'P0', desc: '断开连接 (带原因码)' },
  KEEP_ALIVE: { id: 0x0B, name: 'KeepAlive', priority: 'P0', desc: '心跳 (服务端探测客户端存活)' },
  WORLD_TIME: { id: 0x0C, name: 'WorldTime', priority: 'P2', desc: '世界时间/天气' },
  UPDATE_HEALTH: { id: 0x0D, name: 'UpdateHealth', priority: 'P2', desc: '血量/饥饿/饱和度' },
  SET_SLOT: { id: 0x0E, name: 'SetSlot', priority: 'P2', desc: '单槽位物品更新' },
  WINDOW_ITEMS: { id: 0x0F, name: 'WindowItems', priority: 'P2', desc: '整个容器物品列表' },
  // ---- 0x20+ Phase 3/4 扩展 (增量包: 旧客户端忽略未知 ID, 向前兼容) ----
  PLAYER_POSITION: { id: 0x21, name: 'PlayerPosition', priority: 'P1', desc: '服务端权威位置下发 (TP/反作弊回拉/重生): x,y,z(D) yaw,pitch(F)' },
};

/**
 * Serverbound 包 (C→S)
 * ----------------------------------------------------------------
 * freq 标注发送频率 —— 用于服务端反作弊基线:
 *   POSITION 类包频率异常 (>25/s) 即为飞行/加速外挂嫌疑
 *
 * @readonly
 * @enum {{ id: number, name: string, freq: string, desc: string }}
 */
export const SERVERBOUND = {
  CLIENT_HANDSHAKE: { id: 0x10, name: 'ClientHandshake', freq: '连接时一次', desc: '握手请求: 协议版本/玩家名 — v2 尾部追加 mcVersion(String)+mcProtocol(VarInt) 供全协议协商' },
  PLAYER_POSITION: { id: 0x11, name: 'PlayerPosition', freq: '每tick', desc: '位置更新 (X,Y,Z,OnGround)' },
  PLAYER_LOOK: { id: 0x12, name: 'PlayerLook', freq: '每tick', desc: '视角旋转 (Yaw,Pitch)' },
  PLAYER_POSITION_LOOK: { id: 0x13, name: 'PlayerPositionLook', freq: '每tick(推荐)', desc: '位置+视角合并包 (带相对/绝对标志位, 省带宽)' },
  PLAYER_DIGGING: { id: 0x14, name: 'PlayerDigging', freq: '操作时', desc: '挖掘 (开始/取消/完成三态)' },
  BLOCK_PLACE: { id: 0x15, name: 'BlockPlace', freq: '操作时', desc: '放置方块 — v2: blockName(String) 替代 stateId, 各版本客户端各自解析' },
  HELD_ITEM_CHANGE: { id: 0x16, name: 'HeldItemChange', freq: '操作时', desc: '切换快捷栏槽位' },
  CHAT_MESSAGE: { id: 0x17, name: 'ChatMessage', freq: '操作时', desc: '发送聊天/命令' },
  KEEP_ALIVE: { id: 0x18, name: 'KeepAlive', freq: '每10秒', desc: '心跳应答' },
  CLIENT_STATUS: { id: 0x19, name: 'ClientStatus', freq: '特定时机', desc: '客户端状态 (重生/统计请求)' },
  CONTAINER_CLOSE: { id: 0x1A, name: 'ContainerClose', freq: '操作时', desc: '关闭容器' },
  CONTAINER_CLICK: { id: 0x1B, name: 'ContainerClick', freq: '操作时', desc: '点击容器槽位' },
  CREATIVE_INV_ACTION: { id: 0x1C, name: 'CreativeInvAction', freq: '创造模式', desc: '创造模式物品操作' },
  UPDATE_SIGN: { id: 0x1D, name: 'UpdateSign', freq: '操作时', desc: '编辑告示牌' },
  ANIMATION: { id: 0x1E, name: 'Animation', freq: '操作时', desc: '手部动画 (挥臂/伤害)' },
  TELEPORT_CONFIRM: { id: 0x1F, name: 'TeleportConfirm', freq: 'TP后', desc: '确认传送 (抗作弊: 服务端TP必须等确认)' },
  // ---- 0x20+ Phase 4 扩展 (增量包: 旧客户端不发, 服务端按"未知包"静默容忍) ----
  INTERACT_ENTITY: { id: 0x20, name: 'InteractEntity', freq: '攻击/交互时', desc: '实体交互: type(U8: 0=攻击 1=交互) entityId(I32) — 怪物AI战斗闭环' },
};

/** PlayerPositionLook (0x13) 的 flags 位掩码 —— 相对坐标优化 */
export const POSITION_FLAGS = {
  X_RELATIVE: 0x01,
  Y_RELATIVE: 0x02,
  Z_RELATIVE: 0x04,
  YAW_RELATIVE: 0x08,
  PITCH_RELATIVE: 0x10,
  // 0x1F = 全差量: 玩家每帧移动仅传 delta, 节省约 60% 带宽
};

/** 帧内 Payload 之上的通用包结构 (JSDoc 接口定义, 供两端对齐)
 * @typedef {Object} Packet
 * @property {number} id       包 ID (见 CLIENTBOUND/SERVERBOUND)
 * @property {number} flags    PACKET_FLAGS 位域
 * @property {Uint8Array} payload 业务数据 (可能已压缩)
 */

/* ------------------------- 工具函数 ------------------------- */

/** 由数字 ID 反查包定义 (S→C 与 C→S 合并查询) */
export function getPacketDef(id) {
  for (const def of Object.values(CLIENTBOUND)) if (def.id === id) return { ...def, direction: 'S→C' };
  for (const def of Object.values(SERVERBOUND)) if (def.id === id) return { ...def, direction: 'C→S' };
  return null;
}

/** 判断 ID 是否为已注册的合法包 (防畸形包注入的第一道闸) */
export function isKnownPacket(id) {
  return getPacketDef(id) !== null;
}
