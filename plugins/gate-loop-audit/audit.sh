#!/usr/bin/env bash
# gate-loop-audit / 50-loop-audit（D4 §4 / D5 §3.3 / 要件 §11.1）: 自己改変防止の構造検査ゲート。
# HALO の安全不変条件を担う最重要 gate。判定はすべて git diff ベースの静的検査で決定的に行う。
# stdin の gate.in JSON {task_id, workdir, changed_files} を受け取り、7 検査を順に実行する。
#   ① spec_refs 実在      … グラフ依存。Phase 1 はスキップ/空許容（pass-with-warning、D6 私有管轄）
#   ② テストファイル不変  … テストの削除・変更は fail（新規追加は許可）
#   ③ エスケープハッチ新規ゼロ … 追加行の eslint-disable / as any / @ts-ignore を fail
#   ④ カバレッジ閾値不変  … 閾値数値の下方改変を fail
#   ⑤ 自己改変の禁止      … CLAUDE.md / PROMPT.md / .harness.yml / テストへの変更を fail
#   ⑥ diff 1500 行上限    … 追加+削除の合計が 1500 超で fail
#   ⑦ グラフ改変検出      … グラフ依存。Phase 1 はスキップ（pass-with-warning）
# 1 項目でも違反があれば gate.out JSON {reason, hint?, gate:"50-loop-audit"} を出し exit 2。
# 全通過なら stdout 空・exit 0。
set -uo pipefail

GATE="50-loop-audit"
MAX_DIFF_LINES="${HALO_MAX_DIFF_LINES:-1500}"

fail() { # $1 reason  $2 hint(optional)
  jq -cn --arg r "$1" --arg h "${2:-}" --arg g "$GATE" \
    'if $h == "" then {reason:$r, gate:$g} else {reason:$r, hint:$h, gate:$g} end'
  exit 2
}

is_test_file() {
  case "$1" in
    *.test.*|*_test.*|test_*.py) return 0 ;;
    tests/*|*/tests/*) return 0 ;;
    *) return 1 ;;
  esac
}

is_protected_file() {
  local base="${1##*/}"
  case "$base" in
    CLAUDE.md|PROMPT.md|.harness.yml) return 0 ;;
    *) return 1 ;;
  esac
}

input="$(cat)"
workdir="$(jq -r '.workdir // empty' <<<"$input")"
[[ -n "$workdir" && -d "$workdir" ]] || fail "workdir 不正: '$workdir'"
git -C "$workdir" rev-parse --git-dir >/dev/null 2>&1 || fail "workdir が git リポジトリではない: $workdir"

# intent-to-add: 未追跡の新規ファイルも diff HEAD に現れるようにする（作業ツリーは変更しない）。
git -C "$workdir" add -A -N >/dev/null 2>&1 || true

# 作業ツリーの未コミット差分（HEAD 比）を検査対象とする。
numstat="$(git -C "$workdir" diff HEAD --numstat 2>/dev/null)"
namestatus="$(git -C "$workdir" diff HEAD --name-status 2>/dev/null)"
diff="$(git -C "$workdir" diff HEAD 2>/dev/null)"

# ⑥ diff 1500 行上限
total=0
if [[ -n "$numstat" ]]; then
  while read -r add del _; do
    [[ "$add" =~ ^[0-9]+$ ]] && total=$((total + add))
    [[ "$del" =~ ^[0-9]+$ ]] && total=$((total + del))
  done <<<"$numstat"
fi
(( total > MAX_DIFF_LINES )) && fail "diff ${total} 行 > ${MAX_DIFF_LINES}。タスクを分割せよ"

# ②/⑤ ファイル単位検査（name-status: A/M/D/R…）
if [[ -n "$namestatus" ]]; then
  while IFS=$'\t' read -r status path rest; do
    [[ -z "$status" ]] && continue
    # リネーム（R###）は新パスを対象にする
    if [[ "$status" == R* && -n "$rest" ]]; then path="$rest"; fi
    [[ -z "$path" ]] && continue
    # ⑤ 自己改変（ルール類）の禁止 — 変更種別を問わず fail
    if is_protected_file "$path"; then
      fail "${path##*/} への自己改変が検出された（変更: $path）" "ハーネスのルール類は L2 上限・人間承認が必要"
    fi
    # ② テストファイルの削除・変更は fail（新規追加 A は許可）
    if is_test_file "$path" && [[ "$status" != A ]]; then
      fail "テストファイル $path が変更/削除された（status=$status）" "テストの改変は禁止（新規追加のみ許可）"
    fi
  done <<<"$namestatus"
fi

# ③ エスケープハッチ新規ゼロ（追加行のみ、+++ ヘッダは除外）
added="$(grep '^+' <<<"$diff" | grep -v '^+++')"
if grep -Eq 'eslint-disable|as any|@ts-ignore' <<<"$added"; then
  hatch="$(grep -Eo 'eslint-disable|as any|@ts-ignore' <<<"$added" | head -1)"
  fail "新規エスケープハッチ（${hatch}）が追加された" "既存維持は可、新規追加はゼロ強制"
fi

# ④ カバレッジ閾値の下方改変（threshold 系キーワード行の数値を比較）
rem_th="$(grep -E '^-' <<<"$diff" | grep -Ei 'coverage|threshold|branches|statements|functions|lines' | grep -E '[0-9]')"
add_th="$(grep -E '^\+' <<<"$diff" | grep -Ei 'coverage|threshold|branches|statements|functions|lines' | grep -E '[0-9]')"
if [[ -n "$rem_th" && -n "$add_th" ]]; then
  rmax=-1; amin=100000
  while read -r line; do
    n="$(grep -oE '[0-9]+' <<<"$line" | head -1)"
    [[ -n "$n" ]] && (( n > rmax )) && rmax=$n
  done <<<"$rem_th"
  while read -r line; do
    n="$(grep -oE '[0-9]+' <<<"$line" | head -1)"
    [[ -n "$n" ]] && (( n < amin )) && amin=$n
  done <<<"$add_th"
  if (( rmax >= 0 && amin < 100000 && amin < rmax )); then
    fail "カバレッジ閾値が ${rmax} → ${amin} に改変された" "閾値の下方変更は禁止"
  fi
fi

# ①⑦ グラフ依存検査（spec_refs 実在照会 / グラフ改変検出）は Phase 1 ではスキップ。
# kg:// の実在照会は D6 の私有プラグイン（knowledge MCP）管轄。空許容で pass-with-warning。
echo "loop-audit: ①spec_refs 実在 / ⑦グラフ改変検出 は Phase 1 でスキップ（pass-with-warning）" >&2

# 全通過 — stdout は空、exit 0。
exit 0
