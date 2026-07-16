#!/usr/bin/env bash
# 軽量 contract test: sink-git-commit が gate 通過済み worktree の変更をコミットする契約を検証。
#   (a) 変更あり → タスクブランチに 1 コミット追加、stdout 空、exit 0
#   (b) 変更なし → コミットされない
#   (c) workdir が git 外 → スキップ (exit 0)
#   (d) task_id 欠落 → スキップ (exit 0)
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

# --- 使い捨てリポジトリ (worktree 相当) を用意 ---
REPO="$TMP/wt"
mkdir -p "$REPO"
git -C "$REPO" init -q -b feature/issue-T-1
git -C "$REPO" -c user.name=seed -c user.email=seed@x commit -q --allow-empty -m seed
base="$(git -C "$REPO" rev-parse HEAD)"

# --- (a) 変更あり → コミット ---
echo "new code" >"$REPO/impl.txt"
IN="$(jq -cn --arg w "$REPO" '{task_id:"T-1", workdir:$w, summary:"did the thing"}')"
out="$(bash "$DIR/commit.sh" <<<"$IN" 2>/dev/null)"; code=$?
head="$(git -C "$REPO" rev-parse HEAD)"
if [[ $code -eq 0 && -z "$out" && "$head" != "$base" ]] \
   && git -C "$REPO" log -1 --format=%s | grep -q "complete task T-1" \
   && [[ -z "$(git -C "$REPO" status --porcelain)" ]]; then
  echo "PASS  changes committed to task branch (stdout empty)"
else
  echo "FAIL  commit: code=$code out=[$out] head=$head base=$base"; fail=1
fi

# --- (b) 変更なし → コミットしない ---
out="$(bash "$DIR/commit.sh" <<<"$IN" 2>/dev/null)"; code=$?
if [[ $code -eq 0 && "$(git -C "$REPO" rev-parse HEAD)" == "$head" ]]; then
  echo "PASS  no changes -> no commit"
else
  echo "FAIL  empty-diff guard: code=$code"; fail=1
fi

# --- (c) git 外の workdir → スキップ ---
mkdir -p "$TMP/plain"
IN2="$(jq -cn --arg w "$TMP/plain" '{task_id:"T-2", workdir:$w, summary:"x"}')"
out="$(bash "$DIR/commit.sh" <<<"$IN2" 2>/dev/null)"; code=$?
if [[ $code -eq 0 && -z "$out" ]]; then
  echo "PASS  non-git workdir -> best-effort skip"
else
  echo "FAIL  non-git skip: code=$code"; fail=1
fi

# --- (d) task_id 欠落 → スキップ ---
out="$(bash "$DIR/commit.sh" <<<'{"workdir":"/tmp","summary":"x"}' 2>/dev/null)"; code=$?
if [[ $code -eq 0 && -z "$out" ]]; then
  echo "PASS  missing task_id -> skip (exit 0)"
else
  echo "FAIL  missing task_id: code=$code"; fail=1
fi

exit "$fail"
