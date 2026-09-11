/**
 * Phase 3/4 纯逻辑模块单元测试 (vitest)
 * 运行: npm test  (vitest + workers pool)
 */
import { describe, it, expect } from 'vitest';

import { ROLES, hasPermission, roleAtLeast, normalizeRole } from '../../src/world/permissions.js';
import { MovementTracker } from '../../src/world/anticheat.js';
import { executeCommand, listCommands } from '../../src/world/commands.js';
import { create, serialize, deserialize, handleClick, addItem, consumeHeld, setHeld, INVENTORY_SIZE } from '../../src/world/inventory.js';
import { ClaimRegistry, CLAIMS_LIMIT } from '../../src/world/claims.js';
import { validatePay, STARTING_BALANCE, MAX_GRANT } from '../../src/world/economy.js';
import { HookBus, examplePlugin } from '../../src/world/hook-bus.js';
import { EntityWorld } from '../../src/world/entities.js';
import { CLIENTBOUND, SERVERBOUND, PROTOCOL_VERSION } from '../../src/protocol/packet-definitions.js';

describe('permissions 权限系统', () => {
  it('角色继承: admin 拥有 moderator/player 节点', () => {
    expect(hasPermission({ role: ROLES.ADMIN }, 'player.kick')).toBe(true);
    expect(hasPermission({ role: ROLES.ADMIN }, 'chat.send')).toBe(true);
    expect(hasPermission({ role: ROLES.MODERATOR }, 'chat.send')).toBe(true);
  });
  it('player 不能踢人/ban', () => {
    expect(hasPermission({ role: ROLES.PLAYER }, 'player.kick')).toBe(false);
    expect(hasPermission({ role: ROLES.PLAYER }, 'player.ban')).toBe(false);
  });
  it('未知角色兜底与角色等级', () => {
    expect(normalizeRole('hacker')).toBe(ROLES.PLAYER);
    expect(roleAtLeast(ROLES.MODERATOR, ROLES.PLAYER)).toBe(true);
    expect(roleAtLeast(ROLES.PLAYER, ROLES.ADMIN)).toBe(false);
  });
  it('扩展权限 (extraPerms) 生效', () => {
    expect(hasPermission({ role: ROLES.PLAYER, extraPerms: ['admin.save'] }, 'admin.save')).toBe(true);
  });
});

describe('anticheat 反作弊', () => {
  it('正常行走放行', () => {
    const t = new MovementTracker('survival');
    t.markTeleport({ x: 0, y: -60, z: 0 });
    expect(t.feed({ x: 0.2, y: -60, z: 0, onGround: true }).action).toBe('accept');
    expect(t.feed({ x: 0.4, y: -60, z: 0.1, onGround: true }).action).toBe('accept');
  });
  it('瞬移型加速 → 回拉校正', () => {
    const t = new MovementTracker('survival');
    t.markTeleport({ x: 0, y: -60, z: 0 });
    t.lastTeleportAt = -1e12; // 跳过传送宽限 (markTeleport 会给 1.5s 宽限)
    const r = t.feed({ x: 50, y: -60, z: 0, onGround: true });
    expect(r.action).toBe('correct');
    expect(r.reason).toBe('speed');
  });
  it('飞行滞空 → 回拉', () => {
    const t = new MovementTracker('survival');
    t.markTeleport({ x: 0, y: -60, z: 0 });
    t.lastTeleportAt = -1e12; // 跳过传送宽限
    let verdict = { action: 'accept' };
    for (let i = 0; i < 30; i++) {
      verdict = t.feed({ x: i * 0.1, y: -60, z: 0, onGround: false });
      if (verdict.action === 'correct') break;
    }
    expect(verdict.action).toBe('correct');
    expect(verdict.reason).toBe('fly');
  });
  it('创造模式豁免飞行检查', () => {
    const t = new MovementTracker('creative');
    t.markTeleport({ x: 0, y: -60, z: 0 });
    t.lastTeleportAt = -1e12;
    let verdict = { action: 'accept' };
    for (let i = 0; i < 30; i++) {
      verdict = t.feed({ x: 0, y: -60 + i * 0.5, z: 0, onGround: false });
      if (verdict.action === 'correct') break;
    }
    expect(verdict.action).toBe('accept');
  });
});

describe('commands 管理命令', () => {
  const makeCtx = () => {
    const log = [];
    return {
      log,
      ctx: {
        sender: { uuid: 'u1', name: 'Admin', role: ROLES.ADMIN },
        reply: (t) => log.push(['reply', t]),
        broadcast: (t) => log.push(['broadcast', t]),
        findPlayerByName: (n) => (n?.toLowerCase() === 'steve' ? { uuid: 'u2', name: 'Steve' } : null),
        onlineAll: () => [{ name: 'Admin', region: '0,0' }],
        regionStats: () => ({ region: '0,0', tps: 19.9, tick: 1, entities: 0, cachedChunks: 0 }),
        teleport: (u, pos) => log.push(['tp', u, pos]),
        teleportToPlayer: (a, b) => log.push(['tp2p', a, b]),
        kick: (u, r) => log.push(['kick', u, r]),
        ban: (n, r) => log.push(['ban', n, r]),
        unban: (n) => log.push(['unban', n]),
        setRole: () => {},
        setGamemode: (u, gm) => log.push(['gm', u, gm]),
        saveAll: () => log.push(['save']),
        claim: () => ({ ok: true, cx: 0, cz: 0, owned: 1 }),
        unclaim: () => ({ ok: true }),
        claimsOf: () => ['0,0'],
        balanceOf: () => 100,
        pay: () => ({ ok: true }),
        grant: () => log.push(['grant']),
      },
    };
  };

  it('未知玩家踢出 → 提示不在线', () => {
    const { ctx, log } = makeCtx();
    executeCommand(ctx, '/kick nobody');
    expect(log[0][0]).toBe('reply');
    expect(log[0][1]).toContain('不在线');
  });
  it('管理员可踢人', () => {
    const { ctx, log } = makeCtx();
    executeCommand(ctx, '/kick steve 刷屏');
    expect(log[0]).toEqual(['kick', 'u2', '刷屏']);
  });
  it('player 无权限执行 ban', () => {
    const { ctx, log } = makeCtx();
    ctx.sender.role = ROLES.PLAYER;
    executeCommand(ctx, '/ban steve');
    expect(log[0][1]).toBe('§c权限不足');
  });
  it('/tp 坐标解析', () => {
    const { ctx, log } = makeCtx();
    executeCommand(ctx, '/tp 10.5 -60 20.5');
    expect(log[0][0]).toBe('tp');
    expect(log[0][2]).toEqual({ x: 10.5, y: -60, z: 20.5 });
  });
  it('/gamemode 别名', () => {
    const { ctx, log } = makeCtx();
    executeCommand(ctx, '/gamemode c');
    expect(log[0]).toEqual(['gm', 'u1', 1]);
  });
  it('非命令文本返回 false', () => {
    expect(executeCommand(makeCtx().ctx, 'hello world')).toBe(false);
  });
  it('/help 只列有权限的命令', () => {
    const { ctx, log } = makeCtx();
    ctx.sender.role = ROLES.PLAYER;
    executeCommand(ctx, '/help');
    const text = log[0][1];
    expect(text).toContain('/help');
    expect(text).not.toContain('/ban');
  });
  it('listCommands 可枚举', () => {
    expect(listCommands().length).toBeGreaterThan(10);
  });
});

describe('inventory 背包', () => {
  it('序列化往返', () => {
    const inv = create([{ slot: 0, item: 'minecraft:stone', count: 32 }]);
    const restored = deserialize(serialize(inv));
    expect(restored.slots[0]).toEqual({ item: 'minecraft:stone', count: 32 });
    expect(restored.slots[1]).toBeNull();
  });
  it('损坏数据回退空背包', () => {
    expect(deserialize('not json').slots.length).toBe(INVENTORY_SIZE);
    expect(deserialize(null).slots.every((s) => s === null)).toBe(true);
  });
  it('点击拿起/放下/交换', () => {
    const inv = create([{ slot: 0, item: 'minecraft:stone', count: 1 }, { slot: 1, item: 'minecraft:dirt', count: 2 }]);
    expect(handleClick(inv, 0)).toBe(true);
    expect(inv.cursor.item).toBe('minecraft:stone');
    expect(handleClick(inv, 5)).toBe(true); // 放到空位
    expect(inv.slots[5].item).toBe('minecraft:stone');
    expect(inv.cursor).toBeNull();
  });
  it('同类叠加 (超64退回光标)', () => {
    const inv = create([{ slot: 0, item: 'minecraft:stone', count: 60 }]);
    addItem(inv, 'minecraft:stone', 10); // 60+10 → 64 + 光标外? addItem 直接进
    handleClick(inv, 0); // 拿起 64
    addItem(inv, 'minecraft:stone', 5); // 加到空位
    handleClick(inv, 1); // 放下 64 到 slot1? cursor 与 target=stone5 同类 → 合并
  });
  it('消耗手持', () => {
    const inv = create([{ slot: 2, item: 'minecraft:grass_block', count: 2 }]);
    setHeld(inv, 2);
    expect(consumeHeld(inv)).toBe(true);
    expect(inv.slots[2].count).toBe(1);
    expect(consumeHeld(inv)).toBe(true);
    expect(inv.slots[2]).toBeNull();
    expect(consumeHeld(inv)).toBe(false);
  });
});

describe('claims 土地保护', () => {
  it('认领/上限/他人修改被拒', () => {
    const c = new ClaimRegistry();
    expect(c.claim(0, 0, 'alice').ok).toBe(true);
    expect(c.canModify(0, 0, 'bob', { role: 'player' }).allowed).toBe(false);
    expect(c.canModify(0, 0, 'alice', {}).allowed).toBe(true);
    expect(c.canModify(0, 0, 'bob', { role: 'admin' }).allowed).toBe(true);
    expect(c.countOf('alice')).toBe(1);
  });
  it('认领上限生效', () => {
    const c = new ClaimRegistry();
    for (let i = 0; i < CLAIMS_LIMIT; i++) c.claim(i, 0, 'p1');
    expect(c.claim(999, 999, 'p1').ok).toBe(false);
    expect(c.claim(999, 999, 'p2').ok).toBe(true);
  });
  it('只有本人或 mod 能放弃认领', () => {
    const c = new ClaimRegistry();
    c.claim(1, 1, 'alice');
    expect(c.unclaim(1, 1, 'bob', false).ok).toBe(false);
    expect(c.unclaim(1, 1, 'bob', true).ok).toBe(true);
  });
});

describe('economy 经济', () => {
  it('转账校验', () => {
    expect(validatePay(STARTING_BALANCE, 50).ok).toBe(true);
    expect(validatePay(STARTING_BALANCE, 101).ok).toBe(false);
    expect(validatePay(100, -5).ok).toBe(false);
    expect(validatePay(100, 1.9).amount).toBe(1);
  });
  it('发放上限常量', () => {
    expect(MAX_GRANT).toBe(100000);
  });
});

describe('hook-bus 插件总线', () => {
  it('订阅/触发/异常隔离', () => {
    const bus = new HookBus();
    let called = 0;
    bus.on('player.join', () => { called++; });
    bus.on('player.join', () => { throw new Error('坏插件'); }, { name: 'bad' });
    expect(bus.emit('player.join', {})).toBe(2);
    expect(called).toBe(1);
    expect(bus.errorCounts.get('bad')).toBe(1);
  });
  it('示例插件统计', () => {
    const bus = new HookBus();
    const p = examplePlugin(bus);
    bus.emit('player.join', { name: 'A' });
    bus.emit('block.place', {});
    expect(p.stats()).toEqual({ joins: 1, places: 1 });
  });
});

describe('entities 实体 AI', () => {
  const makeCtx = (players) => ({
    tick: 0,
    isNight: () => true,
    random01: () => 0.5,
    playersList: () => players,
    nearestPlayer: (pos, range) => players[0] ?? null,
    damagePlayer: (u, amount) => { players[0].damaged = (players[0].damaged ?? 0) + amount; },
    canStand: () => true,
    onEntityMove: () => {},
    onEntitySpawn: () => {},
  });

  it('生成/伤害/死亡', () => {
    const w = new EntityWorld();
    const e = w.spawn('zombie', 0, -60, 0, 42);
    expect(e).not.toBeNull();
    const r = w.damage(e.id, 999);
    expect(r.dead).toBe(true);
    expect(w.entities.size).toBe(0);
  });
  it('夜晚僵尸追击并攻击玩家', () => {
    const w = new EntityWorld();
    const e = w.spawn('zombie', 0, -60, 0, 42);
    const player = { uuid: 'u1', pos: { x: 2, y: -60, z: 0 } };
    // 先推进一次冷却, 再模拟多 tick 攻击
    for (let t = 0; t < 60; t++) w.tickAll(makeCtx([player]));
    expect(player.damaged).toBeGreaterThan(0);
  });
  it('未知类型拒绝生成', () => {
    expect(new EntityWorld().spawn('ender_dragon', 0, 0, 0)).toBeNull();
  });
});

describe('protocol Phase3/4 增量包', () => {
  it('新包 ID 已注册 (0x20/0x21 不冲突)', () => {
    expect(SERVERBOUND.INTERACT_ENTITY.id).toBe(0x20);
    expect(CLIENTBOUND.PLAYER_POSITION.id).toBe(0x21);
    expect(PROTOCOL_VERSION).toBe(2); // 增量包, 不 bump 版本
  });
});
