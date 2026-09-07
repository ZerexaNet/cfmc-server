-- =============================================================
-- CFMC-Edge World Database (Cesium-Compatible Schema)
-- 应用到: wrangler d1 execute cfmc-world --file=src/storage/cesium-schema.sql
-- -------------------------------------------------------------
-- 基于 Cesium-Fabric 项目的设计思路: 用 SQLite(D1) 替代传统 Anvil .mca
--
-- 为什么放弃 Anvil 格式 (设计决策, cfmc.md 详述):
--   Anvil:  非原子写入 (崩溃损坏风险) / GZip 压缩率低 / 无法SQL查询 / 并发需外部锁
--   Cesium: ACID 事务 / Zstd 高压缩 (小30-50%) / SQL 可查 / MVCC 并发安全
--
-- 与原版存档的关系:
--   本 Schema 是"运行时格式"。Anvil 世界通过 cesium-migrator.js 导入
--   (TODO Phase 2, 见 scripts/import-world.sh)。
--
-- 性能要点:
--   - chunk_sections 按 (chunk_x, chunk_z, section_y) 主键查询, 点查 O(1)
--   - dirty_count 部分索引: RegionDO 每 5s 批量持久化只扫"脏"行
--   - block_change_log 单独成表: 审计/回滚/反作弊, 不拖慢主查询路径
-- =============================================================

-- -------------------------------------------------------------
-- 世界元数据 (KV 语义: 种子/出生点/时间/天气)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS world_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    -- 毫秒时间戳 (SQLite DEFAULT 必须是括号包裹的完整表达式, 否则解析报错)
    updated_at INTEGER DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);
-- 约定键: version / generator / seed / spawn_x / spawn_y / spawn_z /
--         time / is_raining / is_thundering / rain_time / thunder_time
INSERT OR IGNORE INTO world_meta (key, value) VALUES
    ('version',   '1'),
    ('generator', 'minecraft:flat'),   -- 骨架阶段用超平坦; Phase 2 切 noise 生成器
    ('seed',      '0'),                -- init 后由管理命令写入真实种子
    ('spawn_x',   '0'),
    ('spawn_y',   '-60'),
    ('spawn_z',   '0'),
    ('time',      '6000');             -- 正午

-- -------------------------------------------------------------
-- 区块索引 (16×16 柱级元数据 + 状态标志)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
    chunk_x         INTEGER NOT NULL,
    chunk_z         INTEGER NOT NULL,

    -- 生成管线状态 (原版三阶段: generate → populate → light)
    is_generated    INTEGER DEFAULT 0,  -- 是否已生成地形
    is_populated    INTEGER DEFAULT 0,  -- 是否已装饰 (树/矿洞)
    is_light_updated INTEGER DEFAULT 0, -- 光照是否计算完毕

    -- 脏计数: >0 表示有待持久化修改; RegionDO 的 Alarm 每5s批量落库
    dirty_count     INTEGER DEFAULT 0,

    -- 高度图: 16×16 Int16 (每列最高非空气Y), 加速碰撞检测与光照
    height_map      BLOB,

    created_at      INTEGER,
    last_modified   INTEGER,

    PRIMARY KEY (chunk_x, chunk_z)
);

-- -------------------------------------------------------------
-- 核心! Section 数据 (每个 16³ 方块段)
-- 调色板 + 压缩索引 = Cesium 格式精髓, 对应 ChunkData 包的 sections[]
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunk_sections (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_x   INTEGER NOT NULL,
    chunk_z   INTEGER NOT NULL,
    section_y INTEGER NOT NULL,  -- -4..19 对应 Y=-64..384

    -- 调色板: 本 Section 出现的方块状态ID去重表 (JSON 数组)
    -- 例: [{"id":1,"name":"minecraft:stone"},{"id":8,"name":"minecraft:grass_block"}]
    palette_data TEXT NOT NULL,
    palette_hash TEXT,             -- 调色板MD5: 相同则跳过重写, 省写配额

    -- 方块索引: Zstd 压缩的 LongArray
    -- 每个方块占 ceil(log2(palette大小)) 位, 4096 个索引打包进 64bit 长整型
    block_indices_compressed BLOB NOT NULL,

    -- 光照 (各 2048 字节 = 4096 半字节; 可延迟加载)
    sky_light   BLOB,
    block_light BLOB,

    -- 非空气方块数: 0 → 整段可跳过传输与渲染 (空Section优化)
    non_air_blocks INTEGER DEFAULT 0,

    -- 数据版本: schema 演进时做迁移判断
    data_version INTEGER DEFAULT 1,

    FOREIGN KEY (chunk_x, chunk_z) REFERENCES chunks (chunk_x, chunk_z),
    UNIQUE (chunk_x, chunk_z, section_y)
);

-- 点查索引: getOrLoadChunk 的 WHERE 条件
CREATE INDEX IF NOT EXISTS idx_section_location
    ON chunk_sections (chunk_x, chunk_z, section_y);

-- -------------------------------------------------------------
-- TileEntity (带额外数据的方块: 箱子/熔炉/告示牌/刷怪笼...)
-- data 为 JSON 形式的 NBT 等效物 (D1 不存二进制 NBT, JSON 便于 Workers 直接读写)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tile_entities (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_x INTEGER NOT NULL,
    chunk_z INTEGER NOT NULL,
    x       INTEGER NOT NULL,   -- 世界绝对坐标
    y       INTEGER NOT NULL,
    z       INTEGER NOT NULL,
    type    TEXT NOT NULL,      -- minecraft:chest / furnace / sign ...
    data    TEXT NOT NULL,      -- JSON (NBT 等效)

    FOREIGN KEY (chunk_x, chunk_z) REFERENCES chunks (chunk_x, chunk_z)
);
CREATE INDEX IF NOT EXISTS idx_te_position ON tile_entities (chunk_x, chunk_z);

-- -------------------------------------------------------------
-- 实体表 (玩家状态由 users 库的 player_data 承载, 这里是非玩家实体)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,

    -- 所属区块 (冗余存坐标列, 服务于范围查询: "我周围有什么实体")
    chunk_x     INTEGER,
    chunk_z     INTEGER,

    uuid        TEXT,             -- 玩家实体用 UUID; 怪物/掉落物可 NULL (用自增id)
    entity_type TEXT NOT NULL,    -- minecraft:zombie / item / arrow ...

    -- 位置与姿态
    x     REAL NOT NULL,
    y     REAL NOT NULL,
    z     REAL NOT NULL,
    yaw   REAL DEFAULT 0,
    pitch REAL DEFAULT 0,

    -- 运动向量
    velocity_x REAL DEFAULT 0,
    velocity_y REAL DEFAULT 0,
    velocity_z REAL DEFAULT 0,

    -- 生命属性
    health     REAL DEFAULT 20,
    max_health REAL DEFAULT 20,

    -- 扩展数据 (JSON: 装备/掉落物内容/自定义标签...)
    metadata TEXT,

    -- 状态
    is_on_ground INTEGER DEFAULT 0,
    fire_ticks   INTEGER DEFAULT -1,
    age          INTEGER DEFAULT 0,  -- 存活 tick 数

    created_at INTEGER,
    last_tick  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_entity_pos  ON entities (chunk_x, chunk_z);
CREATE INDEX IF NOT EXISTS idx_entity_type ON entities (entity_type);

-- -------------------------------------------------------------
-- 方块变更日志 (审计 / 反作弊 / Undo / 世界回放)
-- 注意: 高频写入表! RegionDO 批量持久化时顺带 flush, 单独成表避免锁主表
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS block_change_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,

    actor_uuid     TEXT,     -- 操作者 (NULL = 系统/自然: 爆炸/水流/活塞)
    actor_type     TEXT,     -- player / explosion / fire / piston / liquid ...

    world          TEXT DEFAULT 'overworld',
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    z INTEGER NOT NULL,

    old_state_id   INTEGER,  -- 变更前 (NULL = 原本不存在)
    new_state_id   INTEGER,  -- 变更后

    game_tick      INTEGER,  -- 游戏内 tick (相对时间线)
    real_timestamp INTEGER,  -- Unix 毫秒 (绝对时间线)

    reason         TEXT      -- 详细原因 (调试/申诉用)
);
CREATE INDEX IF NOT EXISTS idx_bcl_position ON block_change_log (x, y, z);
CREATE INDEX IF NOT EXISTS idx_bcl_actor    ON block_change_log (actor_uuid);
CREATE INDEX IF NOT EXISTS idx_bcl_time     ON block_change_log (real_timestamp);

-- -------------------------------------------------------------
-- 待处理的定时更新 (红石 tick / 作物生长 / 熔炼进度)
-- 对应原版 ScheduledTick 机制: 每游戏 tick 由 RegionDO 按 target_tick 捞取执行
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduled_ticks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,

    world          TEXT DEFAULT 'overworld',
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    z INTEGER NOT NULL,

    block_state_id INTEGER NOT NULL,
    target_tick    INTEGER NOT NULL,  -- 应触发的游戏 tick
    priority       INTEGER NOT NULL,  -- 低数值 = 优先执行 (对齐原版: 液体1, 红石2)

    metadata       TEXT               -- 额外数据 (如活塞朝向)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_target ON scheduled_ticks (target_tick);
CREATE INDEX IF NOT EXISTS idx_scheduled_pos    ON scheduled_ticks (x, y, z);
