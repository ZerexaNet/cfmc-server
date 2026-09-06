/**
 * ============================================================================
 * Cesium 格式写入器 — 脏区块批量持久化到 D1 (cfmc-world)
 * ============================================================================
 *
 * 调用方: RegionDO.persistDirty() — Alarm 每 5 秒触发一次 (每 100 tick)
 *
 * 关键设计: 本文件只"准备" D1 语句 (返回 prepared statement 数组),
 * 由 RegionDO 用 WORLD_DB.batch([]) 原子提交 —— 单事务, 要么全存要么全不存,
 * 崩溃时最多丢 5 秒数据, 绝不会出现"存了一半" (Anvil 的老毛病)。
 * ============================================================================
 */

import { compress } from '../protocol/compression.js';

/**
 * 编码调色板下标数组 → 64bit 大端 LongArray (decodeBlockIndices 的逆过程)
 * @param {Uint16Array} indices 调色板下标 (0..paletteSize-1)
 * @param {number} paletteSize
 * @returns {Uint8Array} 未压缩的打包字节
 */
export function encodeBlockIndices(indices, paletteSize) {
  if (paletteSize <= 1) {
    // 单调色板: 原版协议直接省略数据数组 (bitsPerEntry=0), 我们存空字节
    return new Uint8Array(0);
  }

  const bitsPerEntry = Math.ceil(Math.log2(paletteSize));
  const totalBits = indices.length * bitsPerEntry;
  const longCount = Math.ceil(totalBits / 64);
  const out = new Uint8Array(longCount * 8);
  const view = new DataView(out.buffer);

  let longIndex = 0;
  let bitOffset = 0;

  for (let i = 0; i < indices.length; i++) {
    let value = indices[i];
    // 从高位往低位写入 (与 decodeBlockIndices 的读取顺序对称)
    for (let b = bitsPerEntry - 1; b >= 0; b--) {
      if (bitOffset >= 64) {
        bitOffset = 0;
        longIndex++;
      }
      const bit = (value >>> b) & 1;
      const bytePos = longIndex * 8;
      if (bitOffset < 32) {
        const hi = view.getUint32(bytePos, false);
        view.setUint32(bytePos, hi | (bit << (31 - bitOffset)), false);
      } else {
        const lo = view.getUint32(bytePos + 4, false);
        view.setUint32(bytePos + 4, lo | (bit << (63 - bitOffset)), false);
      }
      bitOffset++;
    }
  }
  return out;
}

/** 简单字符串哈希 (调色板变更检测; 不需要密码学强度, 只要比对快) */
export function hashPalette(palette) {
  const s = JSON.stringify(palette);
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

/** 统计非空气方块数 (调色板 0 = air 的跳过) */
export function countNonAir(indices, palette) {
  let n = 0;
  for (let i = 0; i < indices.length; i++) {
    const block = palette[indices[i]];
    if (block && block.id !== 0) n++;
  }
  return n;
}

/**
 * 准备一条 Section UPSERT 语句 (palette + 压缩索引 → chunk_sections)
 *
 * @param {D1Database} db
 * @param {number} cx
 * @param {number} cz
 * @param {number} sectionY
 * @param {Array} palette [{id, name}, ...]
 * @param {Uint16Array} indices
 * @param {Uint8Array|null} skyLight 2048B (可null)
 * @param {Uint8Array|null} blockLight
 * @returns {Promise<D1PreparedStatement>}
 */
export async function prepareSectionUpsert(db, cx, cz, sectionY, palette, indices, skyLight, blockLight) {
  const packed = encodeBlockIndices(indices, palette.length);
  const compressed = packed.length > 0 ? await compress(packed) : packed; // 空数组跳过压缩

  return db
    .prepare(
      `INSERT INTO chunk_sections
         (chunk_x, chunk_z, section_y, palette_data, palette_hash,
          block_indices_compressed, sky_light, block_light, non_air_blocks, data_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(chunk_x, chunk_z, section_y) DO UPDATE SET
         palette_data = excluded.palette_data,
         palette_hash = excluded.palette_hash,
         block_indices_compressed = excluded.block_indices_compressed,
         sky_light = excluded.sky_light,
         block_light = excluded.block_light,
         non_air_blocks = excluded.non_air_blocks,
         data_version = data_version + 1`
    )
    .bind(
      cx, cz, sectionY,
      JSON.stringify(palette),
      hashPalette(palette),
      compressed,
      skyLight ?? null,
      blockLight ?? null,
      countNonAir(indices, palette)
    );
}

/**
 * 准备区块"已保存"标记更新 (清 dirty_count + 刷新时间戳)
 */
export function prepareChunkCleanMark(db, cx, cz) {
  return db
    .prepare(
      `INSERT INTO chunks (chunk_x, chunk_z, is_generated, dirty_count, created_at, last_modified)
       VALUES (?, ?, 1, 0, ?, ?)
       ON CONFLICT(chunk_x, chunk_z) DO UPDATE SET
         dirty_count = 0, last_modified = excluded.last_modified`
    )
    .bind(cx, cz, Date.now(), Date.now());
}

/**
 * 准备方块变更日志批量插入 (审计/反作弊/Undo)
 * @param {D1Database} db
 * @param {Array<{actorUuid: string|null, actorType: string, x:number, y:number, z:number, oldStateId:number, newStateId:number, tick:number, at:number}>} entries
 * @returns {D1PreparedStatement|null} 空数组返回 null (batch 不接受空语句)
 */
export function prepareBlockChangeLogInsert(db, entries) {
  if (!entries || entries.length === 0) return null;

  const placeholders = entries.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
  const values = entries.flatMap((e) => [
    e.actorUuid ?? null,
    e.actorType ?? 'player',
    'overworld',
    e.x, e.y, e.z,
    e.oldStateId ?? null,
    e.newStateId ?? null,
    e.tick ?? null,
    e.at ?? Date.now(),
  ]);

  return db
    .prepare(
      `INSERT INTO block_change_log
         (actor_uuid, actor_type, world, x, y, z, old_state_id, new_state_id, game_tick, real_timestamp)
       VALUES ${placeholders}`
    )
    .bind(...values);
}

/**
 * 保存玩家状态到 player_data (users 库) — 每 60 秒调用
 * @param {object} p { uuid, name, world, x, y, z, yaw, pitch, gamemode, health, food }
 * @param {string|null} inventoryJson 物品栏 JSON (Phase 3)
 */
export async function savePlayerState(env, p, inventoryJson = null) {
  await env.USERS_DB.prepare(
    `INSERT INTO player_data (uuid, name, world, x, y, z, yaw, pitch, gamemode, health, food, inventory, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       world = excluded.world, x = excluded.x, y = excluded.y, z = excluded.z,
       yaw = excluded.yaw, pitch = excluded.pitch, gamemode = excluded.gamemode,
       health = excluded.health, food = excluded.food, inventory = excluded.inventory,
       last_seen_at = excluded.last_seen_at`
  ).bind(
    p.uuid, p.name, p.world ?? 'overworld',
    p.x, p.y, p.z, p.yaw ?? 0, p.pitch ?? 0,
    p.gamemode ?? 0, p.health ?? 20, p.food ?? 20,
    inventoryJson, Date.now()
  ).run();
}
