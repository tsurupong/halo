#!/usr/bin/env bash
# executor-claude（D1 §1.3 / D5 §2.3, §5.2）: `claude -p` headless アダプタ。
# stdin の executor.in JSON {prompt, workdir, budget:{max_turns,timeout_sec}} を受け取り、
# 使い捨て worktree 内で claude を非対話実行し、executor.out JSON {status, summary, cost?} を stdout へ。
#   - status enum: done / stuck / timeout（done 以外はコアが failure 経路へ回す）
#   - STUCK マーカー（既定 [HALO:STUCK]）を出力に検出したら status:"stuck" へ変換
#   - timeout でハングを status:"timeout" に落とす
#   - --strict-mcp-config で私有 MCP 設定の混入を防ぐ（D1 §5.2）
# worktree のライフサイクル自体はコア（T20/D2 §8）が駆動する。ここはアダプタに徹する。
# 契約出力は常に stdout の JSON。プラグイン自体の exit code は 0（status で経路が決まる）。
set -uo pipefail

STUCK_MARKER="${HALO_STUCK_MARKER:-[HALO:STUCK]}"
# 無人実行の編集権限。既定 acceptEdits がないと headless claude はファイルを
# 変更できず、無変更のまま status:done を返して偽グリーンになる。
PERMISSION_MODE="${HALO_CLAUDE_PERMISSION_MODE:-acceptEdits}"

emit() { jq -cn --arg s "$1" --arg m "$2" '{status:$s, summary:$m}'; exit 0; }

input="$(cat)"
prompt="$(jq -r '.prompt // empty' <<<"$input")"
workdir="$(jq -r '.workdir // empty' <<<"$input")"
max_turns="$(jq -r '.budget.max_turns // 40' <<<"$input")"
timeout_sec="$(jq -r '.budget.timeout_sec // 900' <<<"$input")"

if [[ -z "$prompt" || -z "$workdir" ]]; then
  emit "stuck" "invalid executor input: prompt and workdir are required"
fi
if [[ ! -d "$workdir" ]]; then
  emit "stuck" "workdir does not exist: $workdir"
fi

# claude headless 実行。診断ノイズは捨て、stdout（結果本文）だけを捕捉する。
out="$(cd "$workdir" && timeout "${timeout_sec}s" \
  claude -p "$prompt" \
    --strict-mcp-config \
    --permission-mode "$PERMISSION_MODE" \
    --max-turns "$max_turns" \
    2>/dev/null)"
code=$?

# timeout(1) は時間切れで 124 を返す。
if (( code == 124 )); then
  emit "timeout" "claude timed out after ${timeout_sec}s"
fi

# STUCK マーカー検出 → stuck へ変換（自己申告の行き詰まり）。
if grep -qF "$STUCK_MARKER" <<<"$out"; then
  tail_txt="$(printf '%s' "$out" | tail -n 5 | tr '\n' ' ')"
  emit "stuck" "executor reported stuck: ${tail_txt}"
fi

# 非 0 終了は行き詰まり扱い（failure 経路へ）。
if (( code != 0 )); then
  emit "stuck" "claude exited with code ${code}"
fi

summary="$(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
[[ -n "$summary" ]] || summary="execution completed"
emit "done" "$summary"
