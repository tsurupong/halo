#!/usr/bin/env bash
# 軽量 contract test: plugins/lib/require.sh の require_cmds を検証する。
# (a) 全コマンド存在 → return 0
# (b) 欠落 → return 1、stderr に欠落コマンド名
# (c) 代表例: executor-claude/run.sh を jq 抜きの PATH で起動すると stuck JSON を返す
#     （PATH 差し替えは一時 dir のシンボリックリンクで行い、実環境は変更しない）
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

pass() { echo "PASS  $1"; }
flunk() { echo "FAIL  $1"; fail=1; }

. "$DIR/require.sh"

# (a) 全コマンド存在 → 0
if require_cmds bash sh 2>/dev/null; then
  pass "all commands present -> return 0"
else
  flunk "all commands present -> return 0"
fi

# (b) 欠落 → 1 かつ stderr に欠落名（存在するコマンドは列挙されない）
err="$(require_cmds bash halo-no-such-cmd-xyz halo-missing-abc 2>&1)"
rc=$?
if [ "$rc" -eq 1 ]; then
  pass "missing commands -> return 1"
else
  flunk "missing commands -> return 1 (got $rc)"
fi
case "$err" in
  *halo-no-such-cmd-xyz*halo-missing-abc*)
    case "$err" in
      *" bash"*) flunk "stderr lists only missing names ($err)" ;;
      *) pass "stderr lists missing names" ;;
    esac ;;
  *) flunk "stderr lists missing names (got: $err)" ;;
esac

# (c) executor-claude/run.sh を jq 抜き PATH で起動 → stuck JSON + exit 0
STUB="$TMP/bin"
mkdir -p "$STUB"
for c in bash env dirname cat; do
  ln -s "$(command -v "$c")" "$STUB/$c"
done
out="$(echo '{}' | PATH="$STUB" bash "$DIR/../executor-claude/run.sh")"
rc=$?
if [ "$rc" -eq 0 ]; then
  pass "executor without jq -> exit 0"
else
  flunk "executor without jq -> exit 0 (got $rc)"
fi
case "$out" in
  '{"status":"stuck","summary":"missing commands:'*jq*)
    pass "executor without jq -> stuck JSON ($out)" ;;
  *)
    flunk "executor without jq -> stuck JSON (got: $out)" ;;
esac

exit $fail
