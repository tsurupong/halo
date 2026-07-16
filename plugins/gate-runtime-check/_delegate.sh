#!/usr/bin/env bash
# gate-runtime-check 共通委譲ロジック（D1 §1.4 / D5 §2.4）。
# gate.in JSON {task_id, workdir, changed_files} を runtime.in {workdir, changed_files} に変換し、
# 採用 runtime（既定: 隣接の runtime-node-pnpm、HALO_RUNTIME_DIR で上書き）の指定スクリプトへ委譲する。
# 終了コードを gate 規約へ伝播: pass=exit 0（stdout 空）/ fail=exit 2 + gate.out {reason, gate}。
# gate 側にコマンドを重複させない薄いラッパー（DRY、D5 §3.2 の注記）。
#   引数: $1=gate 名（例 10-typecheck）  $2=runtime スクリプト名（例 check.sh）
set -uo pipefail

gate="$1"
runtime_script="$2"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${HALO_RUNTIME_DIR:-$HERE/../runtime-node-pnpm}"

emit_fail() { jq -cn --arg r "$1" --arg g "$gate" '{reason:$r, gate:$g}'; exit 2; }

# 依存コマンドのプリフライト（D10 §5）。jq 不在時は emit_fail が使えないため printf で組む。
. "$HERE/../lib/require.sh"
if ! missing="$(require_cmds jq 2>&1)"; then
  printf '{"reason":"%s","gate":"%s"}\n' "$missing" "$gate"
  exit 2
fi

input="$(cat)"
workdir="$(jq -r '.workdir // empty' <<<"$input")"
[[ -n "$workdir" ]] || emit_fail "invalid gate input: workdir required"

script_path="$RUNTIME_DIR/$runtime_script"
[[ -f "$script_path" ]] || emit_fail "runtime script not found: $script_path"

# runtime.in へ変換して委譲。runtime の stdout は契約上空だが、念のため stderr へ寄せて
# gate の JSON 契約チャネル（stdout）を汚さない。
runtime_in="$(jq -c '{workdir: .workdir, changed_files: (.changed_files // [])}' <<<"$input")"
echo "$runtime_in" | bash "$script_path" >&2
code=$?

(( code == 0 )) || emit_fail "$gate failed (runtime $runtime_script exit $code)"
exit 0
