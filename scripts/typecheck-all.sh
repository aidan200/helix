#!/usr/bin/env bash
# 四包 typecheck 单点（pre-commit 钩与 verify 脚本的唯一来源）。
# 来历：b3542d3 给 packages/common 引入 .ts 扩展名 import，tsc 报 TS5097 需
# allowImportingTsExtensions——但该提交的验证声明（audit:a11y 全过）不含 tsc，
# 断裂合入 main 且无人发现（无远端 CI 触发，OI-CI-1）。本脚本 = 本地机械闸，
# 杜绝「验证矩阵没覆盖到的闸静默断裂」。
set -euo pipefail
cd "$(dirname "$0")/.."

for p in packages/common packages/protocol apps/daemon apps/shell; do
  if ! (cd "$p" && bun run typecheck >/dev/null 2>&1); then
    echo "[typecheck] FAIL: $p —— 错误输出："
    (cd "$p" && bun run typecheck) || true
    exit 1
  fi
  echo "[typecheck] OK: $p"
done
echo "[typecheck] 四包全绿"
