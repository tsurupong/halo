#!/usr/bin/env bash
# Mock task-source plugin (D8 §2.2): returns a fixed JSON task, never calls the
# network. On `op=next` it hands out task_id "1" for the first TS_REPEAT calls
# (default 1) then `{"task_id":null}` to end the loop. `op=complete` records a
# marker so the test can assert Complete fired. Zero billing.
set -euo pipefail
input="$(cat)"
state="${STATE_DIR:?STATE_DIR required}"
case "$input" in
  *'"op":"next"'*)
    f="$state/ts_next"
    n="$(cat "$f" 2>/dev/null || echo 0)"
    echo $((n + 1)) > "$f"
    if [ "$n" -lt "${TS_REPEAT:-1}" ]; then
      echo '{"task_id":"1","title":"do the thing","body":"requirement text"}'
    else
      echo '{"task_id":null}'
    fi
    ;;
  *'"op":"complete"'*)
    echo "$input" >> "$state/ts_complete"
    ;;
  *)
    echo "$input" >> "$state/ts_other"
    ;;
esac
exit 0
