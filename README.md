# CFMC-Edge Server

> Cloudflare Minecraft Edge Server — 在 Cloudflare 全球边缘网络上运行的纯 Serverless Minecraft 服务器。

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Phase](https://img.shields.io/badge/Phase-2__core-green)](#开发路线图)
[![Protocol](https://img.shields.io/badge/Protocol-v1-green)](src/protocol/packet-definitions.js)

配套客户端 Mod: [cfmc-client](https://github.com/ZerexaNet/cfmc-client) (Fabric/NeoForge)

> **部署指南**: [DEPLOYMENT.md](DEPLOYMENT.md) —— 从零到上线的完整手册（资源初始化、Secrets、运维、故障排查）

---

## 项目简介

CFMC-Edge 使用 **Durable Objects 作为区域游戏引擎**、**D1 (类 Cesium 的 SQLite 格式) 存储地图数据**，通过**自定义 WebSocket 二进制协议**与安装了 cfmc-client Mod 的原版客户端通信。

| 特性 | 说明 |
|------|------|
| 零基础设施管理 | 无需 VPS，全部运行在 Cloudflare 上，`wrangler deploy` 即上线 |
| 全球低延迟 | 300+ 边缘节点自动就近接入，玩家连最近的数据中心 |
| 无限水平扩展 | 每个区块柱 (16×16) 一个 RegionDO，实例数无上限、按需创建销毁 |
| SQL 化地图存储 | 类 Cesium 格式 (调色板+Zstd)，替代传统 `.mca`，支持 SQL 审计查询 |
| 零闲置成本 | Hibernation API + Alarm 休眠：没人玩的区域 DO 自动休眠，零计费 |
| 多模式认证 | 正版 / 离线 / 自定义皮肤站 (Yggdrasil) / 混合模式 |

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     客户端层 (Client)                         │
│   CFMC-Client Mod: WebSocket替换TCP + 自定义协议 + 客户端预测   │
└──────────────────────────┬──────────────────────────────────┘
                           │ WebSocket (WSS)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Cloudflare Edge Layer                       │
│                                                              │
│   Gateway Worker (本仓库 src/index.js)                        │
│   • TLS终止 • 路由分发 • 限流/WAF • CORS • 结构化日志           │
│        │              │                │                     │
│        ▼              ▼                ▼                     │
│   Auth Worker     Game Worker      API Worker                │
│   (四种认证)      (WS→Region路由)   (RESTful, Phase 3)        │
│                       │                                      │
│                       ▼                                      │
│   ┌─────────────────────────────────────────────┐            │
│   │ Durable Objects 层                           │            │
│   │  WorldManagerDO (单例协调者: 路由表/在线状态)   │            │
│   │  RegionDO Cluster (无限实例! 每区块柱一个)      │            │
│   │   • Alarm驱动20TPS Tick • 内置SQLite/D1      │            │
│   │   • Hibernation WS连接池 • 差量同步广播        │            │
│   │  ChatDO (全服聊天, 独立于Tick预算)             │            │
│   └──────────────────┬──────────────────────────┘            │
│                      ▼                                       │
│   D1: cfmc-world (Cesium地图)   D1: cfmc-users (账号)         │
│   KV: CACHE (会话/皮肤缓存)     R2: BACKUPS (备份归档)         │
└─────────────────────────────────────────────────────────────┘
```

## 快速开始

### 前置要求

- Node.js ≥ 18
- Cloudflare 账号（本地开发不需要，远端部署需要）

### 1. 安装依赖

```bash
npm install
```

### 2. 初始化数据库（本地开发可跳过）

```bash
# 方式 A: 本地模式 (miniflare 模拟库, 无需 Cloudflare 账号)
npm run init:d1:local

# 方式 B: 远端模式 (创建真实 D1 库并自动回填 wrangler.toml)
npm run init:d1
# 然后手动补 KV:
npx wrangler kv namespace create CACHE   # 把输出的 id 填入 wrangler.toml
```

### 3. 启动本地开发

```bash
npm run dev
# → http://localhost:8787
```

### 4. 验证

```bash
# 健康检查
curl http://localhost:8787/health
# → {"status":"ok","colo":"...","timestamp":...}

# 服务信息 (客户端 Mod 的服务发现端点)
curl http://localhost:8787/
```

**WebSocket 连通性测试**（浏览器 DevTools Console）：

```javascript
// Phase 1 验收标准: 两个标签页各开一个 WS, 即可互发聊天
const ws = new WebSocket("ws://localhost:8787/ws/game?uuid=test-1&name=Alice");
ws.onmessage = (e) => console.log("收到:", e.data);
ws.onopen = () => ws.send(JSON.stringify({ type: "chat", msg: "hello" }));
```

### 5. 部署

```bash
wrangler login
npm run deploy
```

> 上线完整流程（KV/R2/Queue 初始化、Secrets 配置、域名绑定、运维与回滚）见 **[DEPLOYMENT.md](DEPLOYMENT.md)**。

## 目录结构

```
cfmc-server/
├── src/
│   ├── index.js                     # Gateway Worker 入口: 路由 + DO导出
│   ├── workers/
│   │   ├── gateway.js               # 中间件: CORS / Logger / RateLimiter
│   │   ├── auth.js                  # Auth Worker: 四种认证模式 + 双Token
│   │   └── game.js                  # WS会话管理: JWT验证 + Region路由
│   ├── durable-objects/
│   │   ├── WorldManagerDO.js        # 世界协调者 (单例): 路由表 [存根→Phase 2]
│   │   ├── RegionDO.js              # 区域游戏引擎 v0.1 (核心!)
│   │   │   • Alarm驱动20TPS Tick循环 (40ms CPU熔断)
│   │   │   • Hibernation WS池 + 心跳检测
│   │   │   • 区块LRU缓存 / 超平坦生成 / 调色板方块读写
│   │   │   • 每100tick D1.batch原子持久化 + 审计日志
│   │   └── ChatDO.js                # 全服聊天 [简单广播可用]
│   ├── protocol/
│   │   ├── packet-definitions.js    # 包ID注册表 + 帧格式 + Flags位域
│   │   ├── packet-reader.js         # 二进制解码器 (VarInt/VarLong/BE标量)
│   │   ├── packet-writer.js         # 二进制编码器 + 帧封装 + 多包合并
│   │   └── compression.js           # deflate-raw (Java nowrap 兼容)
│   ├── storage/
│   │   ├── cesium-schema.sql        # 地图库 DDL (Cesium格式)
│   │   ├── users-schema.sql         # 账号库 DDL
│   │   ├── cesium-reader.js         # 区块加载 + LongArray解码
│   │   └── cesium-writer.js         # 脏区块UPSERT/变更日志/玩家存档
│   ├── auth/
│   │   ├── mojang-api.js            # Mojang hasJoined/档案/纹理解码
│   │   ├── skin-server.js           # Yggdrasil皮肤站客户端
│   │   ├── offline-uuid.js          # 纯JS MD5 → Java兼容离线UUID
│   │   └── jwt-handler.js           # HS256 JWT签发/验证 (Web Crypto)
│   ├── utils/
│   │   ├── constants.js             # 方块/实体/维度常量 + 配置解析
│   │   ├── logger.js                # 结构化JSON日志
│   │   └── math3d.js                # Vec3/AABB/坐标换算
│   └── config/                      # [TODO] Phase 3
├── scripts/
│   ├── init-d1.sh                   # D1 建库/建表/回填配置 (幂等)
│   └── import-world.sh              # [TODO Phase 2] Anvil→Cesium 导入
├── tests/
│   └── unit/
│       ├── protocol.test.js         # VarInt/帧/LongArray往返
│       └── auth.test.js             # MD5向量/离线UUID/JWT
├── wrangler.toml                    # Cloudflare 配置 (全部绑定)
├── vitest.config.mts
├── package.json
└── README.md
```

## WebSocket 接入协议（当前版）

`GET /ws/game?region={x},{z}&uuid={playerUUID}&name={playerName}`

- 请求头 `Authorization: Bearer <JWT>` 可选（带上则走 JWT 验证；Phase 1 调试可用查询参数自报身份）
- 升级成功后进入**二进制协议帧**模式（帧格式见 [`src/protocol/packet-definitions.js`](src/protocol/packet-definitions.js)），同时保留 JSON 文本通道供浏览器调试

### 认证端点（auth.js）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/auth/login` | POST | `{username, password?, serverId?, mode?}` → `{accessToken, refreshToken, profile}` |
| `/auth/refresh` | POST | `{refreshToken}` → 轮换新双Token |
| `/auth/validate` | POST | `{accessToken}` → 校验（401=无效/过期） |
| `/auth/invalidate` | POST | `{refreshToken}` → 吊销（幂等） |
| `/auth/skins/:uuid` | GET | 皮肤纹理解析（本地缓存 → Mojang回源） |

密钥配置：`wrangler secret put AUTH_JWT_SECRET`（本地开发在 `.dev.vars` 写 `AUTH_JWT_SECRET=xxx`，未配置时回退到不安全 dev 密钥并打警告）

## 全协议支持（v2 核心）

服务端**不锁死 MC 版本**：1.8 ~ 1.21.8 任意版本的 CFMC Mod 客户端均可接入。

### 实现原理

```
客户端 Mod (任意 MC 版本)
   │  ① ClientHandshake v2: cfmcProto=2 + mcVersion("1.20.4") + mcProto(763)
   ▼
version-registry.js ── 识别协议号 → 版本族 (legacy/flat/modern)
   ▼
version-adapters.js ── 绑定适配器: 版本语义收敛点 (方块名规范化/能力协商/旧名映射)
   ▼
RegionDO (版本无关) ── 存储层以方块名字符串为主键, 线上协议与 MC 版本解耦
```

| 版本族 | 覆盖版本 | 特点处理 |
|--------|---------|---------|
| `legacy` | 1.8 ~ 1.12.2 (proto 47–340) | legacy 聊天码、高度 [0,256)、旧方块名映射 (grass_block→grass) |
| `flat` | 1.13 ~ 1.20.1 (proto 393–763) | 字符串方块 ID、JSON 文本、高度 [-64,320) |
| `modern` | 1.20.2+ (proto 764+) | 与 CFMC v2 同期设计, 无历史包袱 |
| `generic` | 未上报/未知协议号 | 兜底: 浏览器调试、v1 老客户端 |

### v2 协议变更（相对 v1）

| 变更 | 原因 |
|------|------|
| `BlockPlace`/`BlockUpdate`: stateId(VarInt) → blockName(String) | 数字 ID 跨版本不稳定，名字跨版本恒定 |
| `ChunkData` 调色板: numeric ID → 名字符串 | 客户端各版本用自己的注册表解析 |
| `ClientHandshake`/`HandshakeAck` 尾部追加版本字段 | 向后兼容追加，旧端读到旧字段长度即停 |

**加新 MC 版本 = 在 [`version-registry.js`](src/protocol/version-registry.js) 的 `MC_PROTOCOLS` 表加一行**，无其它代码改动。

## 开发路线图

### ✅ Phase 1 骨架（已完成）

- [x] Gateway Worker：路由 + CORS + 限流 + 结构化日志
- [x] 三个 Durable Object（可 `wrangler dev` 直接运行）
- [x] 完整协议包 ID 注册表定义（0x01–0x1F）
- [x] D1 双库 Schema（Cesium 地图格式 + 账号库）
- [x] `init-d1.sh` 初始化脚本（建库/建表/回填配置）

### 🔜 Phase 2 核心功能（当前进行中）

- [x] Auth Worker：四种认证模式 + JWT 双Token（**已完成**）
- [x] RegionDO v0.1：Alarm 驱动 20TPS Tick 循环 + 内存优先 + 批量持久化（**已完成**）
- [x] 二进制协议编解码：VarInt / 帧 / 调色板 LongArray（**已完成，含单测**）
- [x] Cesium 格式区块加载/保存 + 超平坦生成（**已完成**）
- [x] 全协议支持 v2：版本注册表 + 适配器 + 方块名版本中立化（**已完成**，1.8~1.21.8）
- [ ] 3D 世界可见、移动同步、方块放置/破坏、基础物理（客户端侧）
- [ ] 客户端预测 + 服务端校正
- [ ] Anvil 世界导入工具（cesium-migrator）

### 🡒 Phase 3 生产化（Week 7-10）

权限系统 / 反作弊 / 管理命令 / 背包同步 / 断线重连 / Web 管理面板 / 监控告警

### 🡒 Phase 4 功能扩展（Week 11+）

怪物 AI / 红石 / 经济系统 / 多维度 / Workers AI NPC / 插件 API

## 性能基准目标

| 指标 | Free Plan | Paid Plan | 备注 |
|------|-----------|-----------|------|
| 同时在线玩家 | 10-20 | 50-100 | 取决于复杂度 |
| TPS 稳定性 | ≥18 (允许偶降 15) | ≥19 | 目标 20 |
| P99 延迟 (玩家移动) | <200ms | <100ms | 含网络传输 |
| 区块加载时间 | <500ms | <200ms | 首次加载 |
| DO 内存占用 | <80MB | <100MB | per Region |
| D1 存储用量 | <3GB | <10GB | Cesium 压缩后 |

## 重要设计约束（给贡献者）

1. **内存优先**：热数据全在内存（Map/Set），Storage/D1 只做低频批量持久化（每 100 tick 一次），DO 读配额是稀缺资源
2. **单 tick CPU < 40ms**：超预算必须熔断剩余逻辑，绝不能卡死 Tick 循环
3. **协议变更需同步两端**：修改 `packet-definitions.js` 必须同步 cfmc-client 并递增 `PROTOCOL_VERSION`
4. **离线 UUID 算法必须与 Java 逐字节一致**（`nameUUIDFromBytes("OfflinePlayer:"+name)`，MD5 + v3 位）
5. **所有公开方法 async**：DO 内任何同步阻塞都会拖垮整个实例的事件循环
6. **错误不能终止 Tick**：网络不稳定是常态，单玩家/单实体的异常必须被隔离捕获

## License

Apache-2.0
