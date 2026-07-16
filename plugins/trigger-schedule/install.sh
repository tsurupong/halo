#!/usr/bin/env bash
# trigger schedule: nightly 定時起動をスケジューラバックエンドへ登録する（設計 D10 §3, ADR-0015）。
# バックエンド検出・登録コマンド生成は plugins/lib/scheduler.sh に委譲する。
# 引数: $1 = プロファイル名。冪等（再実行は削除→再登録）。
set -euo pipefail

PROFILE="${1:?profile required}"
[[ "$PROFILE" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid profile name: $PROFILE" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIRE="$SCRIPT_DIR/fire"

source "$SCRIPT_DIR/../lib/scheduler.sh"

# 起動時刻は環境変数で上書き可（既定 03:00 の nightly 起動）。
scheduler_install schedule "$PROFILE" "daily:${HALO_SCHEDULE_TIME:-03:00}" "$FIRE"

echo "trigger-schedule: 登録しました profile=$PROFILE ST=${HALO_SCHEDULE_TIME:-03:00}" >&2
