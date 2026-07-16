#!/usr/bin/env bash
# on-fail-record / 10-record-failure（D1 §1.6 / D5 §2.6 / 03 §5.2）: 失敗記録 on-fail プラグイン。
# stdin の on-fail.in JSON {task_id, reason, retry_count, gate?, workdir?} を受け取り、
# .halo/failure-catalog.md へインシデント 1 件を追記する（失敗学習ループの永続化層、要件 §3.2 原則7）。
# escalate（needs-human）は task-source 側で担保するため本プラグインは記録のみ。
# ベストエフォート（部分失敗許容）。出力は無し、stdout は空に保つ。
set -uo pipefail

# 依存コマンドのプリフライト（D10 §5）。ベストエフォートのため欠落時は理由を出して exit 0。
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/require.sh"
require_cmds jq || { echo "on-fail-record: 依存コマンド欠落のためスキップ" >&2; exit 0; }

input="$(cat)"
task_id="$(jq -r '.task_id // empty' <<<"$input")"
reason="$(jq -r '.reason // ""' <<<"$input")"
rc="$(jq -r '.retry_count // 0' <<<"$input")"
gate="$(jq -r '.gate // "unknown"' <<<"$input")"
workdir="$(jq -r '.workdir // empty' <<<"$input")"

if [[ -z "$task_id" ]]; then
  echo "on-fail-record: task_id 欠落のためスキップ" >&2
  exit 0
fi

# カタログ先は安定領域（cwd = 対象リポジトリ root、コアの runner が保証。HALO_CATALOG で上書き可能）。
# workdir は使い捨て worktree で削除と同時に記録が消えるため既定にしない。
catalog="${HALO_CATALOG:-.halo/failure-catalog.md}"
if ! mkdir -p "$(dirname "$catalog")" 2>/dev/null; then
  echo "on-fail-record: カタログディレクトリ作成失敗: $catalog" >&2
  exit 0
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
  printf '\n## %s\n\n' "$ts — $task_id"
  printf '%s\n' "- 日時: $ts"
  printf '%s\n' "- タスク: $task_id"
  printf '%s\n' "- 失敗ゲート: $gate"
  printf '%s\n' "- リトライ: $rc"
  printf '%s\n' "- 理由: $reason"
  printf '%s\n' "- 対処: "
} >>"$catalog" 2>/dev/null || echo "on-fail-record: 追記失敗: $catalog" >&2
exit 0
