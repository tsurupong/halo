#!/usr/bin/env bash
# trigger polling: install.sh が作成した Windows タスクを解除する。
# 登録が無ければ何もせず正常終了する（冪等, 設計 04 §4.2）。
# 引数: $1 = プロファイル名。
set -euo pipefail

PROFILE="${1:?profile required}"
TASK_NAME="HALO_${PROFILE}"

schtasks.exe /Delete /TN "$TASK_NAME" /F >/dev/null 2>&1 || true
echo "trigger-polling: 解除しました TN=$TASK_NAME" >&2
exit 0
