#!/usr/bin/env bash
# 軽量 contract test: sink-progress-log が sink.in を受けて logs/ へ構造化追記する契約を検証する。
#   - plugin.json に minAutonomy:"L1" が宣言されているか / ファイル先頭に # min-autonomy: L1 コメント
#   - 正常入力で logs/ に 1 行 JSON（task_id/summary を含む）が追記され、stdout は空
#   - 追記は複数回で累積する（append 動作）
#   - 必須欠落はベストエフォートでスキップ（exit 0、stdout 空）
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

# --- plugin.json / コメントのメタデータ検証 ---
if jq -e '.minAutonomy=="L1"' "$DIR/plugin.json" >/dev/null 2>&1; then
  echo "PASS  plugin.json declares minAutonomy L1"
else
  echo "FAIL  plugin.json minAutonomy"; fail=1
fi
if grep -qE '^# min-autonomy:\s*L1' "$DIR/log.sh"; then
  echo "PASS  log.sh has # min-autonomy: L1 comment"
else
  echo "FAIL  log.sh min-autonomy comment"; fail=1
fi

export HALO_LOGS_DIR="$TMP/logs"

# --- 正常追記 ---
IN="$(jq -cn --arg w "$TMP/wt" '{task_id:"T-7", workdir:$w, summary:"planned 3 steps"}')"
out="$(bash "$DIR/log.sh" <<<"$IN" 2>/dev/null)"; code=$?
logfile="$(ls "$HALO_LOGS_DIR"/progress-*.jsonl 2>/dev/null | head -1)"
if [[ $code -eq 0 && -z "$out" && -n "$logfile" ]] \
   && jq -e '.task_id=="T-7" and .summary=="planned 3 steps" and (.ts|type=="string")' >/dev/null 2>&1 <"$logfile"; then
  echo "PASS  logs structured entry appended, stdout empty"
else
  echo "FAIL  append: code=$code out=[$out] file=[$logfile]"; fail=1
fi

# --- append 累積 ---
bash "$DIR/log.sh" <<<"$IN" >/dev/null 2>&1
count="$(wc -l < "$logfile")"
if [[ "$count" -eq 2 ]]; then
  echo "PASS  second run appends (2 lines)"
else
  echo "FAIL  append accumulation: lines=$count"; fail=1
fi

# --- 欠落 → スキップ、stdout 空、exit 0 ---
out="$(bash "$DIR/log.sh" <<<'{"summary":"x"}' 2>/dev/null)"; code=$?
if [[ $code -eq 0 && -z "$out" ]]; then
  echo "PASS  missing task_id/workdir -> skip (exit 0, stdout empty)"
else
  echo "FAIL  missing fields: code=$code out=[$out]"; fail=1
fi

# --- 既定出力先: HALO_LOGS_DIR 未指定なら cwd (対象リポジトリ root) の .halo/logs ---
# workdir (使い捨て worktree) に書くと worktree 削除と同時に記録が消えるため。
unset HALO_LOGS_DIR
mkdir -p "$TMP/repo"
out="$(cd "$TMP/repo" && bash "$DIR/log.sh" <<<"$IN" 2>/dev/null)"; code=$?
deflog="$(ls "$TMP/repo/.halo/logs"/progress-*.jsonl 2>/dev/null | head -1)"
if [[ $code -eq 0 && -z "$out" && -n "$deflog" ]]; then
  echo "PASS  default logs dir is cwd/.halo/logs (stable area, not worktree)"
else
  echo "FAIL  default logs dir: code=$code file=[$deflog]"; fail=1
fi

exit "$fail"
