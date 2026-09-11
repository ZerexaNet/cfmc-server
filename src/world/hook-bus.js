/**
 * ============================================================================
 * hook-bus.js — 插件事件总线 (Phase 4: 插件 API 地基)
 * ============================================================================
 * 面向未来的扩展点 (cfmc.md Phase 4 "插件/Mod API"):
 *   - RegionDO 在关键生命周期 emit 事件, 插件按需订阅
 *   - 监听器异常被隔离 (一个坏插件不能弄死游戏循环, 与 Tick 熔断同思想)
 *   - 事件即文档: emit 列表 = 插件可用的全部表面
 *
 * 用法示例见 examplePlugin()。跨 DO 的插件分发 (Phase 4+) 走 WorldManagerDO。
 */

export class HookBus {
  constructor() {
    /** 事件名 → Set<listener> */
    this.listeners = new Map();
    /** 每个 listener 的错误计数 (监控暴露) */
    this.errorCounts = new Map();
  }

  /**
   * 订阅
   * @param {string} event 事件名 (如 'player.join' / 'block.place')
   * @param {(payload: object) => (void|Promise<void>)} listener
   * @param {{name?: string}} meta 插件名 (错误归因用)
   */
  on(event, listener, meta = {}) {
    if (typeof listener !== 'function') throw new TypeError('listener 必须是函数');
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
    listener._pluginName = meta.name ?? 'anonymous';
  }

  /** 取消订阅 */
  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }

  /**
   * 触发事件 (同步快照遍历; 监听器异常隔离捕获)
   * @returns {number} 成功执行的监听器数
   */
  emit(event, payload = {}) {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return 0;
    let ok = 0;
    for (const listener of [...set]) {
      try {
        const r = listener(payload);
        // Promise 也兜住: 插件异步错误同样不冒泡
        if (r?.catch) r.catch(() => this.#countError(listener));
        ok++;
      } catch {
        this.#countError(listener);
      }
    }
    return ok;
  }

  #countError(listener) {
    const key = `${listener._pluginName ?? 'anonymous'}`;
    this.errorCounts.set(key, (this.errorCounts.get(key) ?? 0) + 1);
  }

  /** 调试/监控: 当前注册表 */
  describe() {
    return [...this.listeners.entries()].map(([event, set]) => ({
      event,
      listeners: [...set].map((l) => l._pluginName ?? 'anonymous'),
    }));
  }
}

/**
 * 示例插件: 玩家进服欢迎 + 放方块计数 (演示 on/emit 用法, 可直接启用)
 */
export function examplePlugin(bus) {
  const state = { joins: 0, places: 0 };
  bus.on('player.join', ({ name }) => {
    state.joins++;
  }, { name: 'example-welcome' });
  bus.on('block.place', () => {
    state.places++;
  }, { name: 'example-welcome' });
  return {
    name: 'example-welcome',
    stats: () => ({ ...state }),
  };
}
