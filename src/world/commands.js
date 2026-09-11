/**
 * ============================================================================
 * commands.js — 管理命令路由 (Phase 3) + 经济/土地保护命令 (Phase 4)
 * ============================================================================
 * 纯逻辑模块: 只做 解析 → 权限检查 → 调用 ctx 回调。
 * 所有副作用通过 RegionDO 注入的 ctx 实现, 便于单测 (cfmc.md 设计约束 #1)。
 *
 * 命令通过 C2S ChatMessage (0x17) 进入: 以 '/' 开头即命令。
 */

import { ROLES, hasPermission } from './permissions.js';
import { GAMEMODES } from '../utils/constants.js';

/** 游戏模式别名 → 编号 */
const GAMEMODE_ALIASES = {
  survival: GAMEMODES.SURVIVAL, s: GAMEMODES.SURVIVAL, '0': GAMEMODES.SURVIVAL,
  creative: GAMEMODES.CREATIVE, c: GAMEMODES.CREATIVE, '1': GAMEMODES.CREATIVE,
  adventure: GAMEMODES.ADVENTURE, a: GAMEMODES.ADVENTURE, '2': GAMEMODES.ADVENTURE,
  spectator: GAMEMODES.SPECTATOR, sp: GAMEMODES.SPECTATOR, '3': GAMEMODES.SPECTATOR,
};

/** 命令注册表: name → { perm, usage, help, run(ctx, args) } */
const REGISTRY = new Map();

function cmd(name, def) {
  REGISTRY.set(name, def);
}

/* -------------------------------- 基础 -------------------------------- */

cmd('help', {
  perm: null,
  usage: '/help',
  help: '列出可用命令',
  run(ctx) {
    const lines = [...REGISTRY.entries()]
      .filter(([, d]) => !d.perm || hasPermission(ctx.sender, d.perm))
      .map(([n, d]) => `§7${d.usage} §f— ${d.help}`);
    ctx.reply(lines.join('\n'));
  },
});

cmd('list', {
  perm: 'player.list',
  usage: '/list',
  help: '查看全服在线玩家',
  run(ctx) {
    const all = ctx.onlineAll(); // [{name, region, role}]
    ctx.reply(`在线 ${all.length} 人: ` + all.map((p) => `${p.name}(${p.region})`).join(', '));
  },
});

cmd('tps', {
  perm: 'admin.tps',
  usage: '/tps',
  help: '查看本区域 TPS 与实体数',
  run(ctx) {
    const s = ctx.regionStats();
    ctx.reply(`区域 ${s.region} — TPS≈${s.tps.toFixed(1)} tick#${s.tick} 实体:${s.entities} 区块缓存:${s.cachedChunks}`);
  },
});

/* -------------------------------- 传送 -------------------------------- */

cmd('tp', {
  perm: 'tp.self',
  usage: '/tp <玩家名|x y z>',
  help: '传送到玩家或坐标 (仅自己)',
  run(ctx, args) {
    if (args.length >= 3) {
      const [x, y, z] = args.slice(0, 3).map(Number);
      if (![x, y, z].every(Number.isFinite)) return ctx.reply('§c用法: /tp <x y z>');
      ctx.teleport(ctx.sender.uuid, { x, y, z }, 'command');
      ctx.reply(`§a已传送到 ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`);
      return;
    }
    const target = ctx.findPlayerByName(args[0] ?? '');
    if (!target) return ctx.reply(`§c玩家 ${args[0] ?? ''} 不在本服`);
    ctx.teleportToPlayer(ctx.sender.uuid, target.uuid);
    ctx.reply(`§a已传送到 ${target.name}`);
  },
});

/* ------------------------------ 玩家管理 ------------------------------ */

cmd('kick', {
  perm: 'player.kick',
  usage: '/kick <玩家名> [原因]',
  help: '踢出玩家',
  run(ctx, args) {
    const t = ctx.findPlayerByName(args[0] ?? '');
    if (!t) return ctx.reply(`§c玩家 ${args[0] ?? ''} 不在线`);
    ctx.kick(t.uuid, args.slice(1).join(' ') || `被 ${ctx.sender.name} 踢出`);
    ctx.reply(`§a已踢出 ${t.name}`);
  },
});

cmd('ban', {
  perm: 'player.ban',
  usage: '/ban <玩家名> [原因]',
  help: '封禁玩家 (跨服生效, 存 users 库)',
  run(ctx, args) {
    const name = args[0];
    if (!name) return ctx.reply('§c用法: /ban <玩家名> [原因]');
    ctx.ban(name, args.slice(1).join(' ') || `被 ${ctx.sender.name} 封禁`);
    ctx.reply(`§a已封禁 ${name}`);
  },
});

cmd('unban', {
  perm: 'player.unban',
  usage: '/unban <玩家名>',
  help: '解封玩家',
  run(ctx, args) {
    if (!args[0]) return ctx.reply('§c用法: /unban <玩家名>');
    ctx.unban(args[0]);
    ctx.reply(`§a已解封 ${args[0]}`);
  },
});

cmd('op', {
  perm: 'player.op',
  usage: '/op <玩家名>',
  help: '授予 admin 角色',
  run(ctx, args) {
    const t = ctx.findPlayerByName(args[0] ?? '');
    if (!t) return ctx.reply('§c目标必须在线');
    ctx.setRole(t.uuid, ROLES.ADMIN);
    ctx.reply(`§a已授予 ${t.name} OP`);
  },
});

cmd('deop', {
  perm: 'player.op',
  usage: '/deop <玩家名>',
  help: '降级为 player 角色',
  run(ctx, args) {
    const t = ctx.findPlayerByName(args[0] ?? '');
    if (!t) return ctx.reply('§c目标必须在线');
    ctx.setRole(t.uuid, ROLES.PLAYER);
    ctx.reply(`§a已移除 ${t.name} 的 OP`);
  },
});

cmd('gamemode', {
  perm: 'player.gamemode',
  usage: '/gamemode <survival|creative|adventure|spectator> [玩家名]',
  help: '切换游戏模式',
  run(ctx, args) {
    const gm = GAMEMODE_ALIASES[(args[0] ?? '').toLowerCase()];
    if (gm === undefined) return ctx.reply('§c用法: /gamemode <survival|creative|adventure|spectator>');
    const t = args[1] ? ctx.findPlayerByName(args[1]) : { uuid: ctx.sender.uuid, name: ctx.sender.name };
    if (!t) return ctx.reply('§c目标必须在线');
    ctx.setGamemode(t.uuid, gm);
    ctx.reply(`§a已将 ${t.name} 切换为游戏模式 ${gm}`);
  },
});

/* ------------------------------ 世界/保护 ------------------------------ */

cmd('claim', {
  perm: 'claim.create',
  usage: '/claim',
  help: '认领脚下区块 (16×16)',
  run(ctx) {
    const res = ctx.claim(ctx.sender.uuid);
    ctx.reply(res.ok ? `§a已认领区块 ${res.cx},${res.cz} (拥有 ${res.owned} 块)` : `§c认领失败: ${res.reason}`);
  },
});

cmd('unclaim', {
  perm: 'claim.create',
  usage: '/unclaim',
  help: '放弃脚下区块的认领',
  run(ctx) {
    const res = ctx.unclaim(ctx.sender.uuid);
    ctx.reply(res.ok ? '§a已放弃该区块' : `§c失败: ${res.reason}`);
  },
});

cmd('claims', {
  perm: null,
  usage: '/claims',
  help: '列出我的认领',
  run(ctx) {
    const list = ctx.claimsOf(ctx.sender.uuid);
    ctx.reply(list.length ? `拥有 ${list.length} 块: ${list.join(', ')}` : '尚无认领');
  },
});

/* -------------------------------- 经济 -------------------------------- */

cmd('balance', {
  perm: null,
  usage: '/balance [玩家名]',
  help: '查询余额',
  run(ctx, args) {
    if (args[0] && hasPermission(ctx.sender, 'economy.grant')) {
      const t = ctx.findPlayerByName(args[0]);
      if (!t) return ctx.reply('§c目标必须在线');
      return ctx.reply(`${t.name} 的余额: §6${ctx.balanceOf(t.uuid)}`);
    }
    ctx.reply(`余额: §6${ctx.balanceOf(ctx.sender.uuid)}`);
  },
});

cmd('pay', {
  perm: 'economy.pay',
  usage: '/pay <玩家名> <数量>',
  help: '转账',
  run(ctx, args) {
    const t = ctx.findPlayerByName(args[0] ?? '');
    const amount = Math.floor(Number(args[1]));
    if (!t) return ctx.reply('§c目标必须在线');
    if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('§c数量必须为正整数');
    const res = ctx.pay(ctx.sender.uuid, t.uuid, amount);
    ctx.reply(res.ok ? `§a已向 ${t.name} 转账 §6${amount}` : `§c失败: ${res.reason}`);
  },
});

cmd('grant', {
  perm: 'economy.grant',
  usage: '/grant <玩家名> <数量>',
  help: '发放货币 (管理员)',
  run(ctx, args) {
    const t = ctx.findPlayerByName(args[0] ?? '');
    const amount = Math.floor(Number(args[1]));
    if (!t || !Number.isFinite(amount) || amount <= 0) return ctx.reply('§c用法: /grant <在线玩家> <正整数>');
    ctx.grant(t.uuid, amount);
    ctx.reply(`§a已向 ${t.name} 发放 §6${amount}`);
  },
});

/* -------------------------------- 服务 -------------------------------- */

cmd('say', {
  perm: 'admin.say',
  usage: '/say <消息>',
  help: '以 [服务器] 名义发言',
  run(ctx, args) {
    const msg = args.join(' ');
    if (!msg) return ctx.reply('§c用法: /say <消息>');
    ctx.broadcast(`§6[服务器] §f${msg}`);
  },
});

cmd('save', {
  perm: 'admin.save',
  usage: '/save',
  help: '立即保存本区域脏区块',
  run(ctx) {
    ctx.saveAll();
    ctx.reply('§a已触发保存 (异步批量落盘)');
  },
});

/**
 * 命令入口 (RegionDO 的 chat 处理调用)
 * @param {object} ctx  ctx 见上方约定
 * @param {string} raw  用户输入 (含 '/')
 * @returns {boolean} 是否被识别为命令 (false = 普通聊天, 交还聊天管线)
 */
export function executeCommand(ctx, raw) {
  const line = raw.trim();
  if (!line.startsWith('/')) return false;

  // 引号感知的参数切分: /say "hello world" → ['say','hello world']
  const parts = line.slice(1).match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const name = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1).map((s) => s.replace(/^"|"$/g, ''));

  const def = REGISTRY.get(name);
  if (!def) {
    ctx.reply(`§c未知命令: /${name} (输入 /help 查看)`);
    return true;
  }
  if (def.perm && !hasPermission(ctx.sender, def.perm)) {
    ctx.reply('§c权限不足');
    return true;
  }
  try {
    def.run(ctx, args);
  } catch (err) {
    ctx.reply(`§c命令执行出错: ${err.message}`);
  }
  return true;
}

/** 供 /api 或测试枚举命令清单 */
export function listCommands() {
  return [...REGISTRY.entries()].map(([name, d]) => ({ name, usage: d.usage, help: d.help, perm: d.perm }));
}
