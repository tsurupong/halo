// scheduler.ts: トリガー登録のスケジューラバックエンド共有ライブラリ(設計 D10 §3, ADR-0015)。
// schtasks / systemd user timer / cron / launchd を自動検出し、install/uninstall を対称に提供する。
// 旧 plugins/lib/scheduler.sh の移植(ADR-0017)。識別キー(タスク名・unit 名・マーカー・plist
// ラベル)は同一なので、shell 版で登録した環境も本実装で解除できる。
//
// 環境変数:
//   HALO_SCHEDULER     検出結果の強制上書き(最優先)
//   HALO_HOME/HALO_BIN 設定時は ^[A-Za-z0-9/._-]+$ を検証の上コマンドへ env 代入として埋め込む
//   HALO_PROC_VERSION  テスト用: WSL 判定に読む /proc/version の差し替えパス
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from './exec.js';
import { diag } from './io.js';

export type Backend = 'schtasks' | 'systemd' | 'cron' | 'launchd' | 'none';
export type Spec = { kind: 'interval'; minutes: number } | { kind: 'daily'; hh: number; mm: number };

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_PATH_RE = /^[A-Za-z0-9/._-]+$/;
// fireArgv 用: 絶対パスの空白区切り(例: `C:\Program Files\...`)を許容するため空白のみ追加。
const SAFE_ARGV_RE = /^[A-Za-z0-9/._ -]+$/;

function isWsl(): boolean {
  const procPath = process.env['HALO_PROC_VERSION'] ?? '/proc/version';
  try {
    return /microsoft/i.test(readFileSync(procPath, 'utf8'));
  } catch {
    return false;
  }
}

function hasBackendCmd(cmd: string, args: string[]): boolean {
  return run(cmd, args).code !== 127;
}

export function schedulerDetect(): Backend {
  const forced = process.env['HALO_SCHEDULER'];
  if (forced !== undefined && forced !== '') return forced as Backend;
  if (isWsl() && hasBackendCmd('schtasks.exe', ['/Query', '/?'])) return 'schtasks';
  if (run('systemctl', ['--user', 'show-environment']).code === 0) return 'systemd';
  if (hasBackendCmd('crontab', ['-l'])) return 'cron';
  if (platform() === 'darwin' && hasBackendCmd('launchctl', ['version'])) return 'launchd';
  return 'none';
}

// 検出失敗時の内訳レポート(stderr)。
function detectReport(): void {
  diag('scheduler: 利用可能なバックエンドが見つかりません。検出試行の内訳:');
  if (isWsl()) {
    const found = hasBackendCmd('schtasks.exe', ['/Query', '/?']) ? 'found' : 'not found';
    diag(`  - WSL: yes / schtasks.exe: ${found}`);
  } else {
    diag('  - WSL: no (schtasks は対象外)');
  }
  if (hasBackendCmd('systemctl', ['--version'])) {
    diag('  - systemctl: found / --user バスへの接続: 失敗');
  } else {
    diag('  - systemctl: not found');
  }
  diag(`  - crontab: ${hasBackendCmd('crontab', ['-l']) ? 'found' : 'not found'}`);
  diag(
    `  - launchctl: ${platform() === 'darwin' && hasBackendCmd('launchctl', ['version']) ? 'found' : 'not applicable'}`,
  );
  diag('  HALO_SCHEDULER 環境変数で明示指定できます（schtasks|systemd|cron|launchd）。');
}

// HALO_HOME / HALO_BIN を検証し、env 代入文字列を組み立てる。
// パス以外の文字(クォート・空白・シェルメタ文字)は注入防止のため拒否する。
function buildEnvAssign(): string {
  let assign = '';
  for (const key of ['HALO_HOME', 'HALO_BIN'] as const) {
    const v = process.env[key];
    if (v !== undefined && v !== '') {
      if (!SAFE_PATH_RE.test(v)) throw new Error(`scheduler: invalid ${key}: ${v}`);
      assign += `${key}="${v}" `;
    }
  }
  return assign;
}

export function parseSpec(spec: string): Spec {
  if (spec.startsWith('interval:')) {
    const v = spec.slice('interval:'.length);
    if (!/^[0-9]+$/.test(v) || Number(v) < 1) throw new Error(`scheduler: invalid interval spec: ${spec}`);
    return { kind: 'interval', minutes: Number(v) };
  }
  if (spec.startsWith('daily:')) {
    const v = spec.slice('daily:'.length);
    if (!/^[0-2][0-9]:[0-5][0-9]$/.test(v)) throw new Error(`scheduler: invalid daily spec: ${spec}`);
    const [hh, mm] = v.split(':');
    return { kind: 'daily', hh: Number(hh), mm: Number(mm) };
  }
  throw new Error(`scheduler: unknown spec (interval:<分> | daily:<HH:MM>): ${spec}`);
}

function validateName(value: string, label: string): void {
  if (!NAME_RE.test(value)) throw new Error(`scheduler: invalid ${label}: ${value}`);
}

// fireArgv の各要素を安全文字集合で検証する。JSON.stringify は $ やバッククォートを
// エスケープしないため、bash の二重引用符コンテキストで再解釈されうる(コマンド注入対策)。
function validateFireArgv(fireArgv: readonly string[]): void {
  for (const a of fireArgv) {
    if (!SAFE_ARGV_RE.test(a)) throw new Error(`scheduler: invalid fireArgv element: ${a}`);
  }
}

export function schedulerInstall(
  trigger: string,
  profile: string,
  specStr: string,
  fireArgv: readonly string[],
): void {
  validateName(trigger, 'trigger');
  validateName(profile, 'profile');
  validateFireArgv(fireArgv);
  const spec = parseSpec(specStr);
  const cmd = `${buildEnvAssign()}${fireArgv.map((a) => JSON.stringify(a)).join(' ')} ${profile}`;

  const backend = schedulerDetect();
  switch (backend) {
    case 'schtasks':
      installSchtasks(profile, spec, cmd);
      break;
    case 'systemd':
      installSystemd(trigger, profile, spec, cmd);
      break;
    case 'cron':
      installCron(trigger, profile, spec, cmd);
      break;
    case 'launchd':
      installLaunchd(trigger, profile, spec, cmd);
      break;
    case 'none':
      detectReport();
      throw new Error('scheduler: no backend available');
    default:
      throw new Error(`scheduler: unknown backend: ${String(backend)}`);
  }
}

export function schedulerUninstall(trigger: string, profile: string): void {
  validateName(trigger, 'trigger');
  validateName(profile, 'profile');
  const backend = schedulerDetect();
  switch (backend) {
    case 'schtasks':
      run('schtasks.exe', ['/Delete', '/TN', `HALO_${profile}`, '/F']);
      break;
    case 'systemd':
      uninstallSystemd(trigger, profile);
      break;
    case 'cron':
      uninstallCron(trigger, profile);
      break;
    case 'launchd':
      uninstallLaunchd(trigger, profile);
      break;
    case 'none':
      diag('scheduler: バックエンド未検出のため解除対象なし');
      break;
    default:
      throw new Error(`scheduler: unknown backend: ${String(backend)}`);
  }
}

// ---- schtasks(Windows タスクスケジューラ, WSL 経由)----------------------
// 既存実装と同じ /Create 形式。識別キーはタスク名 HALO_<profile>。

function installSchtasks(profile: string, spec: Spec, cmd: string): void {
  const taskName = `HALO_${profile}`;
  // 既存タスクがあれば削除して重複登録を防ぐ(冪等化)。
  run('schtasks.exe', ['/Delete', '/TN', taskName, '/F']);
  const tr = `wsl.exe -e bash -lc '${cmd}'`;
  const args =
    spec.kind === 'interval'
      ? ['/Create', '/TN', taskName, '/SC', 'MINUTE', '/MO', String(spec.minutes), '/TR', tr, '/RL', 'LIMITED', '/F']
      : ['/Create', '/TN', taskName, '/SC', 'DAILY', '/ST', `${pad(spec.hh)}:${pad(spec.mm)}`, '/TR', tr, '/RL', 'LIMITED', '/F'];
  const r = run('schtasks.exe', args);
  process.stderr.write(r.stderr);
  if (r.code !== 0) throw new Error(`scheduler: schtasks /Create failed (exit ${r.code})`);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// ---- systemd user timer -----------------------------------------------------

function systemdDir(): string {
  return join(homedir(), '.config', 'systemd', 'user');
}

function installSystemd(trigger: string, profile: string, spec: Spec, cmd: string): void {
  const unit = `halo-${trigger}-${profile}`;
  const dir = systemdDir();
  mkdirSync(dir, { recursive: true });
  const onCalendar =
    spec.kind === 'interval' ? `*:0/${spec.minutes}` : `*-*-* ${pad(spec.hh)}:${pad(spec.mm)}:00`;
  writeFileSync(
    join(dir, `${unit}.service`),
    `[Unit]\nDescription=HALO trigger ${trigger} (${profile})\n\n[Service]\nType=oneshot\nExecStart=/bin/bash -lc '${cmd}'\n`,
  );
  writeFileSync(
    join(dir, `${unit}.timer`),
    `[Unit]\nDescription=HALO trigger ${trigger} (${profile}) timer\n\n[Timer]\nOnCalendar=${onCalendar}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  );
  if (run('systemctl', ['--user', 'daemon-reload']).code !== 0)
    throw new Error('scheduler: systemctl daemon-reload failed');
  if (run('systemctl', ['--user', 'enable', '--now', `${unit}.timer`]).code !== 0)
    throw new Error('scheduler: systemctl enable failed');
}

function uninstallSystemd(trigger: string, profile: string): void {
  const unit = `halo-${trigger}-${profile}`;
  const dir = systemdDir();
  run('systemctl', ['--user', 'disable', '--now', `${unit}.timer`]);
  rmSync(join(dir, `${unit}.timer`), { force: true });
  rmSync(join(dir, `${unit}.service`), { force: true });
  run('systemctl', ['--user', 'daemon-reload']);
}

// ---- cron -------------------------------------------------------------------
// 識別キーは行末マーカー # HALO:<trigger>:<profile>。既存行を除去してから追加(冪等)。

function cronStrip(current: string, marker: string): string[] {
  return current.split('\n').filter((line) => !line.endsWith(marker) && line !== '');
}

function installCron(trigger: string, profile: string, spec: Spec, cmd: string): void {
  const marker = `# HALO:${trigger}:${profile}`;
  const schedule =
    spec.kind === 'interval' ? `*/${spec.minutes} * * * *` : `${pad(spec.mm)} ${pad(spec.hh)} * * *`;
  const current = run('crontab', ['-l']).stdout;
  const lines = cronStrip(current, marker);
  lines.push(`${schedule} ${cmd} ${marker}`);
  const r = run('crontab', ['-'], { input: `${lines.join('\n')}\n` });
  if (r.code !== 0) throw new Error(`scheduler: crontab install failed (exit ${r.code})`);
}

function uninstallCron(trigger: string, profile: string): void {
  const marker = `# HALO:${trigger}:${profile}`;
  const current = run('crontab', ['-l']).stdout;
  const lines = cronStrip(current, marker);
  run('crontab', ['-'], { input: lines.length > 0 ? `${lines.join('\n')}\n` : '' });
}

// ---- launchd (macOS) ---------------------------------------------------------

function launchdPlist(trigger: string, profile: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', `dev.halo.${trigger}.${profile}.plist`);
}

function installLaunchd(trigger: string, profile: string, spec: Spec, cmd: string): void {
  const label = `dev.halo.${trigger}.${profile}`;
  const plist = launchdPlist(trigger, profile);
  mkdirSync(dirname(plist), { recursive: true });
  const scheduleXml =
    spec.kind === 'interval'
      ? `  <key>StartInterval</key>\n  <integer>${spec.minutes * 60}</integer>`
      : `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>${spec.hh}</integer>\n    <key>Minute</key>\n    <integer>${spec.mm}</integer>\n  </dict>`;
  // 再登録時は先に unload(冪等化)。
  run('launchctl', ['unload', plist]);
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${label}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/bin/bash</string>\n    <string>-lc</string>\n    <string>${cmd}</string>\n  </array>\n${scheduleXml}\n</dict>\n</plist>\n`,
  );
  if (run('launchctl', ['load', plist]).code !== 0) throw new Error('scheduler: launchctl load failed');
}

function uninstallLaunchd(trigger: string, profile: string): void {
  const plist = launchdPlist(trigger, profile);
  run('launchctl', ['unload', plist]);
  rmSync(plist, { force: true });
}
