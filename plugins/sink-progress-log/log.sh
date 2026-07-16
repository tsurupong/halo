#!/usr/bin/env bash
# min-autonomy: L1
# sink-progress-log / 20-progress-log（D1 §1.5 / D5 §2.5 / 03 §4.3）: 進捗の構造化記録 sink。
# stdin の sink.in JSON {task_id, workdir, summary} を受け取り、logs/ へ 1 行 JSON を追記する。
# minAutonomy L1: 副作用なしの記録のみ（コード変更を成果物として残さない、観察運転用）。
# ベストエフォート（部分失敗許容、03 §4.1）。出力は無し、stdout は空に保つ。
set -uo pipefail

# 依存コマンドのプリフライト（D10 §5）。ベストエフォートのため欠落時は理由を出して exit 0。
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/require.sh"
require_cmds jq || { echo "sink-progress-log: 依存コマンド欠落のためスキップ" >&2; exit 0; }

input="$(cat)"
task_id="$(jq -r '.task_id // empty' <<<"$input")"
workdir="$(jq -r '.workdir // empty' <<<"$input")"
summary="$(jq -r '.summary // ""' <<<"$input")"

if [[ -z "$task_id" || -z "$workdir" ]]; then
  echo "sink-progress-log: task_id/workdir 欠落のためスキップ" >&2
  exit 0
fi

# ログ先は安定領域（cwd = 対象リポジトリ root、コアの runner が保証）。
# workdir は使い捨て worktree で削除と同時に記録が消えるため既定にしない。
logs_dir="${HALO_LOGS_DIR:-.halo/logs}"
if ! mkdir -p "$logs_dir" 2>/dev/null; then
  echo "sink-progress-log: logs ディレクトリ作成失敗: $logs_dir" >&2
  exit 0
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
logfile="$logs_dir/progress-$(date -u +%Y-%m-%d).jsonl"
jq -cn --arg ts "$ts" --arg id "$task_id" --arg wd "$workdir" --arg sm "$summary" \
  '{ts:$ts, task_id:$id, workdir:$wd, summary:$sm}' >>"$logfile" 2>/dev/null \
  || echo "sink-progress-log: 追記失敗: $logfile" >&2
exit 0
