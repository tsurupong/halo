#!/usr/bin/env bash
# Mock sink plugin (D8 §2.2): side effect only — appends a marker so the test can
# assert it ran after the autonomy filter. No output.
set -euo pipefail
cat > /dev/null
echo "ran" >> "${STATE_DIR:?STATE_DIR required}/sink_${PLUGIN_NAME:-sink}"
exit 0
