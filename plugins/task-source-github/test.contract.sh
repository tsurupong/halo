#!/usr/bin/env bash
# 軽量 contract test: task-source-github の next/complete/fail 3 経路を検証する。
# gh CLI はスタブに差し替え、実 GitHub・課金・ネットワークなしで契約だけを検証する。
#   - next の出力が task-source.out.json の形（task_id 必須、null 許容）に適合するか
#   - ready 0 件で {"task_id":null} + exit 0 か
#   - complete/fail は副作用のみで stdout が空か（JSON 契約チャネル cleanliness）
#   - fail retry>=3 で needs-human ラベルを付けるか
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

# --- gh スタブ: 呼び出しを記録し、GH_ISSUE_JSON で list 出力を制御する ---
mkdir -p "$TMP/bin"
cat >"$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >> "$GH_LOG"
case "$1 $2" in
  "issue list")
    printf '%s' "${GH_ISSUE_JSON:-[]}"
    ;;
  "issue edit"|"issue comment")
    : # 副作用スタブ
    ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH"
export GH_LOG="$TMP/gh.log"

check_json_shape() { jq -e "$1" >/dev/null 2>&1 <<<"$2"; }

# --- next: ready あり → task-source.out 適合 + ラベル付け替え ---
: > "$GH_LOG"
out="$(GH_ISSUE_JSON='[{"number":42,"title":"add feature","body":"do it","labels":[{"name":"ready"},{"name":"kind:code"}]}]' \
  bash "$DIR/index.sh" <<<'{"op":"next"}' 2>/dev/null)"
code=$?
if [[ $code -eq 0 ]] \
  && check_json_shape '.task_id=="T-42" and (.title|type=="string") and (.body|type=="string") and .kind=="code"' "$out"; then
  echo "PASS  next -> task-source.out shape (task_id T-42, kind code)"
else
  echo "FAIL  next shape: code=$code out=[$out]"; fail=1
fi
if grep -q 'issue edit 42 --add-label in-progress --remove-label ready' "$GH_LOG"; then
  echo "PASS  next flips ready -> in-progress"
else
  echo "FAIL  next did not flip label; log=[$(cat "$GH_LOG")]"; fail=1
fi

# --- next: ready 0 件 → {"task_id":null} + exit 0 ---
out="$(GH_ISSUE_JSON='[]' bash "$DIR/index.sh" <<<'{"op":"next"}' 2>/dev/null)"
code=$?
if [[ $code -eq 0 ]] && check_json_shape '.task_id==null' "$out"; then
  echo "PASS  next with 0 ready -> {task_id:null} exit 0"
else
  echo "FAIL  next empty: code=$code out=[$out]"; fail=1
fi

# --- complete: 副作用のみ、stdout 空、exit 0 ---
: > "$GH_LOG"
out="$(bash "$DIR/index.sh" <<<'{"op":"complete","task_id":"T-42","pr_url":"https://github.com/o/r/pull/9"}' 2>/dev/null)"
code=$?
if [[ $code -eq 0 && -z "$out" ]]; then
  echo "PASS  complete -> stdout empty, exit 0"
else
  echo "FAIL  complete: code=$code out=[$out]"; fail=1
fi

# --- fail (retry<3): コメントのみ、needs-human なし、stdout 空 ---
: > "$GH_LOG"
out="$(bash "$DIR/index.sh" <<<'{"op":"fail","task_id":"T-42","reason":"tests red","retry_count":1}' 2>/dev/null)"
code=$?
if [[ $code -eq 0 && -z "$out" ]] && ! grep -q 'needs-human' "$GH_LOG"; then
  echo "PASS  fail retry=1 -> comment only, no needs-human, stdout empty"
else
  echo "FAIL  fail retry<3: code=$code out=[$out] log=[$(cat "$GH_LOG")]"; fail=1
fi

# --- fail (retry>=3): needs-human エスカレーション ---
: > "$GH_LOG"
bash "$DIR/index.sh" <<<'{"op":"fail","task_id":"T-42","reason":"still red","retry_count":3}' >/dev/null 2>&1
if grep -q 'add-label needs-human' "$GH_LOG"; then
  echo "PASS  fail retry=3 -> needs-human escalation"
else
  echo "FAIL  fail retry=3 no escalation; log=[$(cat "$GH_LOG")]"; fail=1
fi

# --- 不正 op → exit 2, stdout 空 ---
out="$(bash "$DIR/index.sh" <<<'{"op":"bogus"}' 2>/dev/null)"
code=$?
if [[ $code -eq 2 && -z "$out" ]]; then
  echo "PASS  unknown op -> exit 2, stdout empty"
else
  echo "FAIL  unknown op: code=$code out=[$out]"; fail=1
fi

exit "$fail"
