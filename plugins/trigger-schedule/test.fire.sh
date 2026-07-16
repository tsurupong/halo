#!/usr/bin/env bash
# fire 単体テスト: PATH 洗い直し（$HOME/.local/bin と HALO_PATH_EXTRA）と
# --cwd "$HALO_HOME" の伝播を検証する（D10 §2 / ADR-0015）。
# 既存 test.contract.sh には触れず、追加検証は本ファイルで行う。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

# --- halo CLI スタブ: 呼び出し引数と実行時 PATH を記録する ---
HALO_HOME="$TMP/halo"
mkdir -p "$HALO_HOME/node_modules/.bin"
cat >"$HALO_HOME/node_modules/.bin/halo" <<STUB
#!/usr/bin/env bash
echo "\$*" > "$TMP/halo.args"
echo "\$PATH" > "$TMP/halo.path"
exit 0
STUB
chmod +x "$HALO_HOME/node_modules/.bin/halo"

# --- (a) run <profile> --cwd <HALO_HOME> がスタブに渡ること ---
HALO_HOME="$HALO_HOME" bash "$DIR/fire" nightly >/dev/null 2>&1
if [[ $? -eq 0 && "$(cat "$TMP/halo.args" 2>/dev/null)" == "run nightly --cwd $HALO_HOME" ]]; then
  echo "PASS  fire invokes halo run nightly --cwd \$HALO_HOME"
else
  echo "FAIL  fire args=[$(cat "$TMP/halo.args" 2>/dev/null)]"; fail=1
fi

# --- (b) 洗い直し後の PATH に $HOME/.local/bin が含まれること ---
if [[ ":$(cat "$TMP/halo.path" 2>/dev/null):" == *":$HOME/.local/bin:"* ]]; then
  echo "PASS  sanitized PATH contains \$HOME/.local/bin"
else
  echo "FAIL  PATH=[$(cat "$TMP/halo.path" 2>/dev/null)]"; fail=1
fi

# --- (c) HALO_PATH_EXTRA=/opt/x が PATH 末尾に付くこと ---
HALO_HOME="$HALO_HOME" HALO_PATH_EXTRA=/opt/x bash "$DIR/fire" nightly >/dev/null 2>&1
if [[ "$(cat "$TMP/halo.path" 2>/dev/null)" == *":/opt/x" ]]; then
  echo "PASS  HALO_PATH_EXTRA appended to PATH tail"
else
  echo "FAIL  PATH=[$(cat "$TMP/halo.path" 2>/dev/null)]"; fail=1
fi

exit "$fail"
