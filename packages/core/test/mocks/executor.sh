#!/usr/bin/env bash
# Mock executor plugin (D8 §2.2): echoes a fixed status JSON, never calls claude.
# EXEC_STATUS (done|stuck|timeout) selects the branch. Zero billing.
set -euo pipefail
cat > /dev/null
printf '{"status":"%s","summary":"mock run"}\n' "${EXEC_STATUS:-done}"
exit 0
