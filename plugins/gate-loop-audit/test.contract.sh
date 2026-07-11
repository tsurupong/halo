#!/usr/bin/env bash
# 軽量 contract test: gate-loop-audit の 7 検査（Phase 1 scope）を実 git リポジトリで検証する。
# フィクスチャ worktree に初期コミット→変更を加え、pass/fail と gate.out 形を確認する。
#   pass: 無害な src 変更 → exit 0, stdout 空
#   ②: テスト改変 → exit 2
#   ③: @ts-ignore 新規追加 → exit 2
#   ④: カバレッジ閾値の下方改変 → exit 2
#   ⑤: PROMPT.md 自己改変 → exit 2
#   ⑥: diff 1500 行超 → exit 2
# fail 時は gate.out.json 形（reason 必須, gate=="50-loop-audit"）を満たすこと。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

new_repo() { # -> echoes workdir path with a clean initial commit
  local wt="$TMP/wt-$RANDOM$RANDOM"
  mkdir -p "$wt"
  git -C "$wt" init -q
  git -C "$wt" config user.email t@e.x
  git -C "$wt" config user.name t
  mkdir -p "$wt/src" "$wt/tests"
  echo "export const a = 1;" > "$wt/src/a.ts"
  echo "test('a', () => {});" > "$wt/src/a.test.ts"
  printf 'coverage:\n  lines: 90\n' > "$wt/vitest.config.txt"
  echo "# prompt" > "$wt/PROMPT.md"
  git -C "$wt" add -A
  git -C "$wt" commit -qm init
  echo "$wt"
}

run_audit() { # $1 workdir -> sets OUT/CODE
  OUT="$(jq -cn --arg w "$1" '{task_id:"T-1", workdir:$w, changed_files:[]}' | bash "$DIR/audit.sh" 2>/dev/null)"
  CODE=$?
}

assert_pass() { # $1 label
  if [[ $CODE -eq 0 && -z "$OUT" ]]; then echo "PASS  $1"; else echo "FAIL  $1: code=$CODE out=[$OUT]"; fail=1; fi
}
assert_fail() { # $1 label
  if [[ $CODE -eq 2 ]] \
     && jq -e '(.reason|type=="string") and .gate=="50-loop-audit"' >/dev/null 2>&1 <<<"$OUT"; then
    echo "PASS  $1"
  else
    echo "FAIL  $1: code=$CODE out=[$OUT]"; fail=1
  fi
}

# pass: 無害な src 変更
wt="$(new_repo)"; echo "export const a = 2;" > "$wt/src/a.ts"
run_audit "$wt"; assert_pass "harmless src change -> exit 0, stdout empty"

# ② テスト改変
wt="$(new_repo)"; echo "test('a', () => { expect(1).toBe(1); });" > "$wt/src/a.test.ts"
run_audit "$wt"; assert_fail "test file modified -> fail (check 2)"

# ② 新規テスト追加は許可（pass）
wt="$(new_repo)"; echo "test('b', () => {});" > "$wt/src/b.test.ts"; git -C "$wt" add "$wt/src/b.test.ts" >/dev/null 2>&1
run_audit "$wt"; assert_pass "new test file added -> pass (check 2 allows add)"

# ③ @ts-ignore 新規追加
wt="$(new_repo)"; printf '// @ts-ignore\nexport const a = 3;\n' > "$wt/src/a.ts"
run_audit "$wt"; assert_fail "@ts-ignore added -> fail (check 3)"

# ④ カバレッジ閾値の下方改変
wt="$(new_repo)"; printf 'coverage:\n  lines: 80\n' > "$wt/vitest.config.txt"
run_audit "$wt"; assert_fail "coverage threshold 90->80 -> fail (check 4)"

# ⑤ PROMPT.md 自己改変
wt="$(new_repo)"; echo "# prompt tampered" > "$wt/PROMPT.md"
run_audit "$wt"; assert_fail "PROMPT.md self-modification -> fail (check 5)"

# ⑥ diff 1500 行超
wt="$(new_repo)"; seq 1 1600 > "$wt/src/big.ts"
run_audit "$wt"; assert_fail "diff > 1500 lines -> fail (check 6)"

# 入力不正（workdir 無し）→ fail 形
OUT="$(echo '{"task_id":"T-1","workdir":"/no/such/dir","changed_files":[]}' | bash "$DIR/audit.sh" 2>/dev/null)"; CODE=$?
assert_fail "missing workdir -> fail with gate.out shape"

exit "$fail"
