/**
 * 全协议支持单测 — version-registry.js / version-adapters.js
 * 运行: npx vitest run tests/unit/version-registry.test.js
 */
import { describe, it, expect } from 'vitest';
import {
  MC_PROTOCOLS,
  OLDEST_PROTOCOL,
  LATEST_PROTOCOL,
  getMcVersionInfo,
  familyOf,
  decideHandshake,
  supportSummary,
} from '../../src/protocol/version-registry.js';
import {
  selectAdapter,
  adapterNames,
  ProtocolAdapter,
} from '../../src/protocol/version-adapters.js';

describe('version-registry: MC 协议号表', () => {
  it('支持范围覆盖 1.8 (47) 到最新已收录版本', () => {
    expect(OLDEST_PROTOCOL).toBe(47);
    expect(LATEST_PROTOCOL).toBeGreaterThanOrEqual(772); // 1.21.8
    expect(MC_PROTOCOLS.length).toBeGreaterThan(25);
  });

  it('关键版本号逐一正确 (wiki.vg 标准值)', () => {
    expect(getMcVersionInfo(47).version).toBe('1.8');
    expect(getMcVersionInfo(340).version).toBe('1.12.2');
    expect(getMcVersionInfo(754).version).toBe('1.16.5');
    expect(getMcVersionInfo(763).version).toBe('1.20.1');
    expect(getMcVersionInfo(765).version).toBe('1.20.4');
    expect(getMcVersionInfo(767).version).toBe('1.21');
    expect(getMcVersionInfo(769).version).toBe('1.21.4');
  });

  it('别名版本与主版本同协议号', () => {
    expect(getMcVersionInfo(767).aliases).toContain('1.21.1');
    expect(getMcVersionInfo(772).aliases).toContain('1.21.7');
  });

  it('未收录协议号返回 known=false 且不抛异常 (向前兼容)', () => {
    const info = getMcVersionInfo(99999);
    expect(info.known).toBe(false);
    expect(info.family).toBe('modern'); // 未来版本归入 modern 族
  });
});

describe('version-registry: 版本族与握手决策', () => {
  it('族边界正确: 340=legacy, 393=flat, 764=modern', () => {
    expect(familyOf(340)).toBe('legacy');
    expect(familyOf(393)).toBe('flat');
    expect(familyOf(763)).toBe('flat');
    expect(familyOf(764)).toBe('modern');
  });

  it('未上报协议号 (0) 接受并走 generic 兜底', () => {
    const d = decideHandshake(0);
    expect(d.accept).toBe(true);
    expect(d.adapter).toBe('generic');
  });

  it('任何已知协议号都接受且映射到正确的适配器 (全协议支持核心承诺)', () => {
    for (const { proto } of MC_PROTOCOLS) {
      const d = decideHandshake(proto);
      expect(d.accept).toBe(true);
      expect(['legacy', 'flat', 'modern']).toContain(d.adapter);
    }
  });
});

describe('version-adapters: 适配器选择与方块名规范化', () => {
  it('selectAdapter 返回单例; 未知族名兜底 generic', () => {
    expect(selectAdapter('legacy')).toBe(selectAdapter('legacy'));
    expect(selectAdapter('nonexistent').name).toBe('generic');
    expect(adapterNames()).toEqual(expect.arrayContaining(['legacy', 'flat', 'modern', 'generic']));
  });

  it('generic 适配器: 裸方块名补 minecraft: 前缀', () => {
    const a = selectAdapter('generic');
    expect(a.normalizeBlockName('stone')).toBe('minecraft:stone');
    expect(a.normalizeBlockName('minecraft:stone')).toBe('minecraft:stone');
    expect(a.normalizeBlockName('  OAK_LOG  ')).toBe('minecraft:oak_log');
  });

  it('非法方块名被拒绝 (null)', () => {
    const a = selectAdapter('generic');
    expect(a.normalizeBlockName('')).toBeNull();
    expect(a.normalizeBlockName('bad name!')).toBeNull();
    expect(a.normalizeBlockName('x'.repeat(129))).toBeNull();
    expect(a.normalizeBlockName(null)).toBeNull();
  });

  it('legacy 适配器: grass_block 映射旧名 grass (1.13 flattening 反向兼容)', () => {
    const a = selectAdapter('legacy');
    expect(a.toClientBlockName('minecraft:grass_block')).toBe('minecraft:grass');
    expect(a.toClientBlockName('minecraft:stone')).toBe('minecraft:stone');
    expect(a.capabilities().chatFormat).toBe('legacy');
    expect(a.capabilities().worldHeightMax).toBe(256);
  });

  it('modern/flat 适配器: 高度范围与 JSON 聊天', () => {
    expect(selectAdapter('modern').capabilities().worldHeightMin).toBe(-64);
    expect(selectAdapter('flat').capabilities().nameSpacedBlocks).toBe(true);
  });

  it('基类默认能力: 全范围支持', () => {
    const base = new ProtocolAdapter('test');
    expect(base.supportedRange().min).toBe(OLDEST_PROTOCOL);
    expect(base.supportedRange().max).toBe(LATEST_PROTOCOL);
  });
});

describe('supportSummary: 服务信息快照', () => {
  it('包含范围/版本串/族列表', () => {
    const s = supportSummary();
    expect(s.mcProtocolMin).toBe(47);
    expect(s.mcProtocolMax).toBe(LATEST_PROTOCOL);
    expect(s.families).toEqual(['legacy', 'flat', 'modern']);
    expect(s.versions).toMatch(/^1\.8 ~ /);
  });
});
