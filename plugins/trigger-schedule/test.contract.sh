#!/usr/bin/env bash
# 軽量 contract test: trigger-schedule の fire/install/uninstall を検証する。
# trigger は stdin JSON を持たず（D1 §1.9）、検証対象は「fire が halo CLI を
# 絶対パスで run <profile> 起動するか」「install/uninstall の終了コードと冪等性」。
# schtasks.exe / halo CLI はスタブに差し替え、実スケジューラ・課金なしで契約を検証する。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

# --- halo CLI スタブ: 呼び出し引数を記録する ---
HALO_HOME="$TMP/halo"
mkdir -p "$HALO_HOME/node_modules/.bin"
cat >"$HALO_HOME/node_modules/.bin/halo" <<STUB
#!/usr/bin/env bash
echo "\$*" > "$TMP/halo.args"
exit 0
STUB
chmod +x "$HALO_HOME/node_modules/.bin/halo"

# --- fire: 絶対パスの halo を run <profile> で起動するか ---
HALO_HOME="$HALO_HOME" bash "$DIR/fire" nightly >/dev/null 2>&1
if [[ $? -eq 0 && "$(cat "$TMP/halo.args" 2>/dev/null)" == "run nightly --cwd $HALO_HOME" ]]; then
  echo "PASS  fire invokes .bin/halo run nightly --cwd \$HALO_HOME"
else
  echo "FAIL  fire args=[$(cat "$TMP/halo.args" 2>/dev/null)]"; fail=1
fi

# --- fire: プロファイル引数が無ければ非 0 で落ちる ---
HALO_HOME="$HALO_HOME" bash "$DIR/fire" >/dev/null 2>&1
[[ $? -ne 0 ]] && echo "PASS  fire without profile -> nonzero" || { echo "FAIL  fire without profile"; fail=1; }

# --- fire: halo CLI が無ければ非 0 で落ちる ---
HALO_HOME="$TMP/missing" bash "$DIR/fire" nightly >/dev/null 2>&1
[[ $? -ne 0 ]] && echo "PASS  fire without halo bin -> nonzero" || { echo "FAIL  fire missing bin"; fail=1; }

# --- schtasks.exe スタブ（install/uninstall 用）: /Create の全引数を記録する ---
mkdir -p "$TMP/bin"
cat >"$TMP/bin/schtasks.exe" <<STUB
#!/usr/bin/env bash
for a in "\$@"; do [[ "\$a" == /Create ]] && { printf '%s\n' "\$*" > "$TMP/schtasks.create"; break; }; done
exit 0
STUB
chmod +x "$TMP/bin/schtasks.exe"
export PATH="$TMP/bin:$PATH"

INSTALL_BIN="$HALO_HOME/node_modules/.bin/halo"
PATH="$TMP/bin:$PATH" HALO_SCHEDULER=schtasks HALO_HOME="$HALO_HOME" HALO_BIN="$INSTALL_BIN" bash "$DIR/install.sh" nightly >/dev/null 2>&1
[[ $? -eq 0 ]] && echo "PASS  install -> exit 0" || { echo "FAIL  install exit"; fail=1; }

# --- install: TR 文字列へ HALO_BIN/HALO_HOME が永続化されているか（発火時フォールバック防止） ---
CREATE_ARGS="$(cat "$TMP/schtasks.create" 2>/dev/null)"
if [[ "$CREATE_ARGS" == *"HALO_HOME=\"$HALO_HOME\""* && "$CREATE_ARGS" == *"HALO_BIN=\"$INSTALL_BIN\""* ]]; then
  echo "PASS  install persists HALO_BIN/HALO_HOME into TR string"
else
  echo "FAIL  TR string missing env: [$CREATE_ARGS]"; fail=1
fi

PATH="$TMP/bin:$PATH" HALO_SCHEDULER=schtasks bash "$DIR/uninstall.sh" nightly >/dev/null 2>&1
[[ $? -eq 0 ]] && echo "PASS  uninstall -> exit 0" || { echo "FAIL  uninstall exit"; fail=1; }

exit "$fail"
