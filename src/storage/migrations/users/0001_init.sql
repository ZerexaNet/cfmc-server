-- =============================================================
-- CFMC-Edge Users Database Schema (wrangler 标准迁移 0001)
-- 应用: wrangler d1 migrations apply USERS_DB --remote
--       (npm run deploy 会自动执行; 语句全幂等, 可安全重跑)
-- -------------------------------------------------------------
-- 与 world 库分离的原因 (设计决策):
--   1. 备份节奏不同: 玩家数据要频繁备份且绝不能回滚; 世界数据按天备份
--   2. 访问模式不同: Auth Worker 高频读写 users; RegionDO 只碰 world
--      分库后互不争锁
--   3. 配额独立: D1 计费/容量按库计算, 世界数据膨胀不影响认证库性能
--
-- TODO(子提示词2): Auth Worker 实现时可能补充 oauth_state / bans 表
-- =============================================================

-- -------------------------------------------------------------
-- 用户账号表
-- uuid: online = Mojang UUID; offline/skin_server = nameUUIDFromBytes 离线UUID
--       (算法必须与 Java 完全一致! 见 cfmc.md 离线UUID小节)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    uuid          TEXT PRIMARY KEY,      -- 无横杠小写格式 (对齐 Mojang API)
    name          TEXT NOT NULL,
    name_lower    TEXT NOT NULL,         -- 查询用小写副本 (SQLite 默认大小写敏感)
    auth_mode     TEXT NOT NULL,         -- online / offline / skin_server / hybrid
    skin_server   TEXT,                  -- 皮肤站来源 URL (skin_server 模式)
    skin_url      TEXT,                  -- 缓存的皮肤纹理 URL (省一次解码)
    skin_model    TEXT,                  -- slim(Alex) / wide(Steve)
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER,
    login_count   INTEGER DEFAULT 0,
    UNIQUE (name_lower)
);
CREATE INDEX IF NOT EXISTS idx_users_name ON users (name_lower);

-- -------------------------------------------------------------
-- 玩家游戏状态 (RegionDO 每 60s 批量保存, cfmc.md savePlayerStates)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_data (
    uuid          TEXT PRIMARY KEY,
    name          TEXT NOT NULL,

    -- 位置与姿态 (最后一已知位置 → 断线重连恢复)
    world         TEXT DEFAULT 'overworld',
    x             REAL DEFAULT 0,
    y             REAL DEFAULT -60,
    z             REAL DEFAULT 0,
    yaw           REAL DEFAULT 0,
    pitch         REAL DEFAULT 0,

    gamemode      INTEGER DEFAULT 0,     -- survival
    health        REAL DEFAULT 20,
    food          INTEGER DEFAULT 20,
    xp_level      INTEGER DEFAULT 0,
    xp_progress   REAL DEFAULT 0,

    -- 物品栏: JSON 序列化的 36格+装备+副手 (Phase 3 完整背包同步)
    inventory     TEXT,

    -- Phase 3/4: 角色 (player/moderator/admin) 与 金币 (经济系统)
    role          TEXT NOT NULL DEFAULT 'player',
    coins         INTEGER NOT NULL DEFAULT 100,

    -- 最后活跃: 用于"7天不活跃清临时实体"等清理任务
    last_seen_at  INTEGER NOT NULL,

    FOREIGN KEY (uuid) REFERENCES users (uuid)
);
CREATE INDEX IF NOT EXISTS idx_player_data_seen ON player_data (last_seen_at);

-- -------------------------------------------------------------
-- [Phase 3] 封禁表: WorldManagerDO 缓存 + 路由前拦截
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT,
    uuid       TEXT,
    reason     TEXT NOT NULL DEFAULT '',
    by_name    TEXT NOT NULL DEFAULT 'system',
    created_at INTEGER NOT NULL,
    expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bans_name ON bans (name);
CREATE INDEX IF NOT EXISTS idx_bans_uuid ON bans (uuid);

-- -------------------------------------------------------------
-- [Phase 3] 聊天历史 (ChatDO 批量落库, Web 面板审计)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    from_name TEXT NOT NULL,
    from_uuid TEXT,
    channel   TEXT NOT NULL DEFAULT 'global',
    to_uuid   TEXT,
    message   TEXT NOT NULL,
    at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_history_at ON chat_history (at);

-- -------------------------------------------------------------
-- 会话记录 (登录审计; Token 本体存 KV, 这里只留审计痕迹)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid       TEXT,
    name       TEXT,
    ip         TEXT,                      -- CF-Connecting-IP
    auth_mode  TEXT,
    success    INTEGER NOT NULL,          -- 1=成功 0=失败
    fail_reason TEXT,                     -- INVALID_TOKEN / MOJANG_REJECT / ...
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_uuid ON login_audit (uuid);
CREATE INDEX IF NOT EXISTS idx_audit_time ON login_audit (created_at);
