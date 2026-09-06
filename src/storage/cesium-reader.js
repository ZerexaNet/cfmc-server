/**
 * ============================================================================
 * Cesium 格式读取器 — 从 D1 (cfmc-world) 加载区块
 * ============================================================================
 *
 * 对应表: chunks / chunk_sections / tile_entities (见 cesium-schema.sql)
 * 调用方: RegionDO.getOrLoadChunk() — 仅在 LRU 缓存未命中时调用 (低频)
 *
 * 性能要点:
 *   - 每区块 2 条查询 (sections + tileEntities), 用 .bind() 参数化
 *   - 解压 (Zstd/deflate) 由调用方处理, 本文件只管 I/O
 *   - D1 prepare().first()/.all() 返回的都是行对象, BLOB 列为 ArrayBuffer
 * ============================================================================
 */

import { decompress } from '../protocol/compression.js';

/**
 * 加载整个区块 (所有 Section + TileEntity)
 * @param {D1Database} db env.WORLD_DB
 * @param {number} cx 区块X
 * @param {number} cz 区块Z
 * @returns {Promise<{found: boolean, sections: Array, tileEntities: Array}>}
 *   sections 元素: { sectionY, palette, indices:Uint16Array, skyLight, blockLight, nonAirBlocks }
 */
export async function loadChunk(db, cx, cz) {
  // ---- 1. 区块元数据 (存在性 + 状态标志) ----
  const meta = await db
    .prepare('SELECT is_generated, is_populated, height_map FROM chunks WHERE chunk_x = ? AND chunk_z = ?')
    .bind(cx, cz)
    .first();

  if (!meta) return { found: false, sections: [], tileEntities: [] };

  // ---- 2. 全部 Section 数据 (一次查询拿整柱) ----
  const sectionsResult = await db
    .prepare(
      `SELECT section_y, palette_data, block_indices_compressed, sky_light, block_light, non_air_blocks
       FROM chunk_sections
       WHERE chunk_x = ? AND chunk_z = ?
       ORDER BY section_y ASC`
    )
    .bind(cx, cz)
    .all();

  const sections = [];
  for (const row of sectionsResult.results) {
    // 解压索引数组 → 交给调用方 decodeLongArray 还原为调色板下标
    const rawIndices = row.block_indices_compressed
      ? new Uint8Array(row.block_indices_compressed)
      : new Uint8Array(0);
    sections.push({
      sectionY: row.section_y,
      palette: JSON.parse(row.palette_data ?? '[]'),
      compressedIndices: rawIndices,
      skyLight: row.sky_light ? new Uint8Array(row.sky_light) : null,
      blockLight: row.block_light ? new Uint8Array(row.block_light) : null,
      nonAirBlocks: row.non_air_blocks ?? 0,
    });
  }

  // ---- 3. TileEntity (箱子/熔炉等带数据方块) ----
  const teResult = await db
    .prepare('SELECT x, y, z, type, data FROM tile_entities WHERE chunk_x = ? AND chunk_z = ?')
    .bind(cx, cz)
    .all();

  return { found: true, sections, tileEntities: teResult.results };
}

/**
 * LongArray (64位打包) → 调色板下标数组
 * 与客户端 CFMCChunkLoader.decodeBlockIndices 和 cfmc.md 的 JS 示例逐位一致!
 *
 * @param {Uint8Array} compressed 已解压的原始字节 (64bit 大端 Long 序列)
 * @param {number} paletteSize    调色板大小 → bitsPerEntry = ceil(log2(paletteSize))
 * @param {number} count          期望元素数 (Section 固定 4096)
 * @returns {Uint16Array} 每个 entry 是 palette 下标
 */
export function decodeBlockIndices(compressed, paletteSize, count = 4096) {
  if (paletteSize <= 1) return new Uint16Array(count); // 单调色板: 全 0

  const bitsPerEntry = Math.ceil(Math.log2(paletteSize));
  const view = new DataView(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  const out = new Uint16Array(count);

  let longIndex = 0;
  let bitOffset = 0;

  for (let i = 0; i < count; i++) {
    let value = 0;
    for (let b = 0; b < bitsPerEntry; b++) {
      if (bitOffset >= 64) {
        bitOffset = 0;
        longIndex++;
      }
      // 取当前 long (大端) 的第 bitOffset 位
      const longHi = view.getUint32(longIndex * 8, false);
      const longLo = view.getUint32(longIndex * 8 + 4, false);
      const bit = bitOffset < 32 ? (longHi >>> (31 - bitOffset)) & 1 : (longLo >>> (63 - bitOffset)) & 1;
      value = (value << 1) | bit;
      bitOffset++;
    }
    out[i] = value;
  }
  return out;
}

/**
 * 读取世界元数据 (种子/出生点/时间...)
 * @returns {Promise<Map<string,string>>}
 */
export async function loadWorldMeta(db) {
  const rows = await db.prepare('SELECT key, value FROM world_meta').all();
  const map = new Map();
  for (const r of rows.results) map.set(r.key, r.value);
  return map;
}
