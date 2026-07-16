#!/usr/bin/env bash
# scheduler.sh: トリガー登録のスケジューラバックエンド共有ライブラリ（設計 D10 §3, ADR-0015）。
# schtasks / systemd user timer / cron / launchd を自動検出し、install/uninstall を対称に提供する。
# source して使う（直接実行しない）。bash 3.2 互換（mapfile / grep -P / date -d 不使用）。
#
# 提供関数:
#   scheduler_detect                                  -> stdout: schtasks|systemd|cron|launchd|none
#   scheduler_install <trigger> <profile> <spec> <fire_path>
#       spec = interval:<分> | daily:<HH:MM>
#   scheduler_uninstall <trigger> <profile>
#
# 環境変数:
#   HALO_SCHEDULER     検出結果の強制上書き（最優先）
#   HALO_HOME/HALO_BIN 設定時は ^[A-Za-z0-9/._-]+$ を検証の上コマンドへ env 代入として埋め込む
#   HALO_PROC_VERSION  テスト用: WSL 判定に読む /proc/version の差し替えパス

_halo_is_wsl() {
  grep -qi microsoft "${HALO_PROC_VERSION:-/proc/version}" 2>/dev/null
}

scheduler_detect() {
  if [ -n "${HALO_SCHEDULER:-}" ]; then
    echo "$HALO_SCHEDULER"
    return 0
  fi
  if _halo_is_wsl && command -v schtasks.exe >/dev/null 2>&1; then
    echo schtasks
    return 0
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    echo systemd
    return 0
  fi
  if command -v crontab >/dev/null 2>&1; then
    echo cron
    return 0
  fi
  if [ "$(uname -s)" = Darwin ] && command -v launchctl >/dev/null 2>&1; then
    echo launchd
    return 0
  fi
  echo none
}

# 検出失敗時の内訳レポート（stderr）。
_halo_detect_report() {
  {
    echo "scheduler: 利用可能なバックエンドが見つかりません。検出試行の内訳:"
    if _halo_is_wsl; then echo "  - WSL: yes / schtasks.exe: $(command -v schtasks.exe >/dev/null 2>&1 && echo found || echo not found)"
    else echo "  - WSL: no (schtasks は対象外)"; fi
    if command -v systemctl >/dev/null 2>&1; then
      echo "  - systemctl: found / --user バスへの接続: 失敗"
    else
      echo "  - systemctl: not found"
    fi
    echo "  - crontab: $(command -v crontab >/dev/null 2>&1 && echo found || echo not found)"
    echo "  - launchctl: $([ "$(uname -s)" = Darwin ] && command -v launchctl >/dev/null 2>&1 && echo found || echo "not applicable")"
    echo "  HALO_SCHEDULER 環境変数で明示指定できます（schtasks|systemd|cron|launchd）。"
  } >&2
}

# HALO_HOME / HALO_BIN を検証し、env 代入文字列を _HALO_ENV_ASSIGN に組み立てる。
# パス以外の文字（クォート・空白・シェルメタ文字）は注入防止のため拒否する。
_halo_build_env_assign() {
  local safe_path='^[A-Za-z0-9/._-]+$'
  _HALO_ENV_ASSIGN=""
  if [ -n "${HALO_HOME:-}" ]; then
    [[ "$HALO_HOME" =~ $safe_path ]] || { echo "scheduler: invalid HALO_HOME: $HALO_HOME" >&2; return 1; }
    _HALO_ENV_ASSIGN="${_HALO_ENV_ASSIGN}HALO_HOME=\"$HALO_HOME\" "
  fi
  if [ -n "${HALO_BIN:-}" ]; then
    [[ "$HALO_BIN" =~ $safe_path ]] || { echo "scheduler: invalid HALO_BIN: $HALO_BIN" >&2; return 1; }
    _HALO_ENV_ASSIGN="${_HALO_ENV_ASSIGN}HALO_BIN=\"$HALO_BIN\" "
  fi
  return 0
}

# spec を解析して _HALO_SPEC_KIND(interval|daily) / _HALO_SPEC_VALUE を設定する。
_halo_parse_spec() {
  local spec="$1"
  case "$spec" in
    interval:*)
      _HALO_SPEC_KIND=interval
      _HALO_SPEC_VALUE="${spec#interval:}"
      [[ "$_HALO_SPEC_VALUE" =~ ^[0-9]+$ ]] && [ "$_HALO_SPEC_VALUE" -ge 1 ] \
        || { echo "scheduler: invalid interval spec: $spec" >&2; return 1; }
      ;;
    daily:*)
      _HALO_SPEC_KIND=daily
      _HALO_SPEC_VALUE="${spec#daily:}"
      [[ "$_HALO_SPEC_VALUE" =~ ^[0-2][0-9]:[0-5][0-9]$ ]] \
        || { echo "scheduler: invalid daily spec: $spec" >&2; return 1; }
      ;;
    *)
      echo "scheduler: unknown spec (interval:<分> | daily:<HH:MM>): $spec" >&2
      return 1
      ;;
  esac
  return 0
}

_halo_validate_name() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "scheduler: invalid $2: $1" >&2; return 1; }
}

scheduler_install() {
  local trigger="$1" profile="$2" spec="$3" fire_path="$4"
  local backend cmd
  _halo_validate_name "$trigger" trigger || return 1
  _halo_validate_name "$profile" profile || return 1
  _halo_parse_spec "$spec" || return 1
  _halo_build_env_assign || return 1
  cmd="${_HALO_ENV_ASSIGN}${fire_path} ${profile}"

  backend="$(scheduler_detect)"
  case "$backend" in
    schtasks) _halo_install_schtasks "$trigger" "$profile" "$cmd" ;;
    systemd)  _halo_install_systemd  "$trigger" "$profile" "$cmd" ;;
    cron)     _halo_install_cron     "$trigger" "$profile" "$cmd" ;;
    launchd)  _halo_install_launchd  "$trigger" "$profile" "$cmd" ;;
    none)     _halo_detect_report; return 1 ;;
    *)        echo "scheduler: unknown backend: $backend" >&2; return 1 ;;
  esac
}

scheduler_uninstall() {
  local trigger="$1" profile="$2" backend
  _halo_validate_name "$trigger" trigger || return 1
  _halo_validate_name "$profile" profile || return 1
  backend="$(scheduler_detect)"
  case "$backend" in
    schtasks) _halo_uninstall_schtasks "$trigger" "$profile" ;;
    systemd)  _halo_uninstall_systemd  "$trigger" "$profile" ;;
    cron)     _halo_uninstall_cron     "$trigger" "$profile" ;;
    launchd)  _halo_uninstall_launchd  "$trigger" "$profile" ;;
    none)     echo "scheduler: バックエンド未検出のため解除対象なし" >&2; return 0 ;;
    *)        echo "scheduler: unknown backend: $backend" >&2; return 1 ;;
  esac
}

# ---- schtasks（Windows タスクスケジューラ, WSL 経由）----------------------
# 既存 install.sh と同じ /Create 形式。識別キーはタスク名 HALO_<profile>。

_halo_install_schtasks() {
  local trigger="$1" profile="$2" cmd="$3"
  local task_name="HALO_${profile}"
  # 既存タスクがあれば削除して重複登録を防ぐ（冪等化）。
  schtasks.exe /Delete /TN "$task_name" /F >/dev/null 2>&1 || true
  if [ "$_HALO_SPEC_KIND" = interval ]; then
    schtasks.exe /Create /TN "$task_name" \
      /SC MINUTE /MO "$_HALO_SPEC_VALUE" \
      /TR "wsl.exe -e bash -lc '$cmd'" \
      /RL LIMITED /F
  else
    schtasks.exe /Create /TN "$task_name" \
      /SC DAILY /ST "$_HALO_SPEC_VALUE" \
      /TR "wsl.exe -e bash -lc '$cmd'" \
      /RL LIMITED /F
  fi
}

_halo_uninstall_schtasks() {
  local profile="$2"
  schtasks.exe /Delete /TN "HALO_${profile}" /F >/dev/null 2>&1 || true
  return 0
}

# ---- systemd user timer -----------------------------------------------------

_halo_systemd_dir() { echo "$HOME/.config/systemd/user"; }

_halo_install_systemd() {
  local trigger="$1" profile="$2" cmd="$3"
  local unit="halo-${trigger}-${profile}" dir on_calendar hh mm
  dir="$(_halo_systemd_dir)"
  mkdir -p "$dir"
  if [ "$_HALO_SPEC_KIND" = interval ]; then
    on_calendar="*:0/${_HALO_SPEC_VALUE}"
  else
    hh="${_HALO_SPEC_VALUE%%:*}"; mm="${_HALO_SPEC_VALUE##*:}"
    on_calendar="*-*-* ${hh}:${mm}:00"
  fi
  cat > "$dir/$unit.service" <<EOF
[Unit]
Description=HALO trigger $trigger ($profile)

[Service]
Type=oneshot
ExecStart=/bin/bash -lc '$cmd'
EOF
  cat > "$dir/$unit.timer" <<EOF
[Unit]
Description=HALO trigger $trigger ($profile) timer

[Timer]
OnCalendar=$on_calendar
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$unit.timer"
}

_halo_uninstall_systemd() {
  local trigger="$1" profile="$2"
  local unit="halo-${trigger}-${profile}" dir
  dir="$(_halo_systemd_dir)"
  systemctl --user disable --now "$unit.timer" >/dev/null 2>&1 || true
  rm -f "$dir/$unit.timer" "$dir/$unit.service"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  return 0
}

# ---- cron -------------------------------------------------------------------
# 識別キーは行末マーカー # HALO:<trigger>:<profile>。既存行を除去してから追加（冪等）。

_halo_cron_strip() {
  # stdin の crontab からマーカー行を除去して stdout へ。
  local marker="$1" line
  while IFS= read -r line; do
    case "$line" in
      *"$marker") ;;
      *) printf '%s\n' "$line" ;;
    esac
  done
}

_halo_install_cron() {
  local trigger="$1" profile="$2" cmd="$3"
  local marker="# HALO:${trigger}:${profile}" schedule hh mm current
  if [ "$_HALO_SPEC_KIND" = interval ]; then
    schedule="*/${_HALO_SPEC_VALUE} * * * *"
  else
    hh="${_HALO_SPEC_VALUE%%:*}"; mm="${_HALO_SPEC_VALUE##*:}"
    schedule="${mm} ${hh} * * *"
  fi
  current="$(crontab -l 2>/dev/null || true)"
  { printf '%s\n' "$current" | _halo_cron_strip "$marker"
    printf '%s %s %s\n' "$schedule" "$cmd" "$marker"
  } | grep -v '^$' | crontab -
}

_halo_uninstall_cron() {
  local trigger="$1" profile="$2"
  local marker="# HALO:${trigger}:${profile}" current
  current="$(crontab -l 2>/dev/null || true)"
  printf '%s\n' "$current" | _halo_cron_strip "$marker" | grep -v '^$' | crontab - || true
  return 0
}

# ---- launchd (macOS) ---------------------------------------------------------

_halo_launchd_plist() { echo "$HOME/Library/LaunchAgents/dev.halo.$1.$2.plist"; }

_halo_install_launchd() {
  local trigger="$1" profile="$2" cmd="$3"
  local label="dev.halo.${trigger}.${profile}" plist schedule_xml hh mm
  plist="$(_halo_launchd_plist "$trigger" "$profile")"
  mkdir -p "$(dirname "$plist")"
  if [ "$_HALO_SPEC_KIND" = interval ]; then
    schedule_xml="  <key>StartInterval</key>
  <integer>$((10#$_HALO_SPEC_VALUE * 60))</integer>"
  else
    hh="${_HALO_SPEC_VALUE%%:*}"; mm="${_HALO_SPEC_VALUE##*:}"
    # 10#: HH/MM の先頭ゼロを 8 進数と解釈させない
    schedule_xml="  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$((10#$hh))</integer>
    <key>Minute</key>
    <integer>$((10#$mm))</integer>
  </dict>"
  fi
  # 再登録時は先に unload（冪等化）。
  launchctl unload "$plist" >/dev/null 2>&1 || true
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>$cmd</string>
  </array>
$schedule_xml
</dict>
</plist>
EOF
  launchctl load "$plist"
}

_halo_uninstall_launchd() {
  local trigger="$1" profile="$2" plist
  plist="$(_halo_launchd_plist "$trigger" "$profile")"
  launchctl unload "$plist" >/dev/null 2>&1 || true
  rm -f "$plist"
  return 0
}
