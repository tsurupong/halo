#!/usr/bin/env bash
# trigger polling: 高頻度起動をスケジューラバックエンドへ登録する（設計 D10 §3, ADR-0015）。
# バックエンド検出・登録コマンド生成は plugins/lib/scheduler.sh に委譲する。
# 引数: $1 = プロファイル名。冪等（再実行は削除→再登録）。
set -euo pipefail

PROFILE="${1:?profile required}"
[[ "$PROFILE" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid profile name: $PROFILE" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIRE="$SCRIPT_DIR/fire"

source "$SCRIPT_DIR/../lib/scheduler.sh"

# 発火間隔（分）は環境変数で上書き可（既定 15 分）。
scheduler_install polling "$PROFILE" "interval:${HALO_POLL_INTERVAL_MIN:-15}" "$FIRE"

echo "trigger-polling: 登録しました profile=$PROFILE interval=${HALO_POLL_INTERVAL_MIN:-15}min" >&2
