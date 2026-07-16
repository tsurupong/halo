#!/usr/bin/env bash
# runtime node-pnpm: 静的検査。tsc --noEmit と eslint。どちらかが失敗したら exit 2。
# 入力(stdin): { workdir, changed_files? } … runtime.in（D1 §1.7）
# 判定: pass=exit 0 / fail=exit 2。診断は stderr、stdout は使わない（D5 §3.2）。
set -uo pipefail

# 依存コマンドのプリフライト（D10 §5）。欠落時は既存エラーパスと同じ stderr + exit 2。
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/require.sh"
require_cmds jq pnpm || { echo "runtime-node-pnpm/check: 依存コマンド欠落" >&2; exit 2; }

input="$(cat)"
workdir="$(jq -r '.workdir // empty' <<<"$input")"
if [[ -z "$workdir" ]]; then
  echo "runtime-node-pnpm/check: workdir が入力にありません" >&2
  exit 2
fi
cd "$workdir" || { echo "runtime-node-pnpm/check: cd 失敗: $workdir" >&2; exit 2; }

pnpm exec tsc --noEmit >&2 2>&1 || exit 2
pnpm exec eslint .     >&2 2>&1 || exit 2
exit 0
