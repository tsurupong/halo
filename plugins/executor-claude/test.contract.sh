#!/usr/bin/env bash
# 軽量 contract test: executor-claude が executor.in を受け executor.out を返す契約を検証する。
# claude はスタブに全面差し替え（課金ゼロ・実行なし）。CLAUDE_STUB_OUT/CLAUDE_STUB_EXIT で挙動を注入する。
#   - done: 正常出力 → status:"done"
#   - stuck: [HALO:STUCK] マーカー検出 → status:"stuck"
#   - timeout: 非対話実行が timeout(124) → status:"timeout"
#   - 非 0 終了 → status:"stuck"
#   - 出力は常に status(enum)+summary を持つ executor.out 形（stdout は 1 JSON のみ）
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

# --- claude スタブ ---
mkdir -p "$TMP/bin"
cat >"$TMP/bin/claude" <<'STUB'
#!/usr/bin/env bash
if [[ -n "${CLAUDE_ARGS_FILE:-}" ]]; then printf '%s\n' "$@" > "$CLAUDE_ARGS_FILE"; fi
printf '%s\n' "${CLAUDE_STUB_OUT:-ok}"
exit "${CLAUDE_STUB_EXIT:-0}"
STUB
chmod +x "$TMP/bin/claude"
export PATH="$TMP/bin:$PATH"

mkdir -p "$TMP/wt"
IN="$(jq -cn --arg w "$TMP/wt" '{prompt:"do the thing", workdir:$w, budget:{max_turns:40,timeout_sec:900}}')"

# executor.out の enum を含む形検証
assert_out() { # $1 expected_status $2 out $3 label
  local st; st="$(jq -r '.status' 2>/dev/null <<<"$2")"
  if jq -e '(.status|type=="string") and (.summary|type=="string") and (.status|IN("done","stuck","timeout"))' >/dev/null 2>&1 <<<"$2" \
     && [[ "$st" == "$1" ]]; then
    echo "PASS  $3 (status=$st)"
  else
    echo "FAIL  $3 expected=$1 out=[$2]"; fail=1
  fi
}

# --- done ---
out="$(CLAUDE_STUB_OUT="patch applied, all green" bash "$DIR/run.sh" <<<"$IN" 2>/dev/null)"
assert_out "done" "$out" "normal run -> done"

# --- stuck marker ---
out="$(CLAUDE_STUB_OUT="tried but [HALO:STUCK] cannot resolve" bash "$DIR/run.sh" <<<"$IN" 2>/dev/null)"
assert_out "stuck" "$out" "STUCK marker -> stuck"

# --- non-zero exit -> stuck ---
out="$(CLAUDE_STUB_OUT="crash" CLAUDE_STUB_EXIT=1 bash "$DIR/run.sh" <<<"$IN" 2>/dev/null)"
assert_out "stuck" "$out" "non-zero claude exit -> stuck"

# --- timeout: claude が 124 を返すよう擬似（timeout ラッパ相当）---
out="$(CLAUDE_STUB_EXIT=124 bash "$DIR/run.sh" <<<"$IN" 2>/dev/null)"
assert_out "timeout" "$out" "exit 124 -> timeout"

# --- 不正入力（prompt 欠落）-> stuck、ただし契約 out 形は維持 ---
out="$(bash "$DIR/run.sh" <<<'{"workdir":"/tmp","budget":{"max_turns":1,"timeout_sec":1}}' 2>/dev/null)"
assert_out "stuck" "$out" "missing prompt -> stuck (valid out shape)"

# --- 無人実行の編集権限: 既定で --permission-mode acceptEdits を付与 ---
out="$(CLAUDE_ARGS_FILE="$TMP/args" bash "$DIR/run.sh" <<<"$IN" 2>/dev/null)"
if grep -qx -- "--permission-mode" "$TMP/args" && grep -qx "acceptEdits" "$TMP/args"; then
  echo "PASS  default --permission-mode acceptEdits passed to claude"
else
  echo "FAIL  permission-mode default: args=[$(tr '\n' ' ' <"$TMP/args")]"; fail=1
fi

# --- HALO_CLAUDE_PERMISSION_MODE で上書き可能 ---
out="$(CLAUDE_ARGS_FILE="$TMP/args2" HALO_CLAUDE_PERMISSION_MODE=plan bash "$DIR/run.sh" <<<"$IN" 2>/dev/null)"
if grep -qx "plan" "$TMP/args2" && ! grep -qx "acceptEdits" "$TMP/args2"; then
  echo "PASS  HALO_CLAUDE_PERMISSION_MODE overrides permission mode"
else
  echo "FAIL  permission-mode override: args=[$(tr '\n' ' ' <"$TMP/args2")]"; fail=1
fi

# --- stdout は 1 個の JSON のみ（余計な行がない）---
line_count="$(CLAUDE_STUB_OUT="ok" bash "$DIR/run.sh" <<<"$IN" 2>/dev/null | grep -c .)"
if [[ "$line_count" -eq 1 ]]; then
  echo "PASS  stdout is a single JSON line"
else
  echo "FAIL  stdout has $line_count lines"; fail=1
fi

exit "$fail"
