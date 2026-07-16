#!/usr/bin/env bash
# 軽量 backend test: trigger-polling の install.sh / uninstall.sh が
# plugins/lib/scheduler.sh のバックエンド抽象へ正しく委譲するかを検証する。
# 検証方式は plugins/lib/test.scheduler.sh と同じスタブ方式:
#   (a) WSL 相当スタブ構成 -> schtasks 形式の登録コマンドが生成される（回帰確認）
#   (b) crontab のみのスタブ構成 -> cron 行が生成される
#   (c) uninstall.sh が対称に解除する
# 実 OS のスケジューラ・実 HOME は一切触らない。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

pass() { echo "PASS  $1"; }
flunk() { echo "FAIL  $1"; fail=1; }

# --- corebin: 実 systemctl/crontab を検出させないための最小 PATH ---
COREBIN="$TMP/corebin"
mkdir -p "$COREBIN"
for c in bash grep cat mkdir rm dirname; do
  ln -s "$(command -v "$c")" "$COREBIN/$c"
done

# --- /proc/version スタブ ---
echo "Linux version 6.0 (microsoft-standard-WSL2)" > "$TMP/proc.wsl"
echo "Linux version 6.0 (generic)" > "$TMP/proc.plain"

# --- schtasks.exe スタブ（argv 記録） ---
WSLBIN="$TMP/stub.wsl"
mkdir -p "$WSLBIN"
cat >"$WSLBIN/schtasks.exe" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$WSLBIN/schtasks.exe.log"
exit 0
STUB
chmod +x "$WSLBIN/schtasks.exe"

# --- crontab スタブ（状態ファイル付きエミュレータ） ---
CRONBIN="$TMP/stub.cron"
mkdir -p "$CRONBIN"
STATE="$CRONBIN/crontab.state"
cat >"$CRONBIN/crontab" <<STUB
#!/usr/bin/env bash
if [ "\${1:-}" = "-l" ]; then
  [ -f "$STATE" ] || { echo "no crontab" >&2; exit 1; }
  cat "$STATE"
elif [ "\${1:-}" = "-" ]; then
  cat > "$STATE"
fi
exit 0
STUB
chmod +x "$CRONBIN/crontab"

# 隔離環境でスクリプトを実行: run_script <stubdir> <procfile> [extra_env...] -- <script> <args...>
run_script() {
  local stub="$1" proc="$2"; shift 2
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  env -i PATH="$stub:$COREBIN" HOME="$TMP/home" HALO_PROC_VERSION="$proc" \
    ${envs[@]+"${envs[@]}"} /bin/bash "$@"
}

FIRE="$DIR/fire"

# ============ (a) WSL 相当スタブ構成: schtasks 形式の登録（回帰確認） ============
run_script "$WSLBIN" "$TMP/proc.wsl" HALO_HOME=/opt/halo HALO_BIN=/opt/halo/bin/halo -- \
  "$DIR/install.sh" p1 >/dev/null 2>&1
rc=$?
create="$(grep '/Create' "$WSLBIN/schtasks.exe.log" 2>/dev/null)"
if [ $rc -eq 0 ] && \
   [[ "$create" == *"/TN HALO_p1"* && "$create" == *"/SC MINUTE /MO 15"* && \
      "$create" == *"/TR wsl.exe -e bash -lc 'HALO_HOME=\"/opt/halo\" HALO_BIN=\"/opt/halo/bin/halo\" $FIRE p1'"* ]]; then
  pass "(a) WSL stubs: install.sh generates schtasks /Create (MINUTE /MO 15, env-embedded TR)"
else
  flunk "(a) schtasks install rc=$rc create=[$create]"
fi

# 間隔の環境変数上書き
rm -f "$WSLBIN/schtasks.exe.log"
run_script "$WSLBIN" "$TMP/proc.wsl" HALO_POLL_INTERVAL_MIN=5 -- "$DIR/install.sh" p1 >/dev/null 2>&1
create="$(grep '/Create' "$WSLBIN/schtasks.exe.log" 2>/dev/null)"
[[ "$create" == *"/SC MINUTE /MO 5"* ]] \
  && pass "(a) HALO_POLL_INTERVAL_MIN=5 -> /MO 5" || flunk "(a) interval override create=[$create]"

# 不正プロファイル名は拒否
run_script "$WSLBIN" "$TMP/proc.wsl" -- "$DIR/install.sh" 'bad name' >/dev/null 2>&1
[ $? -ne 0 ] && pass "(a) invalid profile -> nonzero" || flunk "(a) invalid profile accepted"

# ============ (b) crontab のみのスタブ構成: cron 行が生成される ============
printf '0 0 * * * /keep/me\n' | "$CRONBIN/crontab" -
run_script "$CRONBIN" "$TMP/proc.plain" HALO_BIN=/opt/halo/bin/halo -- \
  "$DIR/install.sh" p1 >/dev/null 2>&1
rc=$?
state="$(cat "$STATE" 2>/dev/null)"
if [ $rc -eq 0 ] && \
   [[ "$state" == *"*/15 * * * * HALO_BIN=\"/opt/halo/bin/halo\" $FIRE p1 # HALO:polling:p1"* && \
      "$state" == *"/keep/me"* ]]; then
  pass "(b) cron stubs: install.sh adds marker line, keeps existing lines"
else
  flunk "(b) cron install rc=$rc state=[$state]"
fi

# ============ (c) uninstall.sh の対称解除 ============
# cron: マーカー行だけ消え、他行は残る
run_script "$CRONBIN" "$TMP/proc.plain" -- "$DIR/uninstall.sh" p1 >/dev/null 2>&1
rc=$?
state="$(cat "$STATE" 2>/dev/null)"
if [ $rc -eq 0 ] && [[ "$state" == *"/keep/me"* ]] && [[ "$state" != *"HALO:polling:p1"* ]]; then
  pass "(c) cron uninstall removes only marker line"
else
  flunk "(c) cron uninstall rc=$rc state=[$state]"
fi

# schtasks: /Delete が呼ばれる
rm -f "$WSLBIN/schtasks.exe.log"
run_script "$WSLBIN" "$TMP/proc.wsl" -- "$DIR/uninstall.sh" p1 >/dev/null 2>&1
rc=$?
log="$(cat "$WSLBIN/schtasks.exe.log" 2>/dev/null)"
[ $rc -eq 0 ] && [[ "$log" == *"/Delete /TN HALO_p1 /F"* ]] \
  && pass "(c) schtasks uninstall calls /Delete" || flunk "(c) schtasks uninstall rc=$rc log=[$log]"

echo
if [ $fail -eq 0 ]; then
  echo "test.backends.sh (trigger-polling): ALL PASS"
else
  echo "test.backends.sh (trigger-polling): FAILURES PRESENT"
  exit 1
fi
