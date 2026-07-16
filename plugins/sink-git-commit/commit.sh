#!/usr/bin/env bash
# sink-git-commit（ADR-0016 / D1 §1.5）: gate 通過済み worktree の変更をタスクブランチへ
# コミットして成果を永続化する sink。push はしない（外部公開は L2+ の別 sink の責務）。
# stdin の sink.in JSON {task_id, workdir, summary} を受け取る。
#   - 変更が無ければ何もしない（コミット無し → コアの完了判定も発火しない）
#   - コミット者はハーネス名義（HALO_GIT_NAME/EMAIL で上書き可）
# ベストエフォート（部分失敗許容）。出力は無し、stdout は空に保つ。
set -uo pipefail

GIT_NAME="${HALO_GIT_NAME:-halo}"
GIT_EMAIL="${HALO_GIT_EMAIL:-halo@localhost}"

input="$(cat)"
task_id="$(jq -r '.task_id // empty' <<<"$input")"
workdir="$(jq -r '.workdir // empty' <<<"$input")"
summary="$(jq -r '.summary // ""' <<<"$input")"

if [[ -z "$task_id" || -z "$workdir" || ! -d "$workdir" ]]; then
  echo "sink-git-commit: task_id/workdir 不正のためスキップ" >&2
  exit 0
fi
if ! git -C "$workdir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "sink-git-commit: git worktree ではないためスキップ: $workdir" >&2
  exit 0
fi

git -C "$workdir" add -A >/dev/null 2>&1 || {
  echo "sink-git-commit: git add 失敗" >&2
  exit 0
}

# ステージに変更が無ければコミットしない（成果無し = 完了させない、ADR-0016）。
if git -C "$workdir" diff --cached --quiet 2>/dev/null; then
  echo "sink-git-commit: 変更なし、コミットをスキップ: $task_id" >&2
  exit 0
fi

git -C "$workdir" \
  -c user.name="$GIT_NAME" \
  -c user.email="$GIT_EMAIL" \
  commit -m "feat: complete task ${task_id} (halo)" -m "$summary" >/dev/null 2>&1 \
  || echo "sink-git-commit: コミット失敗: $task_id" >&2
exit 0
