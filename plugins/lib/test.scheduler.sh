#!/usr/bin/env bash
# 軽量 contract test: plugins/lib/scheduler.sh の検出・install・uninstall を検証する。
# schtasks.exe / systemctl / crontab / launchctl / uname はすべて argv 記録スタブに
# 差し替え、HOME も一時 dir に差し替える。実 OS のスケジューラ・実 HOME は一切触らない。
# WSL 判定は HALO_PROC_VERSION でスタブファイルに差し替える（/proc は PATH で偽装不可）。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$DIR/scheduler.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

pass() { echo "PASS  $1"; }
flunk() { echo "FAIL  $1"; fail=1; }

# --- corebin: 検出テスト用の最小 PATH（実 systemctl/crontab を検出させないため） ---
COREBIN="$TMP/corebin"
mkdir -p "$COREBIN"
for c in bash grep cat mkdir rm dirname; do
  ln -s "$(command -v "$c")" "$COREBIN/$c"
done

# --- /proc/version スタブ ---
echo "Linux version 6.0 (microsoft-standard-WSL2)" > "$TMP/proc.wsl"
echo "Linux version 6.0 (generic)" > "$TMP/proc.plain"

# --- スタブ生成: 指定コマンドの argv 記録スタブを新しい dir に作る ---
# new_stub_dir <name>; add_stub <dir> <cmd> [exit_code]
new_stub_dir() { local d="$TMP/stub.$1"; mkdir -p "$d"; echo "$d"; }
add_stub() {
  local dir="$1" cmd="$2" rc="${3:-0}"
  cat >"$dir/$cmd" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$dir/$cmd.log"
exit $rc
STUB
  chmod +x "$dir/$cmd"
}
add_uname() { # add_uname <dir> <os>
  cat >"$1/uname" <<STUB
#!/usr/bin/env bash
echo "$2"
STUB
  chmod +x "$1/uname"
}
add_crontab() { # 状態ファイル付き crontab エミュレータ
  local dir="$1"
  local state="$dir/crontab.state"
  cat >"$dir/crontab" <<STUB
#!/usr/bin/env bash
if [ "\${1:-}" = "-l" ]; then
  [ -f "$state" ] || { echo "no crontab" >&2; exit 1; }
  cat "$state"
elif [ "\${1:-}" = "-" ]; then
  cat > "$state"
fi
exit 0
STUB
  chmod +x "$dir/crontab"
}

# 検出を隔離環境で実行: run_detect <stubdir> <procfile> [extra_env...]
run_detect() {
  local stub="$1" proc="$2"; shift 2
  env -i PATH="$stub:$COREBIN" HOME="$TMP/home" HALO_PROC_VERSION="$proc" "$@" \
    /bin/bash -c "source '$LIB'; scheduler_detect"
}

# ============ (a) HALO_SCHEDULER 上書きが最優先 ============
S="$(new_stub_dir a)"; add_stub "$S" schtasks.exe; add_uname "$S" Linux
got="$(run_detect "$S" "$TMP/proc.wsl" HALO_SCHEDULER=cron)"
[ "$got" = cron ] && pass "(a) HALO_SCHEDULER=cron overrides detection" || flunk "(a) override got=[$got]"

# ============ (b) 検出順 ============
S="$(new_stub_dir b1)"; add_stub "$S" schtasks.exe; add_stub "$S" systemctl; add_crontab "$S"; add_uname "$S" Linux
got="$(run_detect "$S" "$TMP/proc.wsl")"
[ "$got" = schtasks ] && pass "(b) WSL + schtasks.exe -> schtasks" || flunk "(b) wsl got=[$got]"

S="$(new_stub_dir b2)"; add_stub "$S" systemctl; add_crontab "$S"; add_uname "$S" Linux
got="$(run_detect "$S" "$TMP/proc.wsl")"
[ "$got" = systemd ] && pass "(b) WSL without schtasks.exe -> systemd" || flunk "(b) systemd got=[$got]"

S="$(new_stub_dir b3)"; add_stub "$S" systemctl 1; add_crontab "$S"; add_uname "$S" Linux
got="$(run_detect "$S" "$TMP/proc.plain")"
[ "$got" = cron ] && pass "(b) systemctl --user failing -> cron" || flunk "(b) cron got=[$got]"

S="$(new_stub_dir b4)"; add_stub "$S" launchctl; add_uname "$S" Darwin
got="$(run_detect "$S" "$TMP/proc.plain")"
[ "$got" = launchd ] && pass "(b) Darwin + launchctl -> launchd" || flunk "(b) launchd got=[$got]"

S="$(new_stub_dir b5)"; add_uname "$S" Linux
got="$(run_detect "$S" "$TMP/proc.plain")"
[ "$got" = none ] && pass "(b) nothing available -> none" || flunk "(b) none got=[$got]"

# none で install が非 0 + stderr レポート
err="$(env -i PATH="$S:$COREBIN" HOME="$TMP/home" HALO_PROC_VERSION="$TMP/proc.plain" \
  /bin/bash -c "source '$LIB'; scheduler_install polling p1 interval:5 /opt/fire" 2>&1 >/dev/null)"
rc=$?
if [ $rc -ne 0 ] && [ -n "$err" ]; then
  pass "(b) install on none -> nonzero with report"
else
  flunk "(b) install on none rc=$rc err=[$err]"
fi

# ============ install テスト共通ヘルパ ============
# run_lib <stubdir> <backend> <env...> -- <shell code>
run_lib() {
  local stub="$1" backend="$2"; shift 2
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done
  shift
  env -i PATH="$stub:$COREBIN" HOME="$TMP/home" HALO_SCHEDULER="$backend" \
    ${envs[@]+"${envs[@]}"} /bin/bash -c "source '$LIB'; $1"
}

# ============ (c) schtasks: /Create の形と env 埋め込み ============
S="$(new_stub_dir schtasks)"; add_stub "$S" schtasks.exe
run_lib "$S" schtasks HALO_HOME=/opt/halo HALO_BIN=/opt/halo/bin/halo -- \
  "scheduler_install polling p1 interval:5 /opt/fire" >/dev/null 2>&1
create="$(grep '/Create' "$S/schtasks.exe.log" 2>/dev/null)"
if [[ "$create" == *"/SC MINUTE /MO 5"* && \
      "$create" == *"/TR wsl.exe -e bash -lc 'HALO_HOME=\"/opt/halo\" HALO_BIN=\"/opt/halo/bin/halo\" /opt/fire p1'"* && \
      "$create" == *"/TN HALO_p1"* ]]; then
  pass "(c) schtasks interval: /SC MINUTE /MO 5 + env-embedded TR"
else
  flunk "(c) schtasks interval create=[$create]"
fi
rm -f "$S/schtasks.exe.log"
run_lib "$S" schtasks -- "scheduler_install schedule p1 daily:03:00 /opt/fire" >/dev/null 2>&1
create="$(grep '/Create' "$S/schtasks.exe.log" 2>/dev/null)"
[[ "$create" == *"/SC DAILY /ST 03:00"* ]] \
  && pass "(c) schtasks daily: /SC DAILY /ST 03:00" || flunk "(c) schtasks daily create=[$create]"

# ============ (c) systemd: unit ファイルと systemctl 呼び出し ============
S="$(new_stub_dir systemd)"; add_stub "$S" systemctl
run_lib "$S" systemd HALO_HOME=/opt/halo -- \
  "scheduler_install polling p1 interval:15 /opt/fire" >/dev/null 2>&1
UNIT_DIR="$TMP/home/.config/systemd/user"
timer="$(cat "$UNIT_DIR/halo-polling-p1.timer" 2>/dev/null)"
service="$(cat "$UNIT_DIR/halo-polling-p1.service" 2>/dev/null)"
log="$(cat "$S/systemctl.log" 2>/dev/null)"
if [[ "$timer" == *"OnCalendar=*:0/15"* && \
      "$service" == *"ExecStart=/bin/bash -lc 'HALO_HOME=\"/opt/halo\" /opt/fire p1'"* && \
      "$log" == *"--user daemon-reload"* && "$log" == *"--user enable --now halo-polling-p1.timer"* ]]; then
  pass "(c) systemd interval: unit files + daemon-reload + enable --now"
else
  flunk "(c) systemd interval timer=[$timer] service=[$service] log=[$log]"
fi
run_lib "$S" systemd -- "scheduler_install schedule p1 daily:03:30 /opt/fire" >/dev/null 2>&1
timer="$(cat "$UNIT_DIR/halo-schedule-p1.timer" 2>/dev/null)"
[[ "$timer" == *"OnCalendar=*-*-* 03:30:00"* ]] \
  && pass "(c) systemd daily: OnCalendar=*-*-* 03:30:00" || flunk "(c) systemd daily timer=[$timer]"

# ============ (c) cron: マーカー付き行 ============
S="$(new_stub_dir cron)"; add_crontab "$S"
printf '0 0 * * * /keep/me\n' | "$S/crontab" -
run_lib "$S" cron HALO_BIN=/opt/halo/bin/halo -- \
  "scheduler_install polling p1 interval:5 /opt/fire" >/dev/null 2>&1
state="$(cat "$S/crontab.state" 2>/dev/null)"
if [[ "$state" == *'*/5 * * * * HALO_BIN="/opt/halo/bin/halo" /opt/fire p1 # HALO:polling:p1'* && \
      "$state" == *"/keep/me"* ]]; then
  pass "(c) cron interval: marker line added, existing lines kept"
else
  flunk "(c) cron interval state=[$state]"
fi
run_lib "$S" cron -- "scheduler_install schedule p1 daily:04:30 /opt/fire" >/dev/null 2>&1
state="$(cat "$S/crontab.state" 2>/dev/null)"
[[ "$state" == *'30 04 * * * /opt/fire p1 # HALO:schedule:p1'* ]] \
  && pass "(c) cron daily: 30 04 * * *" || flunk "(c) cron daily state=[$state]"

# ============ (c) launchd: plist と launchctl load ============
S="$(new_stub_dir launchd)"; add_stub "$S" launchctl
run_lib "$S" launchd HALO_HOME=/opt/halo -- \
  "scheduler_install polling p1 interval:5 /opt/fire" >/dev/null 2>&1
PLIST="$TMP/home/Library/LaunchAgents/dev.halo.polling.p1.plist"
plist="$(cat "$PLIST" 2>/dev/null)"
log="$(cat "$S/launchctl.log" 2>/dev/null)"
if [[ "$plist" == *"<string>dev.halo.polling.p1</string>"* && \
      "$plist" == *"<key>StartInterval</key>"* && "$plist" == *"<integer>300</integer>"* && \
      "$plist" == *"<string>HALO_HOME=\"/opt/halo\" /opt/fire p1</string>"* && \
      "$log" == *"load $PLIST"* ]]; then
  pass "(c) launchd interval: plist StartInterval=300 + launchctl load"
else
  flunk "(c) launchd interval plist=[$plist] log=[$log]"
fi
run_lib "$S" launchd -- "scheduler_install schedule p1 daily:03:05 /opt/fire" >/dev/null 2>&1
plist="$(cat "$TMP/home/Library/LaunchAgents/dev.halo.schedule.p1.plist" 2>/dev/null)"
if [[ "$plist" == *"<key>StartCalendarInterval</key>"* && \
      "$plist" == *"<key>Hour</key>"* && "$plist" == *"<integer>3</integer>"* && \
      "$plist" == *"<key>Minute</key>"* && "$plist" == *"<integer>5</integer>"* ]]; then
  pass "(c) launchd daily: StartCalendarInterval Hour=3 Minute=5"
else
  flunk "(c) launchd daily plist=[$plist]"
fi

# ============ (d) 不正な HALO_HOME/HALO_BIN の拒否 ============
S="$(new_stub_dir inject)"; add_stub "$S" schtasks.exe
run_lib "$S" schtasks "HALO_HOME=/opt/evil path" -- \
  "scheduler_install polling p1 interval:5 /opt/fire" >/dev/null 2>&1
[ $? -ne 0 ] && pass "(d) HALO_HOME with space -> rejected" || flunk "(d) space accepted"
run_lib "$S" schtasks "HALO_BIN=/opt/x';rm -rf /'" -- \
  "scheduler_install polling p1 interval:5 /opt/fire" >/dev/null 2>&1
[ $? -ne 0 ] && pass "(d) HALO_BIN with quote -> rejected" || flunk "(d) quote accepted"
[ -f "$S/schtasks.exe.log" ] && flunk "(d) backend was invoked despite rejection" \
  || pass "(d) rejection happens before backend invocation"

# ============ (e) install -> install の冪等性（cron マーカー重複なし） ============
S="$(new_stub_dir idem)"; add_crontab "$S"
run_lib "$S" cron -- "scheduler_install polling p1 interval:5 /opt/fire" >/dev/null 2>&1
run_lib "$S" cron -- "scheduler_install polling p1 interval:10 /opt/fire" >/dev/null 2>&1
count="$(grep -c '# HALO:polling:p1$' "$S/crontab.state" 2>/dev/null)"
if [ "$count" = 1 ] && grep -q '^\*/10 ' "$S/crontab.state"; then
  pass "(e) double install: marker unique, spec updated to */10"
else
  flunk "(e) idempotency count=$count state=[$(cat "$S/crontab.state" 2>/dev/null)]"
fi

# ============ (f) uninstall の対称性 ============
# cron: マーカー行だけ消え、他行は残る
printf '0 0 * * * /keep/me\n*/5 * * * * /opt/fire p1 # HALO:polling:p1\n' | "$S/crontab" -
run_lib "$S" cron -- "scheduler_uninstall polling p1" >/dev/null 2>&1
rc=$?
state="$(cat "$S/crontab.state" 2>/dev/null)"
if [ $rc -eq 0 ] && [[ "$state" == *"/keep/me"* ]] && [[ "$state" != *"HALO:polling:p1"* ]]; then
  pass "(f) cron uninstall removes only marker line"
else
  flunk "(f) cron uninstall rc=$rc state=[$state]"
fi

# systemd: unit ファイル削除 + disable --now
S="$(new_stub_dir un-systemd)"; add_stub "$S" systemctl
run_lib "$S" systemd -- "scheduler_install polling p1 interval:5 /opt/fire" >/dev/null 2>&1
run_lib "$S" systemd -- "scheduler_uninstall polling p1" >/dev/null 2>&1
rc=$?
log="$(cat "$S/systemctl.log" 2>/dev/null)"
if [ $rc -eq 0 ] && [ ! -f "$UNIT_DIR/halo-polling-p1.timer" ] && [ ! -f "$UNIT_DIR/halo-polling-p1.service" ] \
   && [[ "$log" == *"--user disable --now halo-polling-p1.timer"* ]]; then
  pass "(f) systemd uninstall removes units + disable --now"
else
  flunk "(f) systemd uninstall rc=$rc log=[$log]"
fi

# launchd: plist 削除 + unload
S="$(new_stub_dir un-launchd)"; add_stub "$S" launchctl
run_lib "$S" launchd -- "scheduler_install polling p1 interval:5 /opt/fire" >/dev/null 2>&1
run_lib "$S" launchd -- "scheduler_uninstall polling p1" >/dev/null 2>&1
rc=$?
log="$(cat "$S/launchctl.log" 2>/dev/null)"
[ $rc -eq 0 ] && [ ! -f "$PLIST" ] && [[ "$log" == *"unload $PLIST"* ]] \
  && pass "(f) launchd uninstall removes plist + unload" || flunk "(f) launchd uninstall rc=$rc log=[$log]"

# schtasks: /Delete が呼ばれる
S="$(new_stub_dir un-schtasks)"; add_stub "$S" schtasks.exe
run_lib "$S" schtasks -- "scheduler_uninstall polling p1" >/dev/null 2>&1
rc=$?
log="$(cat "$S/schtasks.exe.log" 2>/dev/null)"
[ $rc -eq 0 ] && [[ "$log" == *"/Delete /TN HALO_p1 /F"* ]] \
  && pass "(f) schtasks uninstall calls /Delete" || flunk "(f) schtasks uninstall rc=$rc log=[$log]"

# 対象なし uninstall -> exit 0（cron 空 / systemd unit なし / schtasks 失敗応答）
S="$(new_stub_dir un-empty)"; add_crontab "$S"; add_stub "$S" systemctl 1; add_stub "$S" schtasks.exe 1; add_stub "$S" launchctl 1
for be in cron systemd schtasks launchd; do
  run_lib "$S" "$be" -- "scheduler_uninstall polling nothere" >/dev/null 2>&1
  rc=$?
  [ $rc -eq 0 ] && pass "(f) $be uninstall with no target -> exit 0" || flunk "(f) $be empty uninstall rc=$rc"
done

echo
if [ $fail -eq 0 ]; then
  echo "test.scheduler.sh: ALL PASS"
else
  echo "test.scheduler.sh: FAILURES PRESENT"
  exit 1
fi
