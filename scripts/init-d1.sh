#!/usr/bin/env bash
# ============================================================================
# CFMC-Edge — D1 数据库初始化脚本
# ============================================================================
# 功能:
#   1. 创建两个 D1 数据库: cfmc-users (账号) + cfmc-world (地图存档)
#   2. 从 wrangler 输出中提取 database_id, 自动替换 wrangler.toml 占位符
#   3. 应用表结构 (users-schema.sql / cesium-schema.sql)
#
# 用法:
#   bash scripts/init-d1.sh            # 创建远端库 + 建表 (正式部署用)
#   bash scripts/init-d1.sh --local    # 仅本地模拟库建表 (wrangler dev 用, 无需账号)
#
# 依赖: npm i -g wrangler 或 npx wrangler; 远端模式需已 `wrangler login`
# ============================================================================
set -euo pipefail

MODE="remote"
[[ "${1:-}" == "--local" ]] && MODE="local"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOML="${ROOT_DIR}/wrangler.toml"

# wrangler 命令解析: 优先用本地 node_modules, 其次全局
WRANGLER="npx wrangler"

log()  { echo -e "\033[1;34m[init-d1]\033[0m $*"; }
ok()   { echo -e "\033[1;32m[  OK  ]\033[0m $*"; }
warn() { echo -e "\033[1;33m[ WARN ]\033[0m $*"; }
die()  { echo -e "\033[1;31m[ FAIL ]\033[0m $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 步骤 1: 创建数据库 (已存在则跳过)
# 返回值: 向标准输出打印 database_id (uuid), 日志走 stderr
# ---------------------------------------------------------------------------
create_db() {
  local name="$1"

  if [[ "$MODE" == "local" ]]; then
    # 本地模式不真正建库 (miniflare 自动按 binding 模拟), 只建表
    echo "local-placeholder"
    return 0
  fi

  log "创建/检查 D1 数据库: ${name} ..."
  local out
  # d1 create 对已存在的库会报错, 捕获后继续 (幂等)
  out=$($WRANGLER d1 create "$name" 2>&1) || warn "d1 create 报错 (可能已存在), 尝试从 d1 info 读取 ..."

  local id
  id=$(echo "$out" | grep -oE 'database_id = "[a-f0-9-]+"' | head -1 | cut -d'"' -f2)

  if [[ -z "$id" ]]; then
    # 库已存在: 从列表兜底读取
    id=$($WRANGLER d1 list 2>/dev/null | awk -v n="$name" '$0 ~ n {for(i=1;i<=NF;i++) if($i ~ /^[a-f0-9-]{36}$/) {print $i; exit}}')
  fi

  [[ -n "$id" ]] || die "无法获取 ${name} 的 database_id, 请手动执行: $WRANGLER d1 info ${name}"
  echo "$id"
}

# ---------------------------------------------------------------------------
# 步骤 2: 把真实 id 写回 wrangler.toml (替换占位符)
# ---------------------------------------------------------------------------
patch_toml() {
  local placeholder="$1" real_id="$2"
  if [[ "$real_id" == "local-placeholder" ]]; then
    warn "本地模式: ${placeholder} 占位符保持不变 (本地 dev 不读取该 id)"
    return 0
  fi
  if grep -q "$placeholder" "$TOML"; then
    # 兼容 GNU/BSD sed
    if sed --version >/dev/null 2>&1; then
      sed -i "s|${placeholder}|${real_id}|g" "$TOML"
    else
      sed -i '' "s|${placeholder}|${real_id}|g" "$TOML"
    fi
    ok "wrangler.toml 已写入 ${real_id}"
  else
    warn "wrangler.toml 中未找到占位符 ${placeholder} (可能已替换过)"
  fi
}

# ---------------------------------------------------------------------------
# 步骤 3: 建表
# ---------------------------------------------------------------------------
apply_schema() {
  local db_name="$1" sql_file="$2"
  [[ -f "$sql_file" ]] || die "SQL 文件不存在: ${sql_file}"

  log "应用表结构: ${db_name} ← ${sql_file}"
  if [[ "$MODE" == "local" ]]; then
    $WRANGLER d1 execute "$db_name" --local --file="$sql_file" || die "本地建表失败: ${db_name}"
  else
    $WRANGLER d1 execute "$db_name" --remote --file="$sql_file" -y || die "远端建表失败: ${db_name}"
  fi
  ok "建表完成: ${db_name}"
}

# ============================================================================
# 主流程
# ============================================================================
log "模式: ${MODE} | 项目根: ${ROOT_DIR}"

USERS_ID=$(create_db "cfmc-users")
WORLD_ID=$(create_db "cfmc-world")

patch_toml "<YOUR_USERS_DB_ID>" "$USERS_ID"
patch_toml "<YOUR_WORLD_DB_ID>" "$WORLD_ID"

apply_schema "cfmc-users" "${ROOT_DIR}/src/storage/users-schema.sql"
apply_schema "cfmc-world" "${ROOT_DIR}/src/storage/cesium-schema.sql"

echo ""
ok "=========================================="
ok " D1 初始化完成!"
ok "   users 库 id: ${USERS_ID}"
ok "   world 库 id: ${WORLD_ID}"
ok "=========================================="
echo ""
log "下一步:"
log "  KV:        npx wrangler kv namespace create CACHE   → 替换 <YOUR_KV_NAMESPACE_ID>"
log "  本地开发:  npm run dev   (无需真实 id, miniflare 自动模拟)"
log "  远端部署:  npm run deploy (需先 wrangler login 且 id 已替换)"
