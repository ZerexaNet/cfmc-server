/**
 * ============================================================================
 * RegionDO — 区域游戏引擎 v0.1 (整个项目的核心! 子提示词 3)
 * ============================================================================
 *
 * ⚠️ 一个 RegionDO = 世界中一个 16×16 区块柱 (X,Z 固定, Y 全高)
 *    实例名 `region:{x},{z}` (见 game.js 的 idFromName)
 *
 * 本版实现 (v0.1):
 *   ✅ WebSocket Hibernation 管理 (连接池/心跳30s超时/优雅断开)
 *   ✅ Alarm 驱动的 20 TPS Tick 循环 (CPU 预算 40ms 熔断, 错误不终止循环)
 *   ✅ 内存优先数据结构: chunkCache(LRU 256) / players / inputQueue / dirtyChunks
 *   ✅ Cesium 格式区块: LRU未命中→D1加载→不存在→超平坦生成
 *   ✅ 方块读写 (调色板管理) + 挖掘/放置 + BlockUpdate 广播
 *   ✅ 每 100 tick 批量持久化 (D1.batch 单事务) + 变更日志
 *   ✅ 二进制协议: 帧解析/包分派/差量广播 (文本JSON兼容通道保留给浏览器调试)
 *
 * 与原版 Minecraft 的差异 (v0.1 范围):
 *   - 移动: 服务端信任客户端位置 (仅做速度上限校验), 完整物理 Phase 2
 *   - 挖掘: 即挖即碎 (无挖掘时间/工具校验), Phase 3 补
 *   - 实体: 框架就位但无生成器 (怪物 AI Phase 4)
 *   - 光照: 字段结构预留, 不计算 (客户端本地估算)
 *
 * 待改进 (TODO):
 *   - [ ] 相对坐标 PlayerPositionLook (flags 位掩码) 的差量应用
 *   - [ ] 客户端预测的服务端校正 (rejection + TeleportConfirm)
 *   - [ ] 跨 Region 实体越境 (WorldManagerDO 协调)
 *   - [ ] ChunkData 压缩传输 (compression.js 已就绪, 等客户端对接)
 * ============================================================================
 */

import { CLIENTBOUND, SERVERBOUND, PACKET_FLAGS, PROTOCOL_VERSION } from '../protocol/packet-definitions.js';
import { PacketReader, PacketWriter } from '../protocol/packet-writer.js';
import { decompress } from '../protocol/compression.js';
import { loadChunk, decodeBlockIndices } from '../storage/cesium-reader.js';
import {
  prepareSectionUpsert,
  prepareChunkCleanMark,
  prepareBlockChangeLogInsert,
  savePlayerState,
  encodeBlockIndices,
} from '../storage/cesium-writer.js';
import { resolveConfig, CHUNK, BLOCKS, ERROR_CODES } from '../utils/constants.js';
import { worldToSectionIndex, clamp, Vec3 } from '../utils/math3d.js';
import { logger } from '../utils/logger.js';

/** 每tick最大移动距离 (方块) — 超过视为作弊丢弃 (20TPS × 10m ≈ 200m/s) */
const MAX_MOVE_PER_TICK = 10;

/* ==========================================================================
 * LRU 缓存 (cfmc.md: 最近 256 区块; 命中避免 D1 读, 这是配额的生死线)
 * ======================================================================== */
class LRUCache {
  /**
   * @param {number} maxSize
   * @param {(key: string, value: object) => void} onEvict 驱逐回调 (脏区块回写标记用)
   */
  constructor(maxSize = 256, onEvict = () => {}) {
    this.maxSize = maxSize;
    this.onEvict = onEvict;
    /** @type {Map<string, object>} Map 保持插入序 = 访问序 */
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key); // 重插到尾部 = 标记为"最近使用"
    this.map.set(key, v);
    return v;
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    // 超容量: 驱逐最老条目 (Map 首元素), 回调宿主标记脏区块防静默丢失
    if (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next().value;
      const evicted = this.map.get(oldest);
      this.map.delete(oldest);
      this.onEvict(oldest, evicted);
    }
  }
}

/* ==========================================================================
 * RegionDO 主体
 * ======================================================================== */
export class RegionDO {
  /** @param {DurableObjectState} state @param {Env} env */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.config = resolveConfig(env);
    this.region = this.#parseRegionFromName();

    /** 在线玩家: uuid → session { name, pos:Vec3, yaw, pitch, onGround, lastKeepAlive, moved, joinedAt } */
    this.players = new Map();

    /** 需要持久化的区块坐标 Set<"cx,cz"> (先于缓存初始化, 供驱逐回调使用) */
    this.dirtyChunks = new Set();

    /** 区块缓存 (LRU)。驱逐时把脏区块记回 dirtyChunks */
    this.chunkCache = new LRUCache(this.config.chunkCacheSize, (key, evicted) => {
      if (evicted?.isDirty) this.dirtyChunks.add(key); // 脏区块不许静默丢弃!
    });

    /** 实体表: entityId → { type, pos:Vec3, velocity, health } — v0.1 框架, 生成器 TODO */
    this.entityMap = new Map();
    this.nextEntityId = 1;

    /** 玩家操作缓冲 (Tick 内统一处理, 避免消息风暴下逐条处理) */
    this.inputQueue = [];

    /** 待写变更日志 (随 persistDirty 一起 flush) */
    this.pendingLogEntries = [];

    this.tickCount = 0;
    this.gameLoopRunning = false;
  }

  /* ==========================================================================
   * HTTP 面
   * ======================================================================== */

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/connect' && request.headers.get('Upgrade') === 'websocket') {
      return this.#handleConnect(url);
    }

    if (url.pathname === '/status') {
      return Response.json({
        ok: true,
        role: 'RegionDO',
        version: 'v0.1',
        region: this.region,
        players: [...this.players.values()].map((p) => ({ name: p.name, pos: { ...p.pos } })),
        entityCount: this.entityMap.size,
        dirtyChunks: this.dirtyChunks.size,
        cachedChunks: this.chunkCache.map.size,
        tickCount: this.tickCount,
        gameLoopRunning: this.gameLoopRunning,
      });
    }

    return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
  }

  /* ==========================================================================
   * 玩家连接 / 断开 (Hibernation API)
   * ======================================================================== */

  #handleConnect(url) {
    const uuid = url.searchParams.get('uuid') ?? crypto.randomUUID();
    const name = url.searchParams.get('name') ?? 'Guest';

    // 容量闸门: 单区域人数上限 (默认 25, [vars] 可调)
    if (this.players.size >= this.config.maxPlayersPerRegion && !this.players.has(uuid)) {
      return new Response(
        JSON.stringify({ ok: false, code: ERROR_CODES.REGION_FULL, message: '该区域人数已满' }),
        { status: 403 }
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // tag[0] = uuid: 唤醒后可 getWebSockets(uuid) 反查
    this.state.acceptWebSocket(server, [uuid]);

    const spawn = new Vec3(0.5, -60, 0.5); // 出生点 (world_meta TODO)
    this.players.set(uuid, {
      name,
      pos: spawn.clone(),
      yaw: 0,
      pitch: 0,
      onGround: true,
      lastKeepAlive: Date.now(),
      moved: false,
      joinedAt: Date.now(),
    });

    /* ---- 握手: HandshakeAck + JoinGame (二进制协议首批包) ---- */
    // HandshakeAck: protocolVersion(VarInt) | regionX(I32) | regionZ(I32) | viewDistance(U8)
    const ack = new PacketWriter(16);
    ack.writeVarInt(PROTOCOL_VERSION);
    ack.writeInt32(this.region.x);
    ack.writeInt32(this.region.z);
    ack.writeUInt8(this.config.viewDistance);
    this.#sendTo(uuid, CLIENTBOUND.HANDSHAKE_ACK.id, ack.toUint8Array());

    // JoinGame: entityId(I32=0) | gamemode(U8=0) | dimension(I32=0) | spawnX/Y/Z(Double)
    const join = new PacketWriter(40);
    join.writeInt32(0);
    join.writeUInt8(0); // survival
    join.writeInt32(0); // overworld
    join.writeDouble(spawn.x);
    join.writeDouble(spawn.y);
    join.writeDouble(spawn.z);
    this.#sendTo(uuid, CLIENTBOUND.JOIN_GAME.id, join.toUint8Array());

    // 玩家列表广播: 我加入 (其他人); 欢迎语 (我)
    this.#broadcastFrameExcept(uuid, this.#playerInfoPacket('join', uuid, name));
    const chat = new PacketWriter(64);
    chat.writeString(`§e${name} 加入了 ${this.region.x},${this.region.z} 区域`);
    this.#broadcast(CLIENTBOUND.CHAT_MESSAGE.id, chat.toUint8Array());

    // TODO: 给新玩家发送视野内区块 (buildChunkDataPacket × 视距环)
    this.#sendInitialChunk(uuid).catch((e) => logger.error('chunk_send_fail', { error: e.message }));

    // 第一个玩家进入 → 启动游戏循环
    if (this.players.size === 1 && !this.gameLoopRunning) {
      this.#startGameLoop();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** 首区块下发 (v0.1: 只发玩家所在 1 个区块作链路验证; 视距环 Phase 2) */
  async #sendInitialChunk(uuid) {
    const chunk = await this.#getOrLoadChunk(0, 0);
    if (!chunk) return;
    this.#sendTo(uuid, CLIENTBOUND.CHUNK_DATA.id, this.#buildChunkDataPayload(chunk));
  }

  /* ==========================================================================
   * 消息接收与分派
   * ======================================================================== */

  /**
   * Hibernation 回调: 有消息才唤醒本 DO (空闲休眠零费用)
   * 支持两种通道:
   *   - 二进制帧 (Mod 走这里): Length|PacketID|Flags|Payload
   *   - 文本 JSON (浏览器调试走这里): {type:"chat",...} 兼容 Phase 1
   */
  async webSocketMessage(ws, message) {
    const uuid = this.#uuidOf(ws);
    if (!this.players.has(uuid)) return; // 未完成握手的连接忽略

    try {
      if (typeof message === 'string') {
        this.#handleTextMessage(uuid, message);
        return;
      }

      /* ---- 帧循环: 一条 WS 消息可含多个连续帧 ---- */
      const reader = new PacketReader(message);
      let guard = 0; // 防御: 单消息最多 256 帧
      while (reader.remaining > 0 && guard++ < 256) {
        const length = reader.readVarInt();
        if (length <= 0 || length > 1 << 20) throw new Error(`非法帧长度: ${length}`);
        if (reader.remaining < length) throw new Error('帧不完整');

        const frame = reader.readBytes(length);
        const frameReader = new PacketReader(frame);
        const packetId = frameReader.readVarInt();
        const flags = frameReader.readUInt8();
        let payload = frameReader.readRemaining();

        if (flags & PACKET_FLAGS.COMPRESSED) {
          payload = await decompress(payload); // TODO(Phase2): Zstd 协商
        }

        this.#dispatchPacket(uuid, packetId, new PacketReader(payload));
      }
    } catch (err) {
      // 坏包只踢坏的, 不断连接 (cfmc.md 要求 #8); 连续坏包封禁 Phase 3
      logger.warn('bad_packet', { uuid, error: err.message });
      const errPkt = new PacketWriter(64);
      errPkt.writeString(` malformed packet: ${err.message}`);
      this.#sendTo(uuid, CLIENTBOUND.CHAT_MESSAGE.id, errPkt.toUint8Array());
    }
  }

  /** 文本 JSON 通道 (Phase 1 浏览器联调兼容) */
  #handleTextMessage(uuid, text) {
    try {
      const data = JSON.parse(text);
      if (data.type === 'chat' && data.msg) {
        const p = this.players.get(uuid);
        const w = new PacketWriter(128);
        w.writeString(`<${p.name}> ${String(data.msg).slice(0, 256)}`);
        this.#broadcast(CLIENTBOUND.CHAT_MESSAGE.id, w.toUint8Array());
      } else {
        wsSafeSend(this.#wsOf(uuid), JSON.stringify({ type: 'echo', received: data }));
      }
    } catch { /* 非 JSON 文本忽略 */ }
  }

  /** 按包 ID 分派 (未注册的包丢弃并计数) */
  #dispatchPacket(uuid, packetId, r) {
    switch (packetId) {
      /* ClientHandshake: protocolVersion(VarInt) — v0.1 连接时已由 game.js 验证身份,
       * 这里只校验协议版本一致性 */
      case SERVERBOUND.CLIENT_HANDSHAKE.id: {
        const clientVersion = r.readVarInt();
        if (clientVersion !== PROTOCOL_VERSION) {
          this.#kick(uuid, `协议版本不匹配 (服务端 ${PROTOCOL_VERSION} / 客户端 ${clientVersion})`);
        }
        break;
      }

      /* KeepAlive: 无 payload — 刷新心跳 */
      case SERVERBOUND.KEEP_ALIVE.id: {
        const session = this.players.get(uuid);
        if (session) session.lastKeepAlive = Date.now();
        break;
      }

      /* ChatMessage: message(String) */
      case SERVERBOUND.CHAT_MESSAGE.id: {
        const text = r.readString(256);
        const p = this.players.get(uuid);
        const w = new PacketWriter(128);
        w.writeString(`<${p.name}> ${text}`);
        this.#broadcast(CLIENTBOUND.CHAT_MESSAGE.id, w.toUint8Array());
        break;
      }

      /* PlayerPositionLook: x(D) feetY(D) z(D) yaw(F) pitch(F) onGround(Bool) flags(U8)
       * v0.1 只支持绝对坐标 (flags=0); 相对差量 TODO */
      case SERVERBOUND.PLAYER_POSITION_LOOK.id: {
        const x = r.readDouble();
        const y = r.readDouble();
        const z = r.readDouble();
        const yaw = r.readFloat();
        const pitch = r.readFloat();
        const onGround = r.readBoolean();
        r.readUInt8(); // flags (v0.1 忽略, TODO 相对坐标)
        this.inputQueue.push({ type: 'move', uuid, x, y, z, yaw, pitch, onGround });
        break;
      }

      /* PlayerDigging: status(U8: 0=开始 1=取消 2=完成) x(I32) y(I32) z(I32) */
      case SERVERBOUND.PLAYER_DIGGING.id: {
        const status = r.readUInt8();
        const x = r.readInt32();
        const y = r.readInt32();
        const z = r.readInt32();
        if (status === 2) this.inputQueue.push({ type: 'dig', uuid, x, y, z });
        break;
      }

      /* BlockPlace: x(I32) y(I32) z(I32) stateId(VarInt) */
      case SERVERBOUND.BLOCK_PLACE.id: {
        const x = r.readInt32();
        const y = r.readInt32();
        const z = r.readInt32();
        const stateId = r.readVarInt();
        this.inputQueue.push({ type: 'place', uuid, x, y, z, stateId });
        break;
      }

      default:
        // 未知包: 静默丢弃 (向前兼容 — 旧客户端收到新服务端不出错)
        logger.warn('unknown_packet', { uuid, packetId });
        break;
    }
  }

  /** 客户端断开 */
  async webSocketClose(ws) {
    const uuid = this.#uuidOf(ws);
    const session = this.players.get(uuid);
    this.players.delete(uuid);

    if (session) {
      this.#broadcast(this.#playerInfoPacket('leave', uuid, session.name));

      // TODO: persistPlayerState 立即保存该玩家
    }

    // 最后一个玩家离开 → 最终保存 → 不再调度 Alarm → DO 休眠 → 零费用!
    if (this.players.size === 0 && this.gameLoopRunning) {
      await this.persistDirty().catch((e) => logger.error('final_persist_fail', { error: e.message }));
      this.gameLoopRunning = false; // 不再 setAlarm → 平台自动休眠
      logger.info('region_sleep', { region: this.region });
    }
  }

  async webSocketError(ws, _err) {
    await this.webSocketClose(ws); // 视同断开
  }

  /* ==========================================================================
   * 游戏主循环 (Alarm 驱动 — cfmc.md 第4节)
   * ======================================================================== */

  #startGameLoop() {
    this.gameLoopRunning = true;
    // storage.setAlarm 在 Hibernation 模式下依然可用 (Alarm 唤醒休眠中的 DO)
    this.state.storage.setAlarm(Date.now() + this.config.tickRateMs);
    logger.info('region_start', { region: this.region });
  }

  /** Alarm 触发 = 执行一次 tick */
  async alarm() {
    if (this.players.size === 0) {
      this.gameLoopRunning = false;
      return; // 安全检查: 没人就不循环
    }

    const t0 = Date.now();

    try {
      await this.#gameTick();
      this.tickCount++;

      /* ---- 周期任务 ---- */
      if (this.tickCount % 100 === 0) {
        // 每 5 秒: 批量持久化脏区块 (内存优先策略的核心节流阀)
        await this.persistDirty();
      }
      if (this.tickCount % 200 === 0) {
        // 每 10 秒: 服务端心跳探测
        const ka = new PacketWriter(2);
        this.#broadcast(CLIENTBOUND.KEEP_ALIVE.id, ka.toUint8Array());
        this.#checkHeartbeats();
      }
      if (this.tickCount % 1200 === 0) {
        // 每 60 秒: 玩家状态落 users 库 (断线重连数据源)
        await this.#savePlayerStates();
      }
    } catch (err) {
      // 任何异常都不允许终止循环 (cfmc.md 要求 #8)
      logger.error('tick_error', { region: this.region, tick: this.tickCount, error: err.message });
    }

    // 调度下一 tick (补偿本 tick 耗时; 最小间隔 10ms 防止 CPU 打满)
    const elapsed = Date.now() - t0;
    if (elapsed > 40) {
      logger.warn('tick_overrun', { region: this.region, elapsedMs: elapsed });
    }
    if (this.players.size > 0) {
      this.state.storage.setAlarm(Date.now() + Math.max(10, this.config.tickRateMs - elapsed));
    } else {
      this.gameLoopRunning = false;
    }
  }

  /** 单次游戏 Tick */
  async #gameTick() {
    /* ---- 1. 消费输入队列 (移动/挖掘/放置) ---- */
    const qStart = Date.now();
    const inputs = this.inputQueue;
    this.inputQueue = [];
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (input.type === 'move') this.#handlePlayerMove(input);
      else if (input.type === 'dig') this.#handleDigging(input);
      else if (input.type === 'place') this.#handlePlacement(input);
      // CPU 预算熔断: 处理不完的回填队列留下 tick 再说 (宁可慢一帧不可卡死)
      if (Date.now() - qStart > 40 && i < inputs.length - 1) {
        this.inputQueue = inputs.slice(i + 1).concat(this.inputQueue);
        logger.warn('tick_budget_hit', { region: this.region, deferred: inputs.length - 1 - i });
        break;
      }
    }

    /* ---- 2. 实体 AI / 物理 (v0.1 空转, 结构占位) ----
     * for (const entity of this.entityMap.values()) {
     *   entity.ai?.tick?.(this);
     *   entity.physics?.tick?.(this);
     * } */

    /* ---- 3. 移动差量广播 (EntityMove 批量, 只发视野内玩家) ---- */
    const movers = [...this.players.values()].filter((p) => p.moved);
    if (movers.length > 0) {
      // EntityMove payload: count(VarInt) + count × { uuid(String) x(D) y(D) z(D) yaw(F) pitch(F) }
      const w = new PacketWriter(64 + movers.length * 48);
      w.writeVarInt(movers.length);
      for (const p of movers) {
        const uuid = this.#uuidOfSession(p);
        w.writeString(uuid);
        w.writeDouble(p.pos.x);
        w.writeDouble(p.pos.y);
        w.writeDouble(p.pos.z);
        w.writeFloat(p.yaw);
        w.writeFloat(p.pitch);
        p.moved = false;
      }
      this.#broadcast(CLIENTBOUND.ENTITY_MOVE.id, w.toUint8Array());
    }
  }

  /* ==========================================================================
   * 游戏逻辑: 移动 / 挖掘 / 放置 / 方块访问
   * ======================================================================== */

  /** 移动处理: 速度上限校验 + 记录 + 标记广播 (权威物理 Phase 2) */
  #handlePlayerMove(input) {
    const p = this.players.get(input.uuid);
    if (!p) return;

    // 反作弊基线: 单 tick 位移超限 → 丢弃 (Phase 3 换成回拉校正)
    const dx = input.x - p.pos.x, dy = input.y - p.pos.y, dz = input.z - p.pos.z;
    if (dx * dx + dy * dy + dz * dz > MAX_MOVE_PER_TICK * MAX_MOVE_PER_TICK) {
      logger.warn('move_rejected', { uuid: input.uuid });
      return;
    }

    // 世界边界: Y ∈ [CHUNK.MIN_Y, CHUNK.MAX_Y)
    p.pos.set(
      clamp(input.x, -3e7, 3e7),
      clamp(input.y, CHUNK.MIN_Y, CHUNK.MAX_Y),
      clamp(input.z, -3e7, 3e7)
    );
    p.yaw = input.yaw;
    p.pitch = input.pitch;
    p.onGround = input.onGround;
    p.moved = true;
  }

  /** 挖掘 (status=完成才处理; 即挖即碎) */
  async #handleDigging(input) {
    await this.setBlockState(input.x, input.y, input.z, BLOCKS.AIR, input.uuid);
  }

  /** 放置 (客户端上报 stateId; 物品栏校验 Phase 3) */
  async #handlePlacement(input) {
    // 基础防抖: 只接受注册表内的合法方块
    if (input.stateId < 0 || input.stateId > 30000) return;
    await this.setBlockState(input.x, input.y, input.z, input.stateId, input.uuid);
  }

  /**
   * 读方块状态 (缓存未命中返回 0=air; 完整异步加载走 #getOrLoadChunk)
   */
  getBlockState(wx, wy, wz) {
    const cx = wx >> 4, cz = wz >> 4;
    const chunk = this.chunkCache.get(`${cx},${cz}`);
    if (!chunk) return 0;

    const sectionY = Math.floor(wy / 16);
    const section = chunk.sections.get(sectionY);
    if (!section) return 0;

    const idx = worldToSectionIndex(wx, wy, wz);
    const entry = section.palette[section.indices[idx]];
    return entry ? entry.id : 0;
  }

  /**
   * 写方块状态: 改内存 + 标脏 + 广播 BlockUpdate + 记审计
   * (不立即写库! persistDirty 每 5 秒统一落盘)
   */
  async setBlockState(wx, wy, wz, newStateId, actorUuid = null) {
    if (wy < CHUNK.MIN_Y || wy >= CHUNK.MAX_Y) return 0;

    const cx = wx >> 4, cz = wz >> 4;
    const chunk = await this.#getOrLoadChunk(cx, cz); // 写路径必须确保加载
    const sectionY = Math.floor(wy / 16);
    const section = this.#ensureSection(chunk, sectionY);

    const idx = worldToSectionIndex(wx, wy, wz);
    const oldStateId = section.palette[section.indices[idx]]?.id ?? 0;
    if (oldStateId === newStateId) return oldStateId;

    /* ---- 调色板管理: 找到/新建目标方块的下标 ---- */
    let paletteIdx = section.palette.findIndex((e) => e.id === newStateId);
    if (paletteIdx === -1) {
      section.palette.push({ id: newStateId, name: `state:${newStateId}` }); // TODO: 名称映射表
      paletteIdx = section.palette.length - 1;
    }
    section.indices[idx] = paletteIdx;
    section.dirty = true;
    chunk.isDirty = true;

    const key = `${cx},${cz}`;
    this.dirtyChunks.add(key);

    // 审计日志 (随 persistDirty 批量写入)
    this.pendingLogEntries.push({
      actorUuid: actorUuid,
      actorType: actorUuid ? 'player' : 'system',
      x: wx, y: wy, z: wz,
      oldStateId, newStateId,
      tick: this.tickCount,
      at: Date.now(),
    });

    /* ---- BlockUpdate 广播: x(I32) y(I32) z(I32) stateId(VarInt) ---- */
    const w = new PacketWriter(20);
    w.writeInt32(wx);
    w.writeInt32(wy);
    w.writeInt32(wz);
    w.writeVarInt(newStateId);
    this.#broadcast(CLIENTBOUND.BLOCK_UPDATE.id, w.toUint8Array());

    return oldStateId;
  }

  /* ==========================================================================
   * 区块加载 / 生成 / 序列化
   * ======================================================================== */

  /** 获取或加载区块: 内存 → D1 → 超平坦生成 (三级降级) */
  async #getOrLoadChunk(cx, cz) {
    const key = `${cx},${cz}`;

    // 1. 内存缓存
    const cached = this.chunkCache.get(key);
    if (cached) return cached;

    // 2. D1 加载 (Cesium 格式)
    const loaded = await loadChunk(this.env.WORLD_DB, cx, cz).catch(() => null);
    const chunk = { cx, cz, sections: new Map(), tileEntities: [], isDirty: false };

    if (loaded?.found) {
      for (const s of loaded.sections) {
        chunk.sections.set(s.sectionY, {
          palette: s.palette,
          indices: decodeBlockIndices(s.compressedIndices, Math.max(s.palette.length, 1)),
          skyLight: s.skyLight,
          blockLight: s.blockLight,
          dirty: false,
        });
      }
      chunk.tileEntities = loaded.tileEntities;
    } else {
      // 3. 不存在 → 超平坦生成 (v0.1 固定地形; noise 生成器 Phase 2)
      this.#generateFlatTerrain(chunk);
      chunk.isDirty = true; // 生成即脏, 首次 persist 落库
      this.dirtyChunks.add(key);
    }

    this.chunkCache.set(key, chunk);
    return chunk;
  }

  /** 超平坦: 基岩(-64) + 泥土(-63..-61) + 草方块(-60) */
  #generateFlatTerrain(chunk) {
    const section = this.#ensureSection(chunk, -4);
    // 初始化调色板 (顺序即下标)
    section.palette = [
      { id: BLOCKS.AIR, name: 'minecraft:air' },
      { id: BLOCKS.BEDROCK, name: 'minecraft:bedrock' },
      { id: BLOCKS.DIRT, name: 'minecraft:dirt' },
      { id: BLOCKS.GRASS_BLOCK, name: 'minecraft:grass_block' },
    ];
    section.indices.fill(0); // 全空气

    const idxOf = (x, y, z) => ((y & 0xf) << 8) | ((z & 0xf) << 4) | (x & 0xf);
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        section.indices[idxOf(x, 0, z)] = 1; // y=-64 bedrock (sectionY=-4 → y=sectionY*16+local)
        section.indices[idxOf(x, 1, z)] = 2; // y=-63 dirt
        section.indices[idxOf(x, 2, z)] = 2; // y=-62 dirt
        section.indices[idxOf(x, 3, z)] = 3; // y=-61 dirt
        section.indices[idxOf(x, 4, z)] = 3; // y=-60 grass (出生高度)
      }
    }
    section.dirty = true;
  }

  /** 确保区块的某个 Section 存在 (惰性分配) */
  #ensureSection(chunk, sectionY) {
    let s = chunk.sections.get(sectionY);
    if (!s) {
      s = {
        palette: [{ id: BLOCKS.AIR, name: 'minecraft:air' }],
        indices: new Uint16Array(CHUNK.SECTION_VOLUME),
        skyLight: null,
        blockLight: null,
        dirty: false,
      };
      chunk.sections.set(sectionY, s);
    }
    return s;
  }

  /** ChunkData payload: chunkX(I32) chunkZ(I32) fullChunk(Bool) sectionCount(VarInt) + sections */
  #buildChunkDataPayload(chunk) {
    const w = new PacketWriter(512);
    w.writeInt32(chunk.cx);
    w.writeInt32(chunk.cz);
    w.writeBoolean(true);

    const packed = [...chunk.sections.entries()].filter(([, s]) => s.palette.length > 1 || s.indices.some((v) => v !== 0));
    w.writeVarInt(packed.length);

    for (const [sectionY, s] of packed) {
      // section: sectionY(VarInt) blockCount(U16) paletteLen(VarInt) palette[](VarInt)
      //          dataLen(VarInt) data[](未压缩 LongArray, TODO: 压缩协商)
      const nonAir = s.indices.reduce((n, pi) => (s.palette[pi]?.id !== 0 ? n + 1 : n), 0);
      w.writeVarInt(sectionY);
      w.writeUInt16(nonAir);
      w.writeVarInt(s.palette.length);
      for (const entry of s.palette) w.writeVarInt(entry.id);

      // 打包索引 (64bit LongArray, 与客户端 decodeBlockIndices 互逆)
      const raw = encodeBlockIndices(s.indices, s.palette.length);
      w.writeVarInt(raw.length);
      w.writeBytes(raw);
    }
    return w.toUint8Array();
  }

  /* ==========================================================================
   * 持久化 (Alarm 每 5 秒批量)
   * ======================================================================== */

  /**
   * 脏区块批量落库 — 单事务原子提交:
   * 要么全部保存, 要么全部不保存; 崩溃最多丢 5 秒数据 (Anvil 老毛病根治)
   */
  async persistDirty() {
    if (this.dirtyChunks.size === 0 && this.pendingLogEntries.length === 0) return;

    const batchOps = [];

    for (const key of this.dirtyChunks) {
      const chunk = this.chunkCache.get(key);
      if (!chunk) continue; // 已被 LRU 驱逐 (理论上驱逐前已处理)

      const [cx, cz] = key.split(',').map(Number);
      for (const [sectionY, section] of chunk.sections) {
        if (!section.dirty) continue;
        batchOps.push(
          await prepareSectionUpsert(
            this.env.WORLD_DB, cx, cz, sectionY,
            section.palette, section.indices,
            section.skyLight, section.blockLight
          )
        );
        section.dirty = false;
      }
      // 注意: 即使无脏 Section 也要清 chunks.dirty_count
      batchOps.push(prepareChunkCleanMark(this.env.WORLD_DB, cx, cz));
    }

    // 变更日志
    const logOp = prepareBlockChangeLogInsert(this.env.WORLD_DB, this.pendingLogEntries);
    if (logOp) batchOps.push(logOp);

    try {
      if (batchOps.length > 0) await this.env.WORLD_DB.batch(batchOps);
      this.dirtyChunks.clear();
      this.pendingLogEntries = [];
    } catch (err) {
      // 失败: 保留脏标记, 下个周期重试 (数据不丢, 只是晚 5 秒)
      logger.error('persist_fail', { region: this.region, error: err.message, retries: this.dirtyChunks.size });
      for (const key of this.dirtyChunks) {
        const chunk = this.chunkCache.get(key);
        if (chunk) for (const s of chunk.sections.values()) s.dirty = true;
      }
    }
  }

  /** 玩家状态 → users 库 (断线重连恢复用) */
  async #savePlayerStates() {
    for (const [uuid, p] of this.players) {
      await savePlayerState(this.env, {
        uuid: uuid.replace(/-/g, ''),
        name: p.name,
        world: 'overworld',
        x: p.pos.x, y: p.pos.y, z: p.pos.z,
        yaw: p.yaw, pitch: p.pitch,
        gamemode: 0, health: 20, food: 20,
      }).catch(() => {});
    }
  }

  /* ==========================================================================
   * 发送 / 心跳 / 工具
   * ======================================================================== */

  /** 发单包给指定玩家 (小包不压缩 — 压缩路径见 compression.js TODO) */
  #sendTo(uuid, packetId, payload) {
    const ws = this.#wsOf(uuid);
    if (ws) wsSafeSend(ws, PacketWriter.frame(packetId, 0, payload));
  }

  /** 广播 (批量合并帧; Hibernation 下 getWebSockets 不唤醒任何实例) */
  #broadcast(packetId, payload) {
    const frame = PacketWriter.frame(packetId, 0, payload);
    for (const ws of this.state.getWebSockets()) {
      wsSafeSend(ws, frame);
    }
  }

  /** 广播单帧 (已编码) 给除 uuid 外的所有玩家 */
  #broadcastFrameExcept(uuid, frame) {
    for (const ws of this.state.getWebSockets()) {
      if (this.#uuidOf(ws) === uuid) continue;
      wsSafeSend(ws, frame);
    }
  }

  /** PlayerInfo(0x08): action(U8: 0=join 1=leave) uuid(String) name(String) */
  #playerInfoPacket(action, uuid, name) {
    const w = new PacketWriter(64);
    w.writeUInt8(action === 'join' ? 0 : 1);
    w.writeString(uuid);
    w.writeString(name);
    return PacketWriter.frame(CLIENTBOUND.PLAYER_INFO.id, 0, w.toUint8Array());
  }

  /** 心跳超时检测 (30s 无 KeepAlive 判定死链) */
  #checkHeartbeats() {
    const now = Date.now();
    for (const [uuid, p] of this.players) {
      if (now - p.lastKeepAlive > 30_000) {
        const ws = this.#wsOf(uuid);
        this.#kick(uuid, '心跳超时');
        ws?.close(4000, 'heartbeat_timeout');
      }
    }
  }

  /** 踢人: Disconnect 包 → close */
  #kick(uuid, reason) {
    const w = new PacketWriter(128);
    w.writeString(reason);
    this.#sendTo(uuid, CLIENTBOUND.DISCONNECT.id, w.toUint8Array());
    this.#wsOf(uuid)?.close(1000, reason);
  }

  #wsOf(uuid) {
    const sockets = this.state.getWebSockets(uuid);
    return sockets.length > 0 ? sockets[0] : null;
  }

  /** 通过连接 tag 反查 uuid */
  #uuidOf(ws) {
    try {
      return ws.getTag?.(0) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** 由 session 对象反查 uuid (players Map 键即 uuid) */
  #uuidOfSession(session) {
    for (const [uuid, p] of this.players) {
      if (p === session) return uuid;
    }
    return 'unknown';
  }

  #parseRegionFromName() {
    const m = /region:(-?\d+),(-?\d+)/.exec(this.state.id.name ?? '');
    return m ? { x: parseInt(m[1], 10), z: parseInt(m[2], 10) } : { x: 0, z: 0 };
  }
}

/** WS 发送安全封装: 失效连接静默跳过 (不冒泡到 tick 循环) */
function wsSafeSend(ws, data) {
  try {
    if (ws) ws.send(data);
  } catch { /* 连接已死, webSocketClose 会清理 */ }
}
