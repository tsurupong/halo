#!/usr/bin/env bash
# Mock gate plugin (D8 §2.2): follows the D1 §3.1 exit-code contract (0=pass,
# 2=fail with a gate.out JSON). GATE_MODE selects behavior:
#   pass           always exit 0
#   fail           always exit 2 with a reason
#   fail_then_pass exit 2 on the first call, exit 0 afterwards (retry recovery)
set -euo pipefail
cat > /dev/null
state="${STATE_DIR:?STATE_DIR required}"
case "${GATE_MODE:-pass}" in
  pass)
    exit 0
    ;;
  fail)
    echo '{"reason":"coverage 87% < 90%","hint":"add tests","gate":"30-test"}'
    exit 2
    ;;
  fail_then_pass)
    f="$state/gate"
    n="$(cat "$f" 2>/dev/null || echo 0)"
    echo $((n + 1)) > "$f"
    if [ "$n" -lt 1 ]; then
      echo '{"reason":"coverage 87% < 90%","hint":"add tests","gate":"30-test"}'
      exit 2
    fi
    exit 0
    ;;
esac
