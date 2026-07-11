#!/usr/bin/env bash
# runtime node-pnpm: 動的検証。vitest run。失敗したら exit 2。
# 入力(stdin): { workdir, changed_files? } … runtime.in（D1 §1.7）
# 判定: pass=exit 0 / fail=exit 2。診断は stderr、stdout は使わない（D5 §3.2）。
set -uo pipefail

input="$(cat)"
workdir="$(jq -r '.workdir // empty' <<<"$input")"
if [[ -z "$workdir" ]]; then
  echo "runtime-node-pnpm/test: workdir が入力にありません" >&2
  exit 2
fi
cd "$workdir" || { echo "runtime-node-pnpm/test: cd 失敗: $workdir" >&2; exit 2; }

pnpm exec vitest run 2>&1 >&2 || exit 2
exit 0
