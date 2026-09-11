#!/usr/bin/env bash
# ============================================================================
# CFMC-Edge — Anvil 世界导入脚本 (Phase 2: 完整实现)
# ============================================================================
# 流程: .mca 解析 (anvil-migrator.mjs) → Cesium SQL → wrangler 灌入 D1
#
# 用法:
#   bash scripts/import-world.sh <anvil世界目录>            # 远端 D1
#   bash scripts/import-world.sh <anvil世界目录> --local    # 本地模拟库
# ============================================================================
set -euo pipefail

WORLD_DIR="${1:-}"
MODE="${2:-remote}"
[[ -z "$WORLD_DIR" ]] && { echo "用法: $0 <anvil世界目录> [--local] (目录需含 region/*.mca)"; exit 1; }
[[ -d "$WORLD_DIR/region" ]] || { echo "错误: $WORLD_DIR 下没有 region/ 目录"; exit 1; }

log()  { echo -e "\033[1;34m[import-world]\033[0m $*"; }
ok()   { echo -e "\033[1;32m[  OK  ]\033[0m $*"; }
die()  { echo -e "\033[1;31m[ FAIL ]\033[0m $*" >&2; exit 1; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_SQL="${ROOT_DIR}/cesium-import-$(date +%s).sql"

# ---- 1. 生成 SQL ----
log "解析 Anvil 区块并生成 Cesium SQL ..."
node "${ROOT_DIR}/scripts/anvil-migrator.mjs" "$WORLD_DIR/region" --out "$OUT_SQL" || die "解析失败"
ok "SQL 生成: ${OUT_SQL}"

# ---- 2. 灌入 D1 ----
if [[ "$MODE" == "--local" ]]; then
  log "导入本地模拟库 (miniflare) ..."
  npx wrangler d1 execute cfmc-world --local --file="$OUT_SQL" || die "本地导入失败"
else
  log "导入远端 D1 (cfmc-world) ..."
  npx wrangler d1 execute cfmc-world --remote --file="$OUT_SQL" -y || die "远端导入失败"
fi

ok "导入完成! 验证: npx wrangler d1 execute cfmc-world --remote --command 'SELECT count(*) FROM chunks'"
log "提示: 存档 Y=0 基准的世界 (1.17-) 建议 Y 平移 +64 后再玩 (迁移器按 1.18+ 负 Y 坐标直读)"
