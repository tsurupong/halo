#!/usr/bin/env bash
# trigger polling: Windows タスクスケジューラへ 15 分間隔の高頻度起動を登録する。
# VM 停止対策として一次トリガーは Windows 側（発火が VM 起動を兼ねる, 設計 04 §4.4）。
# 引数: $1 = プロファイル名。冪等（同名タスクは削除→再登録）。
set -euo pipefail

PROFILE="${1:?profile required}"
[[ "$PROFILE" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid profile name: $PROFILE" >&2; exit 1; }
TASK_NAME="HALO_${PROFILE}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIRE="$SCRIPT_DIR/fire"

# 発火間隔（分）は環境変数で上書き可（既定 15 分）。
INTERVAL_MIN="${HALO_POLL_INTERVAL_MIN:-15}"

schtasks.exe /Delete /TN "$TASK_NAME" /F >/dev/null 2>&1 || true

schtasks.exe /Create /TN "$TASK_NAME" \
  /SC MINUTE /MO "$INTERVAL_MIN" \
  /TR "wsl.exe -e bash -lc '$FIRE $PROFILE'" \
  /RL LIMITED /F

echo "trigger-polling: 登録しました TN=$TASK_NAME MO=${INTERVAL_MIN}min" >&2
