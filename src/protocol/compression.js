/**
 * ============================================================================
 * 压缩工具 — Payload 压缩/解压
 * ============================================================================
 *
 * ⚠️ 重要设计决策 (与原版Minecraft的差异):
 *   cfmc.md 原计划 LZ4/Zstd, 但 Workers 平台 CompressionStream 当前仅支持
 *   gzip / deflate-raw / brotli。且 CompressionStream 是 **异步** API,
 *   而 WebSocket.send() 是同步的 —— 因此压缩只能用在 async 广播路径
 *   (Tick 循环内的批量广播), 不能在同步回显路径上临时压缩。
 *
 *   当前选择: deflate-raw (zlib 无头模式)
 *   - 比 gzip 少 18 字节头尾, 对小包友好
 *   - Java 客户端对应: new Inflater(true) / new Deflater(level, true)
 *     (nowrap=true 即 raw deflate, 逐字节兼容)
 *   TODO(Phase 2): 评估 pure-JS Zstd (zstd-wasm) 的 CPU 开销; 若 Wasm 可用,
 *     切换算法时通过 HandshakeAck 的协议参数协商, 两端同步升级
 *
 * 压缩决策: payload.length >= COMPRESSION_THRESHOLD(256B) 才压缩
 *   (小包压缩得不偿失: 压缩耗时 > 传输省出的时间, 还可能变大)
 * ============================================================================
 */

/** @param {number} threshold 压缩阈值 (字节) */
export function shouldCompress(payload, threshold = 256) {
  return payload.length >= threshold;
}

/**
 * deflate-raw 压缩
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function compress(data) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * deflate-raw 解压
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function decompress(data) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(data);
  writer.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * 异步编码一个包并按需压缩 (RegionDO Tick 广播路径使用)
 * @returns {Promise<{id:number, flags:number, payload:Uint8Array}>} 压缩后帧参数
 */
export async function encodePacketCompressed(packetId, payload, threshold) {
  if (!shouldCompress(payload, threshold)) {
    return { id: packetId, flags: 0, payload };
  }
  const compressed = await compress(payload);
  // 压缩后反而变大 → 回退原文 (仅浪费少量探测, 换取带宽稳定)
  if (compressed.length >= payload.length) {
    return { id: packetId, flags: 0, payload };
  }
  return { id: packetId, flags: 0x01, payload: compressed };
}
