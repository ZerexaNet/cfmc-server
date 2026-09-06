#!/usr/bin/env bash
# ============================================================================
# CFMC-Edge — Anvil 世界导入脚本 (占位, Phase 2 完整实现)
# ============================================================================
# 目标: 把现有 .mca (Anvil) 世界转换为 Cesium 格式并灌入 D1
#
# 实现计划 (cfmc.md 注意事项 #4):
#   1. 解析 region/*.mca: 定位表 + 分块 Zlib 解压 → NBT
#   2. NBT → 调色板+索引: level.Sections[].Palette/PaletteData (1.18+ 格式)
#   3. 坐标平移: Anvil Y∈[0,255] → 1.18 Y∈[-64,319]
#   4. 分批写入 D1: 每 500 个 Section 一个 batch (配额友好)
#
# TODO(Phase 2): 在 tools/migrator/ 用 Node 实现解析器后, 本脚本负责
#   编排: node tools/migrator/scan.mjs <world-dir> | node tools/migrator/push.mjs
# ============================================================================
set -euo pipefail

WORLD_DIR="${1:-}"
[[ -z "$WORLD_DIR" ]] && { echo "用法: $0 <anvil世界目录> (包含 region/*.mca)"; exit 1; }
[[ -d "$WORLD_DIR/region" ]] || { echo "错误: $WORLD_DIR 下没有 region/ 目录"; exit 1; }

echo "[import-world] 发现的 region 文件:"
ls -lh "$WORLD_DIR"/region/*.mca 2>/dev/null || true

echo ""
echo "[import-world] ⚠️ 迁移器尚未实现 (Phase 2)。"
echo "  上述文件将被解析并转换为 Cesium 格式写入 D1 的 cfmc-world 库。"
exit 0
