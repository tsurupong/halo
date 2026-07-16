#!/usr/bin/env bash
# on-fail-requeue / 20-requeue-transient（D9 §4 / ADR-0014）: transient 失敗の自動再供給。
# stdin の on-fail.in JSON {task_id, reason, retry_count, gate?, workdir?} を受け取り、
# reason が一時的失敗（rate limit / flaky / ネットワーク断 / timeout）に見える場合のみ、
# ローカルタスクソースのタスクファイル <task_id>.md を queue/ へ戻す。試行回数は
# ${HALO_REQUEUE_DIR}/<task_id>.count で永続化し、上限到達で quarantine/ へ隔離する
# （削除はしない — 上限超過は必ず移動で表現、ADR-0014）。
# record（order 10）が先に failure-catalog へ記録した後に走る（order 20）。
# ベストエフォート（部分失敗許容）。出力は無し、stdout は空に保つ。
set -uo pipefail

TRANSIENT_RE='rate.?limit|429|flaky|ECONNRESET|ETIMEDOUT|ENETUNREACH|timed?.?out|temporar'
MAX_ATTEMPTS="${REQUEUE_MAX_ATTEMPTS:-3}"
REQUEUE_DIR="${HALO_REQUEUE_DIR:-.halo/requeue}"
TASKS_DIR="${HALO_TASKS_DIR:-.halo/tasks}"

input="$(cat)"
task_id="$(jq -r '.task_id // empty' <<<"$input")"
reason="$(jq -r '.reason // ""' <<<"$input")"

# task_id はファイル名に使うため厳格に検証（パス区切り等の混入を拒否して exit 0）。
if [[ -z "$task_id" || ! "$task_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "on-fail-requeue: task_id 不正のためスキップ: [$task_id]" >&2
  exit 0
fi

# 非 transient は再投入しない（人間の判断待ち。record が記録済み）。
if ! grep -qiE "$TRANSIENT_RE" <<<"$reason"; then
  exit 0
fi

# 試行カウンタを +1 して書き戻す（無ければ 0 起点）。
count_file="$REQUEUE_DIR/$task_id.count"
count=0
if [[ -f "$count_file" ]]; then
  count="$(cat "$count_file" 2>/dev/null || echo 0)"
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
fi
count=$((count + 1))
if ! mkdir -p "$REQUEUE_DIR" 2>/dev/null || ! printf '%s\n' "$count" >"$count_file" 2>/dev/null; then
  echo "on-fail-requeue: カウンタ書き込み失敗: $count_file" >&2
  exit 0
fi

# タスクファイルを tasks 配下（queue/ 以外に退避されている場合も含む）から探す。
task_file=""
for candidate in "$TASKS_DIR"/*/"$task_id.md" "$TASKS_DIR/$task_id.md"; do
  if [[ -f "$candidate" ]]; then
    task_file="$candidate"
    break
  fi
done
if [[ -z "$task_file" ]]; then
  echo "on-fail-requeue: タスクファイル不在のためスキップ: $task_id" >&2
  exit 0
fi

if (( count < MAX_ATTEMPTS )); then
  # 上限未満 → queue/ へ戻して次回ループで再供給させる。
  mkdir -p "$TASKS_DIR/queue" 2>/dev/null || exit 0
  if [[ "$task_file" != "$TASKS_DIR/queue/$task_id.md" ]]; then
    mv "$task_file" "$TASKS_DIR/queue/$task_id.md" 2>/dev/null \
      || echo "on-fail-requeue: queue への移動失敗: $task_file" >&2
  fi
else
  # 上限到達 → quarantine/ へ隔離し、カウンタを片付ける（次回投入時は 0 起点）。
  mkdir -p "$TASKS_DIR/quarantine" 2>/dev/null || exit 0
  mv "$task_file" "$TASKS_DIR/quarantine/$task_id.md" 2>/dev/null \
    || echo "on-fail-requeue: quarantine への移動失敗: $task_file" >&2
  rm -f "$count_file" 2>/dev/null
fi
exit 0
