/**
 * ============================================================================
 * 离线 UUID 生成 — 必须与 Java 的 nameUUIDFromBytes 逐字节一致!
 * ============================================================================
 *
 * Java 原版算法 (UUID.nameUUIDFromBytes):
 *   1. MD5("OfflinePlayer:" + username)  ← 字符串按 UTF-8 编码
 *   2. hash[6] = (hash[6] & 0x0F) | 0x30 → 版本 3 (MD5 UUID)
 *   3. hash[8] = (hash[8] & 0x3F) | 0x80 → RFC 4122 变体
 *   4. 16 字节按大端拼成 msb(8字节) + lsb(8字节)
 *
 * ⚠️ cfmc.md 说"用 Web Crypto API 实现 MD5" —— 但 Web Crypto 标准里
 *    **没有 MD5** (只有 SHA-1/256/384/512)! 而离线 UUID 必须用 MD5 才能与
 *    Java 端结果一致 (cfmc.md 要求 #6)。因此这里内置了一份纯 JS MD5 实现
 *    (标准 RFC 1321, 无依赖, 输入输出均为字节)。
 *
 * 验证方式: 与 Java 端 `UUID.nameUUIDFromBytes(("OfflinePlayer:"+name)
 *           .getBytes(StandardCharsets.UTF_8))` 输出比对, 必须完全一致。
 * ============================================================================
 */

/* --------------------------------------------------------------------------
 * 纯 JS MD5 (RFC 1321)。输入 Uint8Array, 输出 16 字节 Uint8Array。
 * 实现采用经典的每消息块 64 轮位运算, 无查表依赖, ~50 行, 足够快
 * (单次哈希 < 0.1ms, 仅在登录时调用, 非热路径)。
 * ------------------------------------------------------------------------ */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(abs(sin(i+1)) * 2^32) — 预计算常量
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

function rotateLeft(x, c) {
  return (x << c) | (x >>> (32 - c));
}

/** @param {Uint8Array} input 原始字节 */
export function md5(input) {
  // --- 消息填充: 补 0x80, 补 0 至 56 mod 64, 追加 64bit 小端长度 ---
  const len = input.length;
  const paddedLen = (((len + 8) >> 6) + 1) << 6; // ≥ len+9 的 64 倍数
  const msg = new Uint8Array(paddedLen);
  msg.set(input);
  msg[len] = 0x80;
  // ⚠️ 注意: JS 位运算移位量只有低5位有效 (x >>> 32 === x >>> 0),
  // 必须用除法取字节, 否则长度字段高32位会被写坏 (空串碰巧全0测不出来!)
  const bitLen = len * 8;
  for (let i = 0; i < 8; i++) {
    msg[paddedLen - 8 + i] = Math.floor(bitLen / 2 ** (i * 8)) & 0xff; // 小端 64bit
  }

  // --- 初始化链接变量 (小端) ---
  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  const M = new Int32Array(16);
  const dv = new DataView(msg.buffer);

  // --- 逐 512bit 块处理 ---
  for (let block = 0; block < paddedLen; block += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(block + i * 4, true);

    let A = a0, B = b0, C = c0, D = d0;

    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }

      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotateLeft(F, S[i])) | 0;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  // --- 输出: 4 个 32bit 链接变量, 每个按小端展开 ---
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, a0, true);
  odv.setInt32(4, b0, true);
  odv.setInt32(8, c0, true);
  odv.setInt32(12, d0, true);
  return out;
}

/** 字节 → 无横杠小写十六进制 (Mojang API 风格) */
function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * 生成离线玩家 UUID (与 Java nameUUIDFromBytes 完全一致)
 * @param {string} username 玩家名 (区分大小写! Java 端不转小写)
 * @returns {string} 带横杠标准格式
 */
export function offlineUuid(username) {
  const input = new TextEncoder().encode('OfflinePlayer:' + username);

  const hash = md5(input);

  // 版本 3 (MD5) — 与 Java setVersion(3) 一致
  hash[6] = (hash[6] & 0x0f) | 0x30;
  // RFC 4122 变体 — 与 Java setVariant 一致
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = bytesToHex(hash);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 自检 (启动期可用): 验证 MD5 实现正确性
 * RFC 1321 官方测试向量: md5("") = d41d8cd98f00b204e9800998ecf8427e
 */
export function md5SelfTest() {
  const empty = md5(new Uint8Array(0));
  const ok = bytesToHex(empty) === 'd41d8cd98f00b204e9800998ecf8427e';
  if (!ok) throw new Error('MD5 自检失败! 离线UUID将与Java不一致, 禁止上线');
  return ok;
}
