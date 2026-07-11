#!/usr/bin/env bash
# task-source-github（D1 §1.1 / D5 §3.1）: GitHub Issues をタスクの源にするアダプタ。
# stdin の task-source.in JSON（op=next/complete/fail、oneOf）を受け取り、gh CLI を叩く。
#   next     : ready 先頭 Issue を取得し ready→in-progress へ付け替え、task-source.out を stdout へ。
#              ready 0 件なら {"task_id":null} + exit 0。
#   complete : 完了記録（in-progress→done、PR URL をコメント）。副作用のみ、stdout 空。
#   fail     : リトライをコメント記録。retry_count>=THRESHOLD で needs-human 付与。副作用のみ。
# stdout は JSON 契約チャネル。complete/fail では何も出さない（D1 §3.2）。
set -uo pipefail

FAIL_THRESHOLD="${HALO_FAIL_THRESHOLD:-3}"

input="$(cat)"
op="$(jq -r '.op // empty' <<<"$input")"

die() { echo "task-source-github: $1" >&2; exit "${2:-2}"; }

case "$op" in
  next)
    issue="$(gh issue list --label ready --state open --limit 1 \
      --json number,title,body,labels 2>/dev/null | jq '.[0] // null')"
    if [[ -z "$issue" || "$issue" == "null" ]]; then
      echo '{"task_id":null}'      # ready 0 件 → コアは即 exit 0
      exit 0
    fi
    num="$(jq -r '.number' <<<"$issue")"
    [[ "$num" =~ ^[0-9]+$ ]] || die "invalid issue number from gh"
    # kind:<name> ラベル由来。無指定時は code（D5 §3.1）。
    kind="$(jq -r '([.labels[].name | select(startswith("kind:"))][0] // "kind:code") | sub("^kind:";"")' <<<"$issue")"
    # 多重取得防止のロック（ready→in-progress）。診断は stderr へ。
    gh issue edit "$num" --add-label in-progress --remove-label ready >&2
    jq -cn \
      --arg id "T-$num" \
      --arg title "$(jq -r '.title // ""' <<<"$issue")" \
      --arg body "$(jq -r '.body // ""' <<<"$issue")" \
      --arg kind "$kind" \
      '{task_id:$id, title:$title, body:$body, kind:$kind}'
    ;;
  complete)
    task_id="$(jq -r '.task_id // empty' <<<"$input")"
    pr_url="$(jq -r '.pr_url // empty' <<<"$input")"
    [[ -n "$task_id" && -n "$pr_url" ]] || die "complete requires task_id and pr_url"
    num="${task_id#T-}"
    # PR 本文の Closes #num でマージ時に自動クローズされる前提。ここでは記録のみ。
    gh issue comment "$num" --body "completed via PR: $pr_url" >&2 || true
    gh issue edit "$num" --add-label done --remove-label in-progress >&2 || true
    ;;
  fail)
    task_id="$(jq -r '.task_id // empty' <<<"$input")"
    reason="$(jq -r '.reason // ""' <<<"$input")"
    rc="$(jq -r '.retry_count // 0' <<<"$input")"
    [[ -n "$task_id" ]] || die "fail requires task_id"
    num="${task_id#T-}"
    gh issue comment "$num" --body "fail #$rc: $reason" >&2 || true
    # 同一 Issue で THRESHOLD 回失敗 → needs-human でエスカレーション（無限ループ遮断）。
    if [[ "$rc" =~ ^[0-9]+$ ]] && (( rc >= FAIL_THRESHOLD )); then
      gh issue edit "$num" --add-label needs-human --remove-label in-progress >&2 || true
    fi
    ;;
  *)
    die "unknown op: '$op'"
    ;;
esac
exit 0
