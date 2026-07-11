#!/usr/bin/env bash
# 軽量 contract test: gate-runtime-check（10-typecheck / 30-test）が採用 runtime の
# check.sh / test.sh へ委譲し終了コードを gate 規約へ伝播するか検証する。
# pnpm は PATH 上のスタブに差し替え（STUB_EXIT で pass/fail を制御）、実 pnpm・課金なしで契約を検証する。
#   - pass: runtime 成功 -> gate exit 0, stdout 空
#   - fail: runtime 失敗 -> gate exit 2, gate.out {reason, gate:"<name>"} 適合
#   - workdir 欠落 -> exit 2, gate.out 適合
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

# --- pnpm スタブ: STUB_EXIT で check/test の成否を制御 ---
mkdir -p "$TMP/bin"
cat >"$TMP/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
echo "pnpm stub: $*" >&2
exit "${STUB_EXIT:-0}"
STUB
chmod +x "$TMP/bin/pnpm"
export PATH="$TMP/bin:$PATH"

mkdir -p "$TMP/wt"
INPUT="$(jq -cn --arg w "$TMP/wt" '{task_id:"T-1", workdir:$w, changed_files:["src/a.ts"]}')"

run_case() { # $1 subdir  $2 gate-name  $3 stub_exit  $4 expect_code  $5 label
  local out code
  out="$(STUB_EXIT="$3" bash "$DIR/$1/run.sh" <<<"$INPUT" 2>/dev/null)"
  code=$?
  if [[ "$code" -ne "$4" ]]; then
    echo "FAIL  $5 (expected exit $4 got $code, out=[$out])"; fail=1; return
  fi
  if [[ "$4" -eq 0 ]]; then
    if [[ -z "$out" ]]; then echo "PASS  $5 (exit 0, stdout empty)"; else echo "FAIL  $5 stdout not empty: [$out]"; fail=1; fi
  else
    if jq -e --arg g "$2" '(.reason|type=="string") and .gate==$g' >/dev/null 2>&1 <<<"$out"; then
      echo "PASS  $5 (exit 2, gate.out shape)"
    else
      echo "FAIL  $5 bad gate.out: [$out]"; fail=1
    fi
  fi
}

# 10-typecheck: check.sh 委譲
run_case 10-typecheck 10-typecheck 0 0 "typecheck pass -> exit 0"
run_case 10-typecheck 10-typecheck 1 2 "typecheck fail -> exit 2 + gate.out"
# 30-test: test.sh 委譲
run_case 30-test 30-test 0 0 "test pass -> exit 0"
run_case 30-test 30-test 1 2 "test fail -> exit 2 + gate.out"

# workdir 欠落 -> exit 2 + gate.out
out="$(echo '{"task_id":"T-1","changed_files":[]}' | bash "$DIR/10-typecheck/run.sh" 2>/dev/null)"; code=$?
if [[ $code -eq 2 ]] && jq -e '.gate=="10-typecheck" and (.reason|type=="string")' >/dev/null 2>&1 <<<"$out"; then
  echo "PASS  missing workdir -> exit 2 + gate.out"
else
  echo "FAIL  missing workdir: code=$code out=[$out]"; fail=1
fi

exit "$fail"
