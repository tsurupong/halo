#!/usr/bin/env bash
# 軽量 contract test: on-fail-requeue が transient 失敗のみ queue へ戻し、
# 上限到達で quarantine へ隔離する契約を検証する（D9 §4 / ADR-0014）。
#   (a) transient・上限未満 → queue/ に戻りカウンタ=1
#   (b) transient・上限到達 → quarantine/ へ移動しカウンタ削除
#   (c) 非 transient → ファイル移動なし・カウンタ増加なし
#   (d) タスクファイル不在 → exit 0、stdout 空
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

export HALO_TASKS_DIR="$TMP/.halo/tasks"
export HALO_REQUEUE_DIR="$TMP/.halo/requeue"
export REQUEUE_MAX_ATTEMPTS=3

# --- (a) transient・上限未満 → queue へ戻る ---
mkdir -p "$HALO_TASKS_DIR/failed"
echo "# task" >"$HALO_TASKS_DIR/failed/T-1.md"
IN='{"task_id":"T-1","reason":"HTTP 429 rate limit exceeded","retry_count":1,"gate":"30-test"}'
out="$(bash "$DIR/requeue.sh" <<<"$IN" 2>/dev/null)"; code=$?
if [[ $code -eq 0 && -z "$out" && -f "$HALO_TASKS_DIR/queue/T-1.md" \
      && "$(cat "$HALO_REQUEUE_DIR/T-1.count")" == "1" ]]; then
  echo "PASS  transient below limit -> requeued, counter=1"
else
  echo "FAIL  requeue: code=$code out=[$out]"; fail=1
fi

# --- (b) transient・上限到達 → quarantine へ移動しカウンタ削除 ---
echo "2" >"$HALO_REQUEUE_DIR/T-2.count"
mkdir -p "$HALO_TASKS_DIR/queue"
echo "# task" >"$HALO_TASKS_DIR/queue/T-2.md"
bash "$DIR/requeue.sh" <<<'{"task_id":"T-2","reason":"test timed out","retry_count":2}' >/dev/null 2>&1
if [[ -f "$HALO_TASKS_DIR/quarantine/T-2.md" && ! -f "$HALO_TASKS_DIR/queue/T-2.md" \
      && ! -f "$HALO_REQUEUE_DIR/T-2.count" ]]; then
  echo "PASS  transient at limit -> quarantined, counter removed"
else
  echo "FAIL  quarantine"; fail=1
fi

# --- (c) 非 transient → 何もしない ---
echo "# task" >"$HALO_TASKS_DIR/failed/T-3.md"
out="$(bash "$DIR/requeue.sh" <<<'{"task_id":"T-3","reason":"assertion failed: expected 42","retry_count":1}' 2>/dev/null)"; code=$?
if [[ $code -eq 0 && -z "$out" && -f "$HALO_TASKS_DIR/failed/T-3.md" \
      && ! -f "$HALO_TASKS_DIR/queue/T-3.md" && ! -f "$HALO_REQUEUE_DIR/T-3.count" ]]; then
  echo "PASS  non-transient -> untouched"
else
  echo "FAIL  non-transient: code=$code"; fail=1
fi

# --- (d) タスクファイル不在 → exit 0、stdout 空 ---
out="$(bash "$DIR/requeue.sh" <<<'{"task_id":"ghost","reason":"ECONNRESET","retry_count":0}' 2>/dev/null)"; code=$?
if [[ $code -eq 0 && -z "$out" ]]; then
  echo "PASS  missing task file -> best-effort skip (exit 0, stdout empty)"
else
  echo "FAIL  missing file: code=$code out=[$out]"; fail=1
fi

# --- (e) task_id にパス区切り等 → 何もせず exit 0 ---
out="$(bash "$DIR/requeue.sh" <<<'{"task_id":"../evil","reason":"429","retry_count":0}' 2>/dev/null)"; code=$?
if [[ $code -eq 0 && -z "$out" && ! -e "$TMP/.halo/evil.md" ]]; then
  echo "PASS  invalid task_id -> skipped"
else
  echo "FAIL  invalid task_id: code=$code"; fail=1
fi

exit "$fail"
