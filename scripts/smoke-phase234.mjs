#!/usr/bin/env node
/**
 * smoke-phase234.mjs — Phase 3/4 纯逻辑模块冒烟测试 (本地 node 直跑, 无需依赖)
 * 覆盖与 tests/unit/world-modules.test.js 相同的关键路径 (vitest 由 CI 执行)
 */
import assert from 'node:assert/strict';
import { ROLES, hasPermission, normalizeRole } from '../src/world/permissions.js';
import { MovementTracker } from '../src/world/anticheat.js';
import { executeCommand } from '../src/world/commands.js';
import { create, serialize, deserialize, handleClick, consumeHeld, setHeld } from '../src/world/inventory.js';
import { ClaimRegistry } from '../src/world/claims.js';
import { validatePay } from '../src/world/economy.js';
import { HookBus, examplePlugin } from '../src/world/hook-bus.js';
import { EntityWorld } from '../src/world/entities.js';
import { CLIENTBOUND, SERVERBOUND, PROTOCOL_VERSION } from '../src/protocol/packet-definitions.js';

let passed = 0;
const t = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('== permissions ==');
t('admin 继承 player 节点', () => assert.ok(hasPermission({ role: ROLES.ADMIN }, 'chat.send')));
t('player 无 ban 权限', () => assert.equal(hasPermission({ role: ROLES.PLAYER }, 'player.ban'), false));
t('未知角色兜底', () => assert.equal(normalizeRole('x'), ROLES.PLAYER));

console.log('== anticheat ==');
t('正常行走放行', () => {
  const m = new MovementTracker('survival');
  m.markTeleport({ x: 0, y: -60, z: 0 });
  m.lastTeleportAt = -1e12;
  assert.equal(m.feed({ x: 0.3, y: -60, z: 0, onGround: true }).action, 'accept');
});
t('瞬移加速回拉', () => {
  const m = new MovementTracker('survival');
  m.markTeleport({ x: 0, y: -60, z: 0 });
  m.lastTeleportAt = -1e12;
  const r = m.feed({ x: 50, y: -60, z: 0, onGround: true });
  assert.equal(r.action, 'correct');
  assert.equal(r.reason, 'speed');
});
t('滞空飞行回拉', () => {
  const m = new MovementTracker('survival');
  m.markTeleport({ x: 0, y: -60, z: 0 });
  m.lastTeleportAt = -1e12;
  let r = { action: 'accept' };
  for (let i = 0; i < 30 && r.action === 'accept'; i++) r = m.feed({ x: i * 0.1, y: -60, z: 0, onGround: false });
  assert.equal(r.reason, 'fly');
});

console.log('== commands ==');
const mkCtx = (role = ROLES.ADMIN) => {
  const log = [];
  return {
    log,
    ctx: {
      sender: { uuid: 'u1', name: 'Admin', role },
      reply: (x) => log.push(['reply', x]),
      broadcast: (x) => log.push(['bc', x]),
      findPlayerByName: (n) => (n?.toLowerCase() === 'steve' ? { uuid: 'u2', name: 'Steve' } : null),
      onlineAll: () => [],
      regionStats: () => ({ region: '0,0', tps: 20, tick: 0, entities: 0, cachedChunks: 0 }),
      teleport: (u, pos) => log.push(['tp', pos]),
      teleportToPlayer: () => {},
      kick: (u, r) => log.push(['kick', u, r]),
      ban: (n, r) => log.push(['ban', n, r]),
      unban: () => {},
      setRole: () => {},
      setGamemode: (u, gm) => log.push(['gm', u, gm]),
      saveAll: () => {},
      claim: () => ({ ok: true }),
      unclaim: () => ({ ok: true }),
      claimsOf: () => [],
      balanceOf: () => 100,
      pay: () => ({ ok: true }),
      grant: () => {},
    },
  };
};
t('非命令文本', () => assert.equal(executeCommand(mkCtx().ctx, 'hi'), false));
t('权限不足', () => assert.equal(mkCtx(ROLES.PLAYER) && (() => { const { ctx, log } = mkCtx(ROLES.PLAYER); executeCommand(ctx, '/ban steve'); return log[0][1]; })(), '§c权限不足'));
t('管理员踢人', () => {
  const { ctx, log } = mkCtx();
  executeCommand(ctx, '/kick steve 刷屏');
  assert.deepEqual(log[0], ['kick', 'u2', '刷屏']);
});
t('/tp 坐标', () => {
  const { ctx, log } = mkCtx();
  executeCommand(ctx, '/tp 10.5 -60 20.5');
  assert.deepEqual(log[0][1], { x: 10.5, y: -60, z: 20.5 });
});

console.log('== inventory ==');
t('序列化往返', () => {
  const inv = create([{ slot: 0, item: 'minecraft:stone', count: 32 }]);
  assert.deepEqual(deserialize(serialize(inv)).slots[0], { item: 'minecraft:stone', count: 32 });
});
t('坏数据回退', () => assert.equal(deserialize('垃圾数据').slots.length, 41));
t('拿起/放下', () => {
  const inv = create([{ slot: 0, item: 'minecraft:stone', count: 1 }]);
  handleClick(inv, 0);
  assert.equal(inv.cursor.item, 'minecraft:stone');
  handleClick(inv, 5);
  assert.equal(inv.slots[5].item, 'minecraft:stone');
});
t('消耗手持', () => {
  const inv = create([{ slot: 2, item: 'minecraft:stone', count: 1 }]);
  setHeld(inv, 2);
  assert.equal(consumeHeld(inv), true);
  assert.equal(inv.slots[2], null);
});

console.log('== claims / economy / hooks ==');
t('认领保护', () => {
  const c = new ClaimRegistry();
  c.claim(0, 0, 'alice');
  assert.equal(c.canModify(0, 0, 'bob', { role: 'player' }).allowed, false);
  assert.equal(c.canModify(0, 0, 'bob', { role: 'admin' }).allowed, true);
});
t('转账校验', () => {
  assert.equal(validatePay(100, 101).ok, false);
  assert.equal(validatePay(100, 50).ok, true);
});
t('事件总线异常隔离', () => {
  const bus = new HookBus();
  let n = 0;
  bus.on('e', () => n++);
  bus.on('e', () => { throw new Error('bad'); }, { name: 'bad' });
  bus.emit('e', {});
  assert.equal(n, 1);
  assert.equal(bus.errorCounts.get('bad'), 1);
});
t('示例插件统计', () => {
  const bus = new HookBus();
  const p = examplePlugin(bus);
  bus.emit('player.join', {});
  bus.emit('block.place', {});
  assert.deepEqual(p.stats(), { joins: 1, places: 1 });
});
t('僵尸 AI 攻击闭环', () => {
  const w = new EntityWorld();
  const e = w.spawn('zombie', 0, -60, 0, 42);
  const player = { uuid: 'u1', pos: { x: 2, y: -60, z: 0 } };
  const ctx = {
    tick: 0, isNight: () => true, random01: () => 0.5,
    playersList: () => [player],
    nearestPlayer: () => player,
    damagePlayer: (u, amount) => { player.damaged = (player.damaged ?? 0) + amount; },
    canStand: () => true,
    onEntityMove: () => {},
    onEntitySpawn: () => {},
  };
  for (let i = 0; i < 60; i++) { ctx.tick = i; w.tickAll(ctx); }
  assert.ok((player.damaged ?? 0) > 0, '僵尸应在夜晚攻击玩家');
});

console.log('== protocol 增量包 ==');
t('INTERACT_ENTITY 0x20 / PLAYER_POSITION 0x21', () => {
  assert.equal(SERVERBOUND.INTERACT_ENTITY.id, 0x20);
  assert.equal(CLIENTBOUND.PLAYER_POSITION.id, 0x21);
  assert.equal(PROTOCOL_VERSION, 2);
});

console.log(`\n冒烟结果: ${passed} 通过${process.exitCode ? ' (存在失败!)' : '，全部 OK'}`);
