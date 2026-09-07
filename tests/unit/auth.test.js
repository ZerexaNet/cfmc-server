/**
 * 认证模块单元测试 — 离线UUID (Java兼容) + JWT 签发/验证
 */
import { describe, it, expect } from 'vitest';
import { md5, offlineUuid, md5SelfTest } from '../../src/auth/offline-uuid.js';
import { signJWT, verifyJWT, generateRefreshToken } from '../../src/auth/jwt-handler.js';

describe('MD5 (RFC 1321 标准向量)', () => {
  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  it('空字符串', () => {
    expect(hex(md5(new TextEncoder().encode('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('"abc"', () => {
    expect(hex(md5(new TextEncoder().encode('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('The quick brown fox jumps over the lazy dog', () => {
    const s = 'The quick brown fox jumps over the lazy dog';
    expect(hex(md5(new TextEncoder().encode(s)))).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('长输入 (56字节双块边界, 与 python hashlib 交叉验证)', () => {
    const s = 'a'.repeat(56);
    expect(hex(md5(new TextEncoder().encode(s)))).toBe('3b0c8ac703f828b04c6c197006d17218');
  });

  it('长输入 (100字节, 与 python hashlib 交叉验证)', () => {
    const s = 'a'.repeat(100);
    expect(hex(md5(new TextEncoder().encode(s)))).toBe('36a92cc94a9e0fa21f625f8bfb007adf');
  });

  it('自检通过', () => {
    expect(md5SelfTest()).toBe(true);
  });
});

describe('离线 UUID (Java nameUUIDFromBytes 兼容)', () => {
  it('版本位 = 3, 变体位 = RFC4122', () => {
    const u = offlineUuid('Notch');
    expect(u[14]).toBe('3'); // version nibble (第13个hex位)
    expect(['8', '9', 'a', 'b']).toContain(u[19]); // variant nibble
  });

  it('确定性: 同名同 UUID, 大小写敏感 (与Java一致)', () => {
    expect(offlineUuid('Steve')).toBe(offlineUuid('Steve'));
    expect(offlineUuid('Steve')).not.toBe(offlineUuid('steve'));
  });

  it('格式: 8-4-4-4-12 标准带横杠', () => {
    expect(offlineUuid('Alex')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('UTF-8 玩家名 (中文)', () => {
    expect(() => offlineUuid('边缘玩家')).not.toThrow();
  });
});

describe('JWT (HS256)', () => {
  const SECRET = 'test-secret';

  it('签发→验证往返', async () => {
    const token = await signJWT({ uuid: 'u1', name: 'Steve', mode: 'offline' }, SECRET, 60);
    const payload = await verifyJWT(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload.uuid).toBe('u1');
    expect(payload.mode).toBe('offline');
  });

  it('错误密钥拒绝', async () => {
    const token = await signJWT({ uuid: 'u1' }, SECRET, 60);
    expect(await verifyJWT(token, 'wrong-secret')).toBeNull();
  });

  it('过期拒绝 (ttl=−10s)', async () => {
    const token = await signJWT({ uuid: 'u1' }, SECRET, -10);
    expect(await verifyJWT(token, SECRET)).toBeNull();
  });

  it('畸形 token 拒绝', async () => {
    expect(await verifyJWT('not-a-jwt', SECRET)).toBeNull();
    expect(await verifyJWT('a.b.c', SECRET)).toBeNull();
  });

  it('RefreshToken 格式', () => {
    expect(generateRefreshToken()).toMatch(/^rt_[0-9a-f]{32}$/);
  });
});
