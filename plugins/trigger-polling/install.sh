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

schtasks.exe /Delete /TN "$TASK_NAME" /F >/dev/null 2>&1 || true

schtasks.exe /Create /TN "$TASK_NAME" \
  /SC MINUTE /MO "$INTERVAL_MIN" \
  /TR "wsl.exe -e bash -lc '${ENV_ASSIGN}$FIRE $PROFILE'" \
  /RL LIMITED /F

echo "trigger-polling: 登録しました TN=$TASK_NAME MO=${INTERVAL_MIN}min" >&2
