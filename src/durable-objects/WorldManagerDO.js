/**
 * ============================================================================
 * WorldManagerDO — 世界协调者 (全局单例) v1.0 (Phase 2/3)
 * ============================================================================
 *
 * 定位: 全服唯一实例 (env.WORLD_MANAGER.idFromName("singleton"))。
 * "需要跨 Region 一致视图" 的事情全部收敛到这: 路由表 / 在线注册表 /
 * 封禁缓存 / 维护开关 / 全服统计 / 告警节流 / 全服广播扇出。
 *
 * 本版实现:
 *   [P2] 玩家路由表: uuid → {region,name,lastSeenAt}, DO Storage 持久化 (防抖)
 *   [P2] GET /route?uuid → 上次所在区域 (断线重连的数据基础)
 *   [P3] 封禁缓存: D1 bans 表的内存副本 (60s TTL), 路由前拦截
 *   [P3] 维护模式: 开启后新连接被 game.js 拒绝 (管理员除外)
 *   [P3] 全服统计: 区域数/在线分布/tick 溢出计数 → /stats (API 面板数据源)
 *   [P3] 告警: POST /alert → 节流转发到 env.ALERT_WEBHOOK_URL (Secret)
 *   [P3] 全服广播: POST /broadcast → 扇出到所有活跃 RegionDO 的 /say
 *   [P4] 多维度: region 键扩展为 "维度:x,z" (game.js 已透传维度参数)
 *
 * 热点规避: 本 DO 只存低频元数据; 高频 (方块/实体) 永远留在 RegionDO。
 */

const ROUTES_STORAGE_KEY = 'playerRoutes';
const ROUTES_FLUSH_MS = 5000; // 路由表落盘防抖

export class WorldManagerDO {
  /** @param {DurableObjectState} state @param {Env} env */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.config = env.ENVIRONMENT ?? 'development';

    /** uuid → { region, name, joinedAt, lastSeenAt } */
    this.playerRoutes = new Map();
    /** 路由表落盘防抖定时器 */
    this.flushTimer = null;

    /** 维护模式 (内存即可: DO 重启后默认关闭是安全侧) */
    this.maintenance = false;
    /** DO 启动时间 (运行时长统计) */
    this.startedAt = Date.now();
    /** 全局计数 (RegionDO /report 汇总) */
    this.metrics = { tickOverruns: 0, kicks: 0, bans: 0 };

    /** 封禁缓存: Set<uuid 或 小写name> + 时间戳 */
    this.banCache = new Set();
    this.banCacheAt = 0;
    /** 同级别告警节流: level → lastSentAt */
    this.alertThrottle = new Map();
  }

  /* ==========================================================================
   * HTTP 面 (Worker/RegionDO/面板 经 stub.fetch 调用)
   * ======================================================================== */
  async fetch(request) {
    const url = new URL(request.url);

    try {
      await this.#ensureLoaded();

      switch (true) {
        /* ---- 状态 (调试) ---- */
        case url.pathname === '/status':
          return Response.json({ ok: true, role: 'WorldManagerDO', routes: this.playerRoutes.size, maintenance: this.maintenance, metrics: this.metrics });

        /* ---- [P2] 路由解析: 上次区域优先 ---- */
        case url.pathname === '/route': {
          const uuid = url.searchParams.get('uuid') ?? '';
          const r = this.playerRoutes.get(uuid);
          return Response.json({ ok: true, region: r?.region ?? null, name: r?.name ?? null });
        }

        /* ---- [P2] RegionDO 上报进入/离开 ---- */
        case url.pathname === '/register' && request.method === 'POST': {
          const { uuid, name, region } = await request.json();
          this.playerRoutes.set(uuid, { region, name: name ?? '', joinedAt: Date.now(), lastSeenAt: Date.now() });
          this.#scheduleFlush();
          return Response.json({ ok: true, online: this.playerRoutes.size });
        }
        case url.pathname === '/unregister' && request.method === 'POST': {
          const { uuid } = await request.json();
          const r = this.playerRoutes.get(uuid);
          if (r) r.lastSeenAt = Date.now(); // 保留路由 (断线重连用), 只标记离开时间
          this.#scheduleFlush();
          return Response.json({ ok: true });
        }

        /* ---- [P3] 在线列表 (API 面板) ---- */
        case url.pathname === '/online':
          return Response.json({
            ok: true,
            online: [...this.playerRoutes.entries()].map(([uuid, r]) => ({ uuid, ...r })),
          });

        /* ---- [P3] 封禁 ---- */
        case url.pathname === '/banned': {
          await this.#ensureBanCache();
          const uuid = (url.searchParams.get('uuid') ?? '').toLowerCase();
          const name = (url.searchParams.get('name') ?? '').toLowerCase();
          return Response.json({ ok: true, banned: this.banCache.has(uuid) || this.banCache.has(name) });
        }
        case url.pathname === '/bans' && request.method === 'GET':
          return Response.json(await this.#loadBansFromD1());
        case url.pathname === '/ban' && request.method === 'POST': {
          const { name, uuid, reason, by } = await request.json();
          await this.#addBan({ name, uuid, reason, by });
          return Response.json({ ok: true });
        }
        case url.pathname === '/unban' && request.method === 'POST': {
          const { name } = await request.json();
          await this.#removeBan(name);
          return Response.json({ ok: true });
        }

        /* ---- [P3] 维护模式 ---- */
        case url.pathname === '/maintenance' && request.method === 'GET':
          return Response.json({ ok: true, maintenance: this.maintenance });
        case url.pathname === '/maintenance' && request.method === 'POST': {
          const { enabled } = await request.json();
          this.maintenance = !!enabled;
          return Response.json({ ok: true, maintenance: this.maintenance });
        }

        /* ---- [P3] 统计 (API 面板) ---- */
        case url.pathname === '/stats':
          return Response.json({
            ok: true,
            online: this.playerRoutes.size,
            regions: [...new Set([...this.playerRoutes.values()].map((r) => r.region))].length,
            uptimeMs: Date.now() - this.startedAt,
            metrics: this.metrics,
            maintenance: this.maintenance,
          });

        /* ---- [P3] 告警 (RegionDO tick 溢出/异常上报) ---- */
        case url.pathname === '/alert' && request.method === 'POST': {
          const { level, message, source } = await request.json();
          await this.#sendAlert(level, message, source);
          return Response.json({ ok: true });
        }

        /* ---- [P3] 全服广播扇出 ---- */
        case url.pathname === '/broadcast' && request.method === 'POST': {
          const { message } = await request.json();
          const delivered = await this.#broadcastAll(message);
          return Response.json({ ok: true, delivered });
        }

        /* ---- [P3] 指标上报 (RegionDO 周期性) ---- */
        case url.pathname === '/report' && request.method === 'POST': {
          const { tickOverruns = 0, kicks = 0 } = await request.json();
          this.metrics.tickOverruns += tickOverruns;
          this.metrics.kicks += kicks;
          return Response.json({ ok: true });
        }

        default:
          return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 });
      }
    } catch (err) {
      return Response.json({ ok: false, code: 'INTERNAL_ERROR', message: err.message }, { status: 500 });
    }
  }

  /* ==========================================================================
   * 内部实现
   * ======================================================================== */

  /** 路由表落盘 (防抖: register/unregister 风暴只写一次) */
  #scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const entries = [...this.playerRoutes.entries()];
      this.state.storage.put(ROUTES_STORAGE_KEY, entries).catch(() => {});
    }, ROUTES_FLUSH_MS);
  }

  /** 启动恢复 (lazy: 首次访问时加载) */
  async #ensureLoaded() {
    if (this.#loaded) return;
    this.#loaded = true;
    const saved = await this.state.storage.get(ROUTES_STORAGE_KEY);
    if (Array.isArray(saved)) this.playerRoutes = new Map(saved);
  }

  #loaded = false;

  /** 从 D1 加载封禁 (60s 缓存) */
  async #ensureBanCache() {
    if (Date.now() - this.banCacheAt < 60_000) return;
    this.banCacheAt = Date.now();
    this.banCache.clear();
    try {
      const { results } = await this.env.USERS_DB.prepare('SELECT uuid, name FROM bans WHERE expires_at IS NULL OR expires_at > ?').bind(Date.now()).all();
      for (const row of results ?? []) {
        if (row.uuid) this.banCache.add(String(row.uuid).toLowerCase());
        if (row.name) this.banCache.add(String(row.name).toLowerCase());
      }
    } catch {
      // 表不存在 (未跑迁移) → 空缓存, 不阻塞登录
    }
  }

  async #loadBansFromD1() {
    try {
      const { results } = await this.env.USERS_DB.prepare('SELECT id, name, uuid, reason, by_name, created_at, expires_at FROM bans ORDER BY id DESC LIMIT 200').all();
      return { ok: true, bans: results ?? [] };
    } catch (err) {
      return { ok: false, bans: [], message: err.message };
    }
  }

  async #addBan({ name, uuid, reason, by }) {
    await this.env.USERS_DB.prepare('INSERT INTO bans (name, uuid, reason, by_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL)')
      .bind(name ?? null, uuid ?? null, reason ?? '', by ?? 'system', Date.now()).run();
    if (name) this.banCache.add(name.toLowerCase());
    if (uuid) this.banCache.add(uuid.toLowerCase());
    this.metrics.bans++;
    // 顺手把该玩家记录到路由表 → 全服踢出由面板/命令层对 RegionDO 逐个调用
  }

  async #removeBan(name) {
    await this.env.USERS_DB.prepare('DELETE FROM bans WHERE lower(name) = lower(?)').bind(name ?? '').run();
    this.banCache.delete((name ?? '').toLowerCase());
    this.banCacheAt = 0; // 强制下次全量刷新
  }

  /** 告警: 同级节流 → webhook (Secret ALERT_WEBHOOK_URL, 可选) */
  async #sendAlert(level, message, source) {
    const key = `${level}`;
    const last = this.alertThrottle.get(key) ?? 0;
    const throttle = Number(this.env.ALERT_THROTTLE_MS ?? 60_000);
    if (Date.now() - last < throttle) return;
    this.alertThrottle.set(key, Date.now());

    console.error(JSON.stringify({ level: 'alert', alertLevel: level, message, source, at: Date.now() }));
    const hook = this.env.ALERT_WEBHOOK_URL;
    if (!hook) return;
    try {
      await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `[CFMC ${level}] ${source ?? 'world'}: ${message}` }),
      });
    } catch { /* 告警失败不影响游戏 */ }
  }

  /** 扇出广播到所有活跃 Region (region stub 的 /say 端点) */
  async #broadcastAll(message) {
    const regions = new Set([...this.playerRoutes.values()].map((r) => r.region).filter(Boolean));
    let delivered = 0;
    await Promise.allSettled(
      [...regions].map(async (regionKey) => {
        // region 键格式: [dim:]x,z (P4 多维度)
        const stub = this.env.REGION.get(this.env.REGION.idFromName(`region:${regionKey}`));
        const res = await stub.fetch('https://do/say', {
          method: 'POST',
          body: JSON.stringify({ message }),
        });
        if (res.ok) delivered++;
      })
    );
    return delivered;
  }
}
