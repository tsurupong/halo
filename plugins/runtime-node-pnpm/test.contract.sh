#!/usr/bin/env bash
# 軽量 contract test: runtime-node-pnpm の setup/check/test スクリプトが
# stdin の runtime.in JSON を読み、exit 0=pass / exit 2=fail の規約を守るか検証する。
# pnpm は PATH 上のスタブに差し替え、課金・ネットワーク・実 pnpm 無しで契約だけを検証する。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- pnpm スタブ: STUB_EXIT で終了コードを制御する ---
mkdir -p "$TMP/bin"
cat >"$TMP/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
echo "pnpm stub called: $*" >&2
exit "${STUB_EXIT:-0}"
STUB
chmod +x "$TMP/bin/pnpm"
export PATH="$TMP/bin:$PATH"

mkdir -p "$TMP/wt"
INPUT="$(jq -cn --arg w "$TMP/wt" '{workdir:$w, changed_files:["src/a.ts"]}')"

fail=0
run_case() {
  local script="$1" expect="$2" stub_exit="$3" label="$4"
  STUB_EXIT="$stub_exit" bash "$DIR/$script" <<<"$INPUT" >/dev/null 2>&1
  local got=$?
  if [[ "$got" -eq "$expect" ]]; then
    echo "PASS  $label ($script exit=$got)"
  else
    echo "FAIL  $label ($script expected=$expect got=$got)"; fail=1
  fi
}

# setup: pnpm 成功→0 / 失敗→2
run_case setup.sh 0 0 "setup succeeds -> exit 0"
run_case setup.sh 2 1 "setup pnpm fails -> exit 2"
# check: tsc/eslint 成功→0 / 失敗→2
run_case check.sh 0 0 "check passes -> exit 0"
run_case check.sh 2 1 "check fails -> exit 2"
# test: vitest 成功→0 / 失敗→2
run_case test.sh 0 0 "test passes -> exit 0"
run_case test.sh 2 1 "test fails -> exit 2"

# workdir 欠落は入力不正 → exit 2
echo '{}' | bash "$DIR/check.sh" >/dev/null 2>&1
if [[ $? -eq 2 ]]; then echo "PASS  missing workdir -> exit 2"; else echo "FAIL  missing workdir"; fail=1; fi

exit "$fail"
