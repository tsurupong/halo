#!/usr/bin/env bash
# trigger schedule: install.sh が登録したスケジュールを解除する（設計 D10 §3, ADR-0015）。
# 登録が無ければ何もせず正常終了する（冪等, 設計 04 §4.2）。
# 引数: $1 = プロファイル名。
set -euo pipefail

PROFILE="${1:?profile required}"
[[ "$PROFILE" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid profile name: $PROFILE" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$SCRIPT_DIR/../lib/scheduler.sh"

scheduler_uninstall schedule "$PROFILE"

echo "trigger-schedule: 解除しました profile=$PROFILE" >&2
exit 0
