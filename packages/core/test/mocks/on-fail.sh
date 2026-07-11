#!/usr/bin/env bash
# Mock on-fail plugin (D8 §2.2): records each failure input so the test can assert
# the failure path fired and inspect the re-injected retry_count. No output.
set -euo pipefail
input="$(cat)"
echo "$input" >> "${STATE_DIR:?STATE_DIR required}/onfail"
exit 0
