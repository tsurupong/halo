#!/usr/bin/env bash
# 軽量 contract test: on-fail-record が on-fail.in を受けて failure-catalog.md へ追記する契約を検証する。
#   - 正常入力で catalog に日時/タスク/gate/理由/対処 形式の 1 件が追記され、stdout は空
#   - 複数回で累積追記される
#   - gate 欠落時は unknown を補う
#   - task_id 欠落はベストエフォートでスキップ（exit 0、stdout 空）
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

export HALO_CATALOG="$TMP/.halo/failure-catalog.md"

# --- 正常追記 ---
IN='{"task_id":"T-12","reason":"coverage 87% < 90%","retry_count":2,"gate":"30-test","workdir":"/tmp/wt"}'
out="$(bash "$DIR/record.sh" <<<"$IN" 2>/dev/null)"; code=$?
if [[ $code -eq 0 && -z "$out" && -f "$HALO_CATALOG" ]] \
   && grep -q 'タスク: T-12' "$HALO_CATALOG" \
   && grep -q '失敗ゲート: 30-test' "$HALO_CATALOG" \
   && grep -q 'coverage 87% < 90%' "$HALO_CATALOG" \
   && grep -q '対処:' "$HALO_CATALOG"; then
  echo "PASS  incident appended in 日時/タスク/gate/理由/対処 form, stdout empty"
else
  echo "FAIL  append: code=$code out=[$out]"; fail=1
  [[ -f "$HALO_CATALOG" ]] && sed 's/^/    /' "$HALO_CATALOG"
fi

# --- 累積追記 ---
bash "$DIR/record.sh" <<<"$IN" >/dev/null 2>&1
n="$(grep -c '^## ' "$HALO_CATALOG")"
if [[ "$n" -eq 2 ]]; then
  echo "PASS  second run appends (2 incidents)"
else
  echo "FAIL  accumulation: incidents=$n"; fail=1
fi

# --- gate 欠落 → unknown ---
bash "$DIR/record.sh" <<<'{"task_id":"T-13","reason":"stuck","retry_count":0}' >/dev/null 2>&1
if grep -q '失敗ゲート: unknown' "$HALO_CATALOG"; then
  echo "PASS  missing gate -> unknown"
else
  echo "FAIL  missing gate default"; fail=1
fi

# --- task_id 欠落 → スキップ、stdout 空、exit 0 ---
out="$(bash "$DIR/record.sh" <<<'{"reason":"x","retry_count":0}' 2>/dev/null)"; code=$?
if [[ $code -eq 0 && -z "$out" ]]; then
  echo "PASS  missing task_id -> skip (exit 0, stdout empty)"
else
  echo "FAIL  missing task_id: code=$code out=[$out]"; fail=1
fi

# --- 既定出力先: HALO_CATALOG 未指定なら cwd (対象リポジトリ root) の .halo/failure-catalog.md ---
# workdir (使い捨て worktree) に書くと worktree 削除と同時に記録が消えるため。
unset HALO_CATALOG
mkdir -p "$TMP/repo"
out="$(cd "$TMP/repo" && bash "$DIR/record.sh" <<<"$IN" 2>/dev/null)"; code=$?
if [[ $code -eq 0 && -z "$out" && -f "$TMP/repo/.halo/failure-catalog.md" ]] \
   && grep -q 'タスク: T-12' "$TMP/repo/.halo/failure-catalog.md"; then
  echo "PASS  default catalog is cwd/.halo/failure-catalog.md (stable area, not worktree)"
else
  echo "FAIL  default catalog: code=$code"; fail=1
fi

exit "$fail"
