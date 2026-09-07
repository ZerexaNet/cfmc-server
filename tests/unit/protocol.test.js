/**
 * 协议编解码单元测试 — VarInt/帧/打包索引的往返一致性
 * 运行: npm test (vitest + workers pool)
 */
import { describe, it, expect } from 'vitest';
import { PacketReader } from '../../src/protocol/packet-reader.js';
import { PacketWriter, encodePackets } from '../../src/protocol/packet-writer.js';
import { decodeBlockIndices } from '../../src/storage/cesium-reader.js';
import { encodeBlockIndices } from '../../src/storage/cesium-writer.js';
import { isKnownPacket, CLIENTBOUND, SERVERBOUND } from '../../src/protocol/packet-definitions.js';

describe('VarInt 编解码', () => {
  const cases = [0, 1, 127, 128, 255, 256, 16383, 16384, 65535, 2097151, 2147483647, -1, -2147483648];

  it('正数/负数全部无损往返', () => {
    for (const v of cases) {
      const w = new PacketWriter(8);
      w.writeVarInt(v);
      const r = new PacketReader(w.toUint8Array());
      expect(r.readVarInt()).toBe(v);
    }
  });

  it('VarInt 字节数符合 wiki.vg 规范', () => {
    const lenOf = (v) => {
      const w = new PacketWriter(8);
      w.writeVarInt(v);
      return w.toUint8Array().length;
    };
    // 边界: 0→1B, 127→1B, 128→2B, 16383→2B, 16384→3B, 2^31-1→5B
    expect(lenOf(0)).toBe(1);
    expect(lenOf(127)).toBe(1);
    expect(lenOf(128)).toBe(2);
    expect(lenOf(16383)).toBe(2);
    expect(lenOf(16384)).toBe(3);
    expect(lenOf(2147483647)).toBe(5);
  });

  it('VarLong 64位往返 (BigInt)', () => {
    for (const v of [0n, 1n, -1n, 9223372036854775807n, -9223372036854775808n]) {
      const w = new PacketWriter(16);
      w.writeVarLong(v);
      const r = new PacketReader(w.toUint8Array());
      expect(r.readVarLong()).toBe(v);
    }
  });

  it('字符串往返 (含中文UTF-8)', () => {
    const s = 'CFMC 边缘服务器 §a绿字';
    const w = new PacketWriter(64);
    w.writeString(s);
    const r = new PacketReader(w.toUint8Array());
    expect(r.readString()).toBe(s);
  });
});

describe('帧封装', () => {
  it('Length 不含自身, 帧可循环解析', () => {
    const frames = encodePackets([
      { id: CLIENTBOUND.CHAT_MESSAGE.id, payload: new TextEncoder().encode('hi') },
      { id: CLIENTBOUND.KEEP_ALIVE.id, payload: new Uint8Array(0) },
    ]);
    const r = new PacketReader(frames);
    let count = 0;
    while (r.remaining > 0) {
      const len = r.readVarInt();
      const body = r.readBytes(len);
      const fr = new PacketReader(body);
      fr.readVarInt(); // packetId
      fr.readUInt8(); // flags
      count++;
    }
    expect(count).toBe(2);
  });
});

describe('LongArray 打包 (调色板索引)', () => {
  it('encode → decode 完全可逆', () => {
    const paletteSize = 5; // bitsPerEntry = 3
    const indices = new Uint16Array(4096);
    for (let i = 0; i < 4096; i++) indices[i] = i % paletteSize;

    const packed = encodeBlockIndices(indices, paletteSize);
    const decoded = decodeBlockIndices(packed, paletteSize, 4096);
    expect([...decoded]).toEqual([...indices]);
  });

  it('单调色板输出空数组 (原版 bitsPerEntry=0 优化)', () => {
    expect(encodeBlockIndices(new Uint16Array(4096), 1).length).toBe(0);
  });
});

describe('包注册表', () => {
  it('所有注册的包 ID 都能反查', () => {
    for (const def of Object.values(CLIENTBOUND)) expect(isKnownPacket(def.id)).toBe(true);
    for (const def of Object.values(SERVERBOUND)) expect(isKnownPacket(def.id)).toBe(true);
  });

  it('未知包 ID 被拒绝 (防畸形包)', () => {
    expect(isKnownPacket(0xEE)).toBe(false);
  });
});
