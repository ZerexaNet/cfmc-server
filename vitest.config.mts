// Vitest 配置 —— Cloudflare Workers 官方测试池
// ------------------------------------------------------------
// 为什么用 @cloudflare/vitest-pool-workers 而不是普通 node 环境:
//   DO/Alarm/WebSocketPair 等平台 API 只在 workersd 运行时存在,
//   普通环境下连 RegionDO 都无法实例化。
// passWithNoTests: 骨架阶段测试文件为空, 不让 CI 红灯 (TODO: 单元测试)
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    passWithNoTests: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        // 单元测试阶段先不起 DO 绑定; 集成测试 (Phase 2) 再启用 main 模块
      },
    },
  },
});
