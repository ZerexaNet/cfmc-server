-- =============================================================
-- CFMC-Edge 迁移脚本 002 — Phase 3 生产化 + Phase 4 功能扩展
-- -------------------------------------------------------------
-- 应用方式 (幂等, 只加列/加表不破坏旧数据):
--   wrangler d1 execute cfmc-users --remote --file=src/storage/migrations/002-phase3-p4.sql -y
--   wrangler d1 execute cfmc-world --remote --file=src/storage/migrations/002-phase3-p4.sql -y
-- (SQLite 无 ADD COLUMN IF NOT EXISTS, 重复执行会报 duplicate column —— 属预期, 忽略即可;
--  新装环境直接跑 users-schema.sql / cesium-schema.sql, 已包含全部结构)
-- =============================================================

-- ============ cfmc-users 库 ============

-- 玩家角色 (P3 权限系统) 与 金币 (P4 经济)
ALTER TABLE player_data ADD COLUMN role  TEXT NOT NULL DEFAULT 'player';
ALTER TABLE player_data ADD COLUMN coins INTEGER NOT NULL DEFAULT 100;

-- 封禁表 (P3): name/uuid 至少一项; expires_at NULL = 永久
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

-- 聊天历史 (P3): ChatDO 5s 批量落库, 面板审计用
CREATE TABLE IF NOT EXISTS chat_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    from_name TEXT NOT NULL,
    from_uuid TEXT,
    channel   TEXT NOT NULL DEFAULT 'global',  -- global / private / region
    to_uuid   TEXT,
    message   TEXT NOT NULL,
    at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_history_at ON chat_history (at);

-- ============ cfmc-world 库 ============

-- 土地认领 (P4): 区块级保护, RegionDO 内存快照 + 写穿透
CREATE TABLE IF NOT EXISTS chunk_claims (
    chunk_x    INTEGER NOT NULL,
    chunk_z    INTEGER NOT NULL,
    owner_uuid TEXT NOT NULL,
    owner_name TEXT NOT NULL DEFAULT '',
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (chunk_x, chunk_z)
);
