/**
 * ============================================================================
 * 二进制解码器 — 与客户端 Mod (Java) 逐字节一致的读取逻辑
 * ============================================================================
 *
 * 对应客户端文件: protocol/PacketReader.java
 *
 * 与原版 Minecraft 编码的兼容性:
 *   - VarInt/VarLong: 与 wiki.vg 完全一致 (LEB128, 小端位序, 每字节最高位续传)
 *   - 整数/浮点: 统一大端序 (原版网络字节序)
 *   - 字符串: VarInt 长度前缀 + UTF-8 字节
 *
 * 性能考量:
 *   - 用 DataView 而不是逐字节手拼, 单次解析 ChunkData (几百KB) 可控
 *   - 任何越界/非法 VarInt 立即 throw, 由上层捕获并断开 (防畸形包攻击)
 * ============================================================================
 */

export class PacketReader {
  /**
   * @param {ArrayBuffer|Uint8Array} buffer 帧的 Payload (已解压)
   */
  constructor(buffer) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.offset = 0;
  }

  /** 剩余可读字节数 */
  get remaining() {
    return this.bytes.length - this.offset;
  }

  #need(n, what) {
    if (this.offset + n > this.bytes.length) {
      throw new Error(`PacketReader 越界: 需要 ${n} 字节读 ${what}, 仅剩 ${this.remaining}`);
    }
  }

  /**
   * 读 VarInt (最多5字节, 32位)
   * Java 端等价: ByteBuffer 逐字节 (byte & 0x7F) << shift
   * @returns {number}
   */
  readVarInt() {
    let result = 0;
    let shift = 0;
    while (true) {
      this.#need(1, 'VarInt');
      const byte = this.bytes[this.offset++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift >= 32) throw new Error('VarInt 过长 (>5字节)');
    }
    // 32位有符号回卷: 负数 (如 0xFFFFFFFF) 在 JS 中要保持与 Java int 一致
    return result | 0;
  }

  /**
   * 读 VarLong (最多10字节, 64位) — Java long 语义, 返回 BigInt
   */
  readVarLong() {
    let result = 0n;
    let shift = 0n;
    while (true) {
      this.#need(1, 'VarLong');
      const byte = this.bytes[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
      if (shift >= 64n) throw new Error('VarLong 过长 (>10字节)');
    }
    // 64位有符号回卷 (Java long)
    return BigInt.asIntN(64, result);
  }

  readBoolean() {
    this.#need(1, 'Boolean');
    return this.bytes[this.offset++] !== 0;
  }

  readUInt8() {
    this.#need(1, 'UInt8');
    return this.bytes[this.offset++];
  }

  readInt8() {
    this.#need(1, 'Int8');
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readInt16() {
    this.#need(2, 'Int16');
    const v = this.view.getInt16(this.offset, false); // big-endian
    this.offset += 2;
    return v;
  }

  readUInt16() {
    this.#need(2, 'UInt16');
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }

  readInt32() {
    this.#need(4, 'Int32');
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readInt64() {
    this.#need(8, 'Int64');
    const v = this.view.getBigInt64(this.offset, false);
    this.offset += 8;
    return v;
  }

  readFloat() {
    this.#need(4, 'Float');
    const v = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return v;
  }

  readDouble() {
    this.#need(8, 'Double');
    const v = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return v;
  }

  /** VarInt 长度前缀字符串 (原版 String 格式) */
  readString(maxLength = 32767) {
    const length = this.readVarInt();
    if (length < 0 || length > maxLength) throw new Error(`字符串超长: ${length}`);
    this.#need(length, 'String');
    const s = new TextDecoder('utf-8').decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return s;
  }

  /** 定长字节数组 */
  readBytes(n) {
    this.#need(n, 'Bytes');
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /** 剩余全部字节 */
  readRemaining() {
    const out = this.bytes.slice(this.offset);
    this.offset = this.bytes.length;
    return out;
  }

  skip(n) {
    this.#need(n, 'skip');
    this.offset += n;
  }
}
