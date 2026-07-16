#!/usr/bin/env bash
# runtime node-pnpm: 依存の実体化。pnpm --offline でストアからハードリンク共有し
# 高速に node_modules を実体化する。store は ext4 側前提（D1 §1.7 / D5 §3.2）。
# 入力(stdin): { workdir, changed_files? } … runtime.in（D1 §1.7）
# 判定: 成功=exit 0 / 失敗=exit 2。診断は stderr、stdout は使わない。
set -uo pipefail

# 依存コマンドのプリフライト（D10 §5）。欠落時は既存エラーパスと同じ stderr + exit 2。
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/require.sh"
require_cmds jq pnpm || { echo "runtime-node-pnpm/setup: 依存コマンド欠落" >&2; exit 2; }

input="$(cat)"
workdir="$(jq -r '.workdir // empty' <<<"$input")"
if [[ -z "$workdir" ]]; then
  echo "runtime-node-pnpm/setup: workdir が入力にありません" >&2
  exit 2
fi
cd "$workdir" || { echo "runtime-node-pnpm/setup: cd 失敗: $workdir" >&2; exit 2; }

# ストアは ext4 側（WSL2 制約）。呼び出し側が PNPM_STORE_DIR を注入していれば尊重する。
store_args=()
if [[ -n "${PNPM_STORE_DIR:-}" ]]; then
  store_args+=(--store-dir "$PNPM_STORE_DIR")
fi

# オフライン優先（ネットワーク非依存・ハードリンク共有）。
pnpm install --offline --frozen-lockfile "${store_args[@]}" >&2 2>&1 || exit 2
exit 0
