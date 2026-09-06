/**
 * ============================================================================
 * 二进制编码器 — 与客户端 Mod (Java) 逐字节一致的写入逻辑
 * ============================================================================
 *
 * 对应客户端文件: protocol/PacketWriter.java
 *
 * 帧封装 (见 packet-definitions.js 帧格式图):
 *   Length(VarInt, 不含自身) | PacketID(VarInt) | Flags(Byte) | Payload
 *   → static frame() 一次完成, 供 RegionDO 广播 / ChatDO 等复用
 *
 * 性能考量:
 *   - 内部用可增长的 Uint8Array + DataView, 摊销扩容 (容量翻倍)
 *   - encodePackets() 把多个包合并成一条 WS 消息 (批量发送省帧头开销)
 * ============================================================================
 */

export class PacketWriter {
  /** @param {number} initialCapacity 初始容量 (字节) */
  constructor(initialCapacity = 64) {
    this.bytes = new Uint8Array(initialCapacity);
    this.view = new DataView(this.bytes.buffer);
    this.length = 0;
  }

  #ensure(extra) {
    if (this.length + extra <= this.bytes.length) return;
    let cap = this.bytes.length * 2;
    while (cap < this.length + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  /* ---------------- VarInt / VarLong ---------------- */

  /**
   * 写 VarInt — 与 Java 端 CFMCBufferUtils.writeVarInt 完全一致。
   * 负数按 Java int 的无符号32位处理 (do-while 结构, 与 wiki.vg 相同)。
   * @param {number} value
   */
  writeVarInt(value) {
    this.#ensure(5);
    let v = value >>> 0; // 转 u32 (兼容负数, 对齐 Java (int) 语义)
    do {
      let byte = v & 0x7f;
      v >>>= 7;
      if (v !== 0) byte |= 0x80;
      this.bytes[this.length++] = byte;
    } while (v !== 0);
  }

  /** 写 VarLong (BigInt, 64位有符号 → 无符号编码) */
  writeVarLong(value) {
    this.#ensure(10);
    let v = BigInt.asUintN(64, BigInt(value));
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v !== 0n) byte |= 0x80;
      this.bytes[this.length++] = byte;
    } while (v !== 0n);
  }

  /* ---------------- 标量 (大端序) ---------------- */

  writeBoolean(b) {
    this.#ensure(1);
    this.bytes[this.length++] = b ? 1 : 0;
  }

  writeUInt8(v) {
    this.#ensure(1);
    this.bytes[this.length++] = v & 0xff;
  }

  writeInt8(v) {
    this.#ensure(1);
    this.view.setInt8(this.length, v);
    this.length += 1;
  }

  writeInt16(v) {
    this.#ensure(2);
    this.view.setInt16(this.length, v, false);
    this.length += 2;
  }

  writeUInt16(v) {
    this.#ensure(2);
    this.view.setUint16(this.length, v, false);
    this.length += 2;
  }

  writeInt32(v) {
    this.#ensure(4);
    this.view.setInt32(this.length, v, false);
    this.length += 4;
  }

  writeInt64(v) {
    this.#ensure(8);
    this.view.setBigInt64(this.length, BigInt(v), false);
    this.length += 8;
  }

  writeFloat(v) {
    this.#ensure(4);
    this.view.setFloat32(this.length, v, false);
    this.length += 4;
  }

  writeDouble(v) {
    this.#ensure(8);
    this.view.setFloat64(this.length, v, false);
    this.length += 8;
  }

  /* ---------------- 复合类型 ---------------- */

  /** VarInt 长度前缀 + UTF-8 (与 readString 对称) */
  writeString(str, maxLength = 32767) {
    const encoded = new TextEncoder().encode(str);
    if (encoded.length > maxLength) throw new Error(`字符串超长: ${encoded.length} > ${maxLength}`);
    this.writeVarInt(encoded.length);
    this.#ensure(encoded.length);
    this.bytes.set(encoded, this.length);
    this.length += encoded.length;
  }

  writeBytes(arr) {
    this.#ensure(arr.byteLength);
    this.bytes.set(arr, this.length);
    this.length += arr.byteLength;
  }

  /** 当前已写内容 (拷贝, 摆脱大缓冲引用) */
  toUint8Array() {
    return this.bytes.slice(0, this.length);
  }

  /* ---------------- 帧封装工具 ---------------- */

  /**
   * 构造完整帧: Length | PacketID | Flags | Payload
   * @param {number} packetId 包ID (CLIENTBOUND/SERVERBOUND 注册表)
   * @param {number} flags    PACKET_FLAGS 位域
   * @param {Uint8Array} payload 业务数据 (未压缩)
   */
  static frame(packetId, flags = 0, payload = new Uint8Array(0)) {
    const head = new PacketWriter(8);
    head.writeVarInt(packetId);
    head.writeUInt8(flags);
    // Length = PacketID + Flags + Payload 的总长 (不含 Length 自身)
    const bodyLength = head.length + payload.length;
    const out = new PacketWriter(5 + bodyLength);
    out.writeVarInt(bodyLength);
    out.writeBytes(head.toUint8Array());
    out.writeBytes(payload);
    return out.toUint8Array();
  }
}

/**
 * 多包合并发送 (RegionDO 每 tick 广播用):
 * 一条 WS 消息 = 连续多帧, 客户端按 Length 循环切片。
 * 省去每包一条 WS 消息的 per-message 开销。
 * @param {Array<{id:number, flags?:number, payload?:Uint8Array}>} packets
 * @returns {Uint8Array}
 */
export function encodePackets(packets) {
  const out = new PacketWriter(256);
  for (const p of packets) {
    out.writeBytes(PacketWriter.frame(p.id, p.flags ?? 0, p.payload ?? new Uint8Array(0)));
  }
  return out.toUint8Array();
}
