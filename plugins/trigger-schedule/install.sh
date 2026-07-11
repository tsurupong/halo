#!/usr/bin/env bash
# trigger schedule: Windows タスクスケジューラへ nightly 定時起動を登録する。
# WSL2 VM 自動停止対策として一次トリガーは Windows 側に置き、発火が VM 起動を兼ねる（設計 04 §4.3）。
# 引数: $1 = プロファイル名。冪等（同名タスクは削除→再登録）。
set -euo pipefail

PROFILE="${1:?profile required}"
[[ "$PROFILE" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid profile name: $PROFILE" >&2; exit 1; }
TASK_NAME="HALO_${PROFILE}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIRE="$SCRIPT_DIR/fire"

# 起動時刻は環境変数で上書き可（既定 03:00 の nightly 起動）。
START_TIME="${HALO_SCHEDULE_TIME:-03:00}"

# fire 時に HALO_BIN/HALO_HOME を復元するため、TR コマンドへ env 代入を埋め込む
# （CLI の triggers.ts が install.sh へ渡す値。埋め込まないと発火時に既定へフォールバックする）。
# パス以外の文字（クォート・空白・シェルメタ文字）は注入防止のため拒否する。
SAFE_PATH='^[A-Za-z0-9/._-]+$'
ENV_ASSIGN=""
if [[ -n "${HALO_HOME:-}" ]]; then
  [[ "$HALO_HOME" =~ $SAFE_PATH ]] || { echo "invalid HALO_HOME: $HALO_HOME" >&2; exit 1; }
  ENV_ASSIGN+="HALO_HOME=\"$HALO_HOME\" "
fi
if [[ -n "${HALO_BIN:-}" ]]; then
  [[ "$HALO_BIN" =~ $SAFE_PATH ]] || { echo "invalid HALO_BIN: $HALO_BIN" >&2; exit 1; }
  ENV_ASSIGN+="HALO_BIN=\"$HALO_BIN\" "
fi

# 既存タスクがあれば削除して重複登録を防ぐ（冪等化）。
schtasks.exe /Delete /TN "$TASK_NAME" /F >/dev/null 2>&1 || true

schtasks.exe /Create /TN "$TASK_NAME" \
  /SC DAILY /ST "$START_TIME" \
  /TR "wsl.exe -e bash -lc '${ENV_ASSIGN}$FIRE $PROFILE'" \
  /RL LIMITED /F

echo "trigger-schedule: 登録しました TN=$TASK_NAME ST=$START_TIME" >&2
