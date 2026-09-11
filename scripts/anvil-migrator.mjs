#!/usr/bin/env node
/**
 * ============================================================================
 * anvil-migrator.mjs — Anvil (.mca) → Cesium(D1) 世界迁移器 (Phase 2 交付物)
 * ============================================================================
 *
 * 功能: 解析原版存档的 region/*.mca 文件, 提取区块 Section (调色板+方块索引),
 *      转换为 CFMC 的 Cesium 格式 SQL (与 RegionDO 的写入格式逐字节兼容),
 *      产物用 `wrangler d1 execute cfmc-world --file=...` 导入。
 *
 * 兼容性:
 *   - 1.13+ (Palette/BlockStates 每 section 独立)
 *   - 1.18+ (block_states compound 包装 + 负 Y 区块)
 *   - 压缩类型: zlib(2) / gzip(1) / 未压缩(3)
 *   - 1.16+ LongArray 打包 (bits 不跨 long)
 *
 * 用法:
 *   node scripts/anvil-migrator.mjs <存档目录或 .mca 文件...> --out import.sql
 *   wrangler d1 execute cfmc-world --remote --file=import.sql -y
 *
 * 设计说明:
 *   - 复用 src/storage/cesium-writer.js 的 encodeBlockIndices/hashPalette —
 *     保证迁移产物与 RegionDO 在线写入格式完全一致 (避免双实现漂移)
 *   - 索引序: Anvil 与本项目同为 (y<<8)|(z<<4)|x, 但 Anvil 的位打包
 *     "不跨 long", 需逐 long 解码后重打包 (encodeBlockIndices 是连续位流)
 * ============================================================================
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { inflateSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 复用线上写入格式 (单一事实来源)
import { encodeBlockIndices, hashPalette, countNonAir } from '../src/storage/cesium-writer.js';
import { compress } from '../src/protocol/compression.js';

/* ------------------------- CLI 参数 ------------------------- */
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : 'cesium-import.sql';
const inputs = args.filter((a, i) => a !== '--out' && i !== outIdx - 1 && i !== outIdx + 1 && a !== '--out');
if (inputs.length === 0) {
  console.error('用法: node scripts/anvil-migrator.mjs <region目录或.mca文件...> --out import.sql');
  process.exit(1);
}

/** 收集所有 .mca 文件 (目录则递归找 region/*.mca) */
const files = [];
for (const p of inputs) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const f of readdirSync(p)) if (f.endsWith('.mca')) files.push(path.join(p, f));
  } else if (p.endsWith('.mca')) {
    files.push(p);
  }
}
if (files.length === 0) {
  console.error('未找到 .mca 文件 (请指向 <world>/region/ 目录)');
  process.exit(1);
}

/* ========================= NBT 最小解析器 ========================= */
class NBT {
  constructor(buf) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = 0;
  }
  u8() { return this.buf[this.pos++]; }
  i16() { const v = this.view.getInt16(this.pos, false); this.pos += 2; return v; }
  i32() { const v = this.view.getInt32(this.pos, false); this.pos += 4; return v; }
  i64() { const v = this.view.getBigInt64(this.pos, false); this.pos += 8; return v; }
  f32() { const v = this.view.getFloat32(this.pos, false); this.pos += 4; return v; }
  f64() { const v = this.view.getFloat64(this.pos, false); this.pos += 8; return v; }
  bytes(n) { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  str() {
    const len = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return new TextDecoder().decode(this.bytes(len));
  }
  /** 读一个"具名"标签载荷 (tag type 已知) */
  payload(type) {
    switch (type) {
      case 1: return this.u8();
      case 2: return this.i16();
      case 3: return this.i32();
      case 4: return this.i64();
      case 5: return this.f32();
      case 6: return this.f64();
      case 7: { const n = this.i32(); return this.bytes(n); }              // ByteArray
      case 8: return this.str();                                            // String
      case 9: {                                                             // List
        const elType = this.u8();
        const len = this.i32();
        const out = [];
        for (let i = 0; i < len; i++) out.push(this.payload(elType));
        return out;
      }
      case 10: {                                                            // Compound
        const out = {};
        for (;;) {
          const t = this.u8();
          if (t === 0) break;
          out[this.str()] = this.payload(t);
        }
        return out;
      }
      case 11: { const n = this.i32(); const a = []; for (let i = 0; i < n; i++) a.push(this.i32()); return a; } // IntArray
      case 12: { const n = this.i32(); const a = []; for (let i = 0; i < n; i++) a.push(this.i64()); return a; } // LongArray
      default: throw new Error(`未知 NBT 标签类型: ${type} @${this.pos}`);
    }
  }
  parseRoot() {
    const t = this.u8(); // 应为 10 (Compound)
    if (t !== 10) throw new Error(`根标签不是 Compound (${t})`);
    this.str(); // 根名 (空串)
    return this.payload(10);
  }
}

/* ===================== Anvil LongArray 解码 ===================== */
/** 1.16+ 位打包: 不跨 long。index = y*256 + z*16 + x (与本项目一致) */
function decodeAnvilIndices(longs, paletteSize) {
  const count = 4096;
  if (paletteSize <= 1 || longs.length === 0) return new Uint16Array(count);
  const bits = Math.max(4, Math.ceil(Math.log2(paletteSize)));
  const perLong = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  const out = new Uint16Array(count);
  const view = new DataView(new ArrayBuffer(8));
  for (let n = 0; n < count; n++) {
    const li = Math.floor(n / perLong);
    const bi = BigInt((n % perLong) * bits);
    if (li >= longs.length) break;
    view.setBigUint64(0, longs[li], false); // 大端
    out[n] = Number((view.getBigUint64(0, false) >> bi) & mask);
  }
  return out;
}

/* ========================= SQL 生成 ========================= */
const esc = (s) => String(s).replace(/'/g, "''");
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

/* ========================= 主流程 ========================= */
let totalChunks = 0, totalSections = 0, skippedEmpty = 0;
const now = Date.now();
const sqlParts = [
  '-- CFMC-Edge Anvil → Cesium 迁移产物',
  `-- 生成时间: ${new Date().toISOString()}`,
  '-- 导入: wrangler d1 execute cfmc-world --remote --file=本文件 -y',
  'BEGIN TRANSACTION;',
];

for (const file of files) {
  const buf = readFileSync(file);
  console.log(`解析 ${path.basename(file)} (${(buf.length / 1024).toFixed(0)} KB) ...`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  for (let i = 0; i < 1024; i++) {
    const entry = view.getUint32(i * 4, false);
    const offset = (entry >> 8) * 4096;
    const sectorCount = entry & 0xff;
    if (offset === 0 || sectorCount === 0) continue;

    const length = view.getUint32(offset, false);
    const compression = buf[offset + 4];
    const raw = buf.subarray(offset + 5, offset + 4 + length);
    if (raw.length < length - 1) { console.warn(`  跳过损坏 chunk @${i}`); continue; }

    let nbtBuf;
    if (compression === 2) nbtBuf = inflateSync(raw);
    else if (compression === 1) nbtBuf = gunzipSync(raw);
    else if (compression === 3) nbtBuf = raw;
    else { console.warn(`  不支持的压缩类型 ${compression}, 跳过`); continue; }

    let root;
    try {
      root = new NBT(nbtBuf).parseRoot();
    } catch (err) {
      console.warn(`  NBT 解析失败 @${i}: ${err.message}`);
      continue;
    }

    const cx = root.xPos ?? 0;
    const cz = root.zPos ?? 0;
    const sections = root.sections ?? [];
    const sectionRows = [];

    for (const sec of sections) {
      if (sec == null) continue;
      // 1.18+: block_states { palette, data }; 1.13-1.17: Palette + BlockStates
      const bs = sec.block_states ?? sec;
      const paletteNames = (bs.palette ?? []).map((p) => p?.Name ?? 'minecraft:stone');
      if (paletteNames.length === 0) continue;

      const longs = bs.data ?? sec.BlockStates ?? [];
      const indices = decodeAnvilIndices(longs, paletteNames.length);

      // 跳过纯空气 section
      if (paletteNames.length === 1 && /(^|:)air$/.test(paletteNames[0])) { skippedEmpty++; continue; }

      // 转为 CFMC 调色板 {id, name} + 连续位流重打包 (与 RegionDO 一致)
      const palette = paletteNames.map((name, id) => ({ id, name }));
      const nonAir = countNonAir(indices, palette);
      if (nonAir === 0) { skippedEmpty++; continue; }

      const packed = encodeBlockIndices(indices, palette.length);
      const compressed = packed.length > 0 ? await compress(packed) : packed;
      sectionRows.push(
        `INSERT INTO chunk_sections (chunk_x, chunk_z, section_y, palette_data, palette_hash, block_indices_compressed, sky_light, block_light, non_air_blocks, data_version)\n` +
        `VALUES (${cx}, ${cz}, ${sec.Y ?? 0}, '${esc(JSON.stringify(palette))}', '${hashPalette(palette)}', X'${hex(compressed)}', NULL, NULL, ${nonAir}, 1)\n` +
        `ON CONFLICT(chunk_x, chunk_z, section_y) DO UPDATE SET palette_data=excluded.palette_data, palette_hash=excluded.palette_hash, block_indices_compressed=excluded.block_indices_compressed, non_air_blocks=excluded.non_air_blocks;`
      );
    }

    // 区块索引行 (必须! 否则 loadChunk 判定未生成 → 被 RegionDO 覆盖为超平坦)
    sqlParts.push(`INSERT OR REPLACE INTO chunks (chunk_x, chunk_z, is_generated, is_populated, is_light_updated, dirty_count, created_at, last_modified)\nVALUES (${cx}, ${cz}, 1, 1, 0, 0, ${now}, ${now});`);
    for (const row of sectionRows) sqlParts.push(row);
    totalChunks++;
    totalSections += sectionRows.length;
  }
}

sqlParts.push('COMMIT;');
writeFileSync(OUT, sqlParts.join('\n\n') + '\n', 'utf8');

console.log('\n========== 迁移完成 ==========');
console.log(`区块: ${totalChunks} | Section: ${totalSections} | 跳过纯空气: ${skippedEmpty}`);
console.log(`SQL 产物: ${OUT} (${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`);
console.log('\n下一步:');
console.log(`  1. wrangler d1 execute cfmc-world --remote --file=${OUT} -y`);
console.log('  2. (可选) 更新出生点: INSERT OR REPLACE INTO world_meta (key,value) VALUES (\'spawn_x\',\'0\'); ...');
console.log('  3. 重启对应区域 (DO 会自动加载新数据)');
