#!/usr/bin/env bash
# plugins/lib/require.sh（D10 §5）: 依存コマンドのプリフライト検査。
# require_cmds <cmd>... — 全コマンドが command -v で見つかれば return 0。
# 欠落があれば "missing commands: <名前列挙>" を stderr へ出して return 1。
# 呼び出し側でメッセージが要る場合は msg="$(require_cmds ... 2>&1)" で捕捉する。
# bash 3.2 互換（配列・連想配列・${var,,} 等は使わない）。

require_cmds() {
  local missing=""
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
  done
  [ -z "$missing" ] && return 0
  echo "missing commands:$missing" >&2
  return 1
}
