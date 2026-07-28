// `halo watchdog` (D9 §2, ADR-0013/0023): 外部監督プロセス。
//
//   halo watchdog                    1 回実行して wedge を検知し --action に応じて処理
//   halo watchdog install --action X OS スケジューラへ定期実行を登録 (ADR-0023)
//   halo watchdog uninstall          その解除 (冪等)
//
// 常駐しない（スケジューリングは OS 側）。誤殺より見逃し: 判定材料が欠けたら常に
// 何もせず exit 0。毎回 heartbeat (logs/watchdog-last.json) を上書きするので、
// 「登録されていない」と「登録済みで異常なし」を doctor が区別できる (D9 §2.7)。
import { stringFlag, type ParsedArgs } from '../args.js';
import { EXIT, CliError, type ExitCode } from '../exit-codes.js';
import type { Io } from '../io.js';
import type { CliFs } from '../core-ext/fs.js';
import {
  defaultLockPath,
  parseLockFile,
  isPhaseStale,
  killProcessTree,
  type KillFn,
  type LoopPhase,
  type PhaseState,
  type StaleVerdict,
  type WatchdogTimeouts,
} from '@tsurupong/halo-core';

/** 停滞検知後の振る舞い。既定は安全側の report (kill は明示指定時のみ)。 */
export type WatchdogAction = 'report' | 'kill' | 'skip';

/** 環境変数キーと既定値 (D9 §2.3)。 */
export const WATCHDOG_DEFAULTS = {
  timeoutSec: 1800,
  executeTimeoutSec: 3600,
  killGraceSec: 10,
  /** install の既定ポーリング間隔 (分)。1 回の実行は fs 読みが数回 (D9 §2.6)。 */
  everyMinutes: 5,
} as const;

/** スケジューラ識別子。profile キーに付ける接尾辞で run トリガーと名前空間を分ける。 */
export const WATCHDOG_TRIGGER = 'watchdog';
const WATCHDOG_KEY_SUFFIX = '-watchdog';

/**
 * 毎回書き出す heartbeat (D9 §2.7)。`watchdog.jsonl` が検知時しか増えないため、
 * 「動いている」ことの唯一の証跡がこれになる。current.json と同じく単一オブジェクトの上書き。
 */
export interface WatchdogHeartbeat {
  ts: string;
  stale: boolean;
  phase: LoopPhase | null;
  age_sec: number | null;
  limit_sec: number | null;
  action: WatchdogAction;
  /** kill / quarantine を実際に行ったか。report では常に false。 */
  acted: boolean;
}

/**
 * スケジューラ登録シーム (ADR-0015 の `halo-plugins/lib/scheduler`)。実体は schtasks /
 * systemd / cron / launchd を叩くので、テストは必ずこれを差し替える。
 */
export interface SchedulerSeam {
  install(trigger: string, profile: string, spec: string, fireArgv: readonly string[]): void;
  uninstall(trigger: string, profile: string): void;
}

export interface WatchdogDeps {
  fs: CliFs;
  now: number;
  env: Record<string, string | undefined>;
  /** lock ファイル置き場 ($TMPDIR 相当)。 */
  tmpdir: string;
  /** ホスト名 (lock の host と照合し、別ホストの lock には触らない)。 */
  host: string;
  isProcessAlive(pid: number): boolean;
  kill: KillFn;
  sleep(ms: number): Promise<void>;
  /** install/uninstall 用。未注入のまま install を呼ぶと明示エラー (黙って無効化しない)。 */
  scheduler?: SchedulerSeam;
  /** 登録コマンドの argv 先頭 2 要素 (node 実行系 + halo CLI エントリの絶対パス)。 */
  cliArgv?: readonly string[];
}

function join(a: string, b: string): string {
  return `${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`;
}

function envInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const n = Number(env[key]);
  return env[key] !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** current.json を読み PhaseState として最低限検証する。読めなければ null (何もしない)。 */
async function readPhaseState(logDir: string, fs: CliFs): Promise<PhaseState | null> {
  let body: string;
  try {
    body = await fs.readFile(join(logDir, 'current.json'));
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as Partial<PhaseState>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.phase !== 'string' || typeof parsed.updated_at !== 'string') return null;
    return parsed as PhaseState;
  } catch {
    return null;
  }
}

/** watchdog.jsonl へ 1 行 JSON を追記する (CliFs に append は無いため read+write)。 */
async function appendJournal(
  logDir: string,
  fs: CliFs,
  record: Record<string, unknown>,
): Promise<void> {
  const path = join(logDir, 'watchdog.jsonl');
  let existing = '';
  try {
    existing = await fs.readFile(path);
  } catch {
    // 初回は空から。
  }
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(path, `${existing}${JSON.stringify(record)}\n`);
}

/**
 * heartbeat を上書きする (D9 §2.7)。best-effort — 可視化用のファイルなので、これ自体の
 * 失敗で監督処理の終了コードを変えてはならない。
 */
async function writeHeartbeat(logDir: string, fs: CliFs, beat: WatchdogHeartbeat): Promise<void> {
  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(join(logDir, 'watchdog-last.json'), `${JSON.stringify(beat, null, 2)}\n`);
  } catch {
    /* best-effort */
  }
}

/** queue/<task_id>.md を quarantine/ へ移す (CliFs に rename は無いため copy+rm)。 */
async function quarantineTask(haloDir: string, taskId: string | null, fs: CliFs): Promise<boolean> {
  if (taskId === null || !/^[A-Za-z0-9._-]+$/.test(taskId)) return false;
  const src = join(haloDir, `tasks/queue/${taskId}.md`);
  let body: string;
  try {
    body = await fs.readFile(src);
  } catch {
    return false;
  }
  await fs.mkdir(join(haloDir, 'tasks/quarantine'), { recursive: true });
  await fs.writeFile(join(haloDir, `tasks/quarantine/${taskId}.md`), body);
  await fs.rm(src);
  return true;
}

async function killWedgedRun(pid: number, deps: WatchdogDeps, graceSec: number): Promise<void> {
  killProcessTree(pid, 'SIGTERM', deps.kill);
  await deps.sleep(graceSec * 1000);
  if (deps.isProcessAlive(pid)) killProcessTree(pid, 'SIGKILL', deps.kill);
}

function parseAction(parsed: ParsedArgs, fallback?: WatchdogAction): WatchdogAction {
  const raw = stringFlag(parsed, 'action');
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new CliError('missing --action', EXIT.USAGE, {
      hint: 'watchdog install requires an explicit --action report|kill|skip (D9 §2.6)',
    });
  }
  if (raw !== 'report' && raw !== 'kill' && raw !== 'skip') {
    throw new CliError(`invalid --action '${raw}'`, EXIT.USAGE, {
      hint: 'use one of: report | kill | skip',
    });
  }
  return raw;
}

/** `--every 5m` / `--every 5` → 分。1..1440 の外は使用法エラー。 */
export function parseEveryMinutes(raw: string | undefined): number {
  if (raw === undefined) return WATCHDOG_DEFAULTS.everyMinutes;
  const m = /^(\d+)m?$/.exec(raw.trim());
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 1440) {
    throw new CliError(`invalid --every '${raw}'`, EXIT.USAGE, {
      hint: 'give minutes, e.g. --every 5m (1-1440)',
    });
  }
  return n;
}

/**
 * スケジューラ上の profile キー。schtasks はタスク名を `HALO_${profile}` と profile
 * だけで決め、install 時に同名を消すので (scheduler.ts:176-178)、素の profile で登録すると
 * Windows で run トリガーを消してしまう。接尾辞で名前空間を分ける (ADR-0023)。
 */
export function watchdogSchedulerKey(profile: string | undefined): string {
  return `${profile ?? 'default'}${WATCHDOG_KEY_SUFFIX}`;
}

export async function watchdogCommand(
  parsed: ParsedArgs,
  io: Io,
  deps: WatchdogDeps,
): Promise<ExitCode> {
  const profile = stringFlag(parsed, 'profile');
  const sub = parsed.positionals[0];

  if (sub === 'install') return installWatchdog(parsed, io, deps, profile);
  if (sub === 'uninstall') return uninstallWatchdog(io, deps, profile);
  // 登録コマンドの末尾には schedulerInstall が profile キーを 1 つ足す (scheduler.ts:123)。
  // それだけは黙って無視し、それ以外の未知の位置引数はタイポとして落とす。
  if (sub !== undefined && sub !== watchdogSchedulerKey(profile)) {
    throw new CliError(`unknown watchdog subcommand: ${sub}`, EXIT.USAGE, {
      usage: 'usage: halo watchdog [install|uninstall] [--action <mode>] [--profile <name>]',
    });
  }
  return detectOnce(parsed, io, deps, profile);
}

/** 1 回の停滞検知パス (D9 §2.3)。 */
async function detectOnce(
  parsed: ParsedArgs,
  io: Io,
  deps: WatchdogDeps,
  profile: string | undefined,
): Promise<ExitCode> {
  const action = parseAction(parsed, 'report');
  const haloDir = `${io.flags.cwd.replace(/\/$/, '')}/.halo`;
  const logDir = join(haloDir, 'logs');
  const ts = new Date(deps.now).toISOString();
  /** 監督対象が無い / 判定できない時の heartbeat。 */
  const idleBeat = async (): Promise<ExitCode> => {
    await writeHeartbeat(logDir, deps.fs, {
      ts,
      stale: false,
      phase: null,
      age_sec: null,
      limit_sec: null,
      action,
      acted: false,
    });
    return EXIT.OK;
  };

  // 1. lock: 無い / 持ち主が死んでいる / 別ホスト → 監督対象なし。
  const lockPath = defaultLockPath(deps.tmpdir, profile);
  let lockBody: string;
  try {
    lockBody = await deps.fs.readFile(lockPath);
  } catch {
    return idleBeat();
  }
  const lock = parseLockFile(lockBody);
  if (lock === null) return idleBeat();
  if (!deps.isProcessAlive(lock.pid)) return idleBeat();
  if (lock.host !== undefined && lock.host !== deps.host) return idleBeat();

  // 2. current.json の停滞判定 (欠落・破損は誤殺回避のため何もしない)。
  const state = await readPhaseState(logDir, deps.fs);
  if (state === null) return idleBeat();
  const timeouts: WatchdogTimeouts = {
    defaultSec: envInt(deps.env, 'WATCHDOG_TIMEOUT_SEC', WATCHDOG_DEFAULTS.timeoutSec),
    perPhase: {
      execute: envInt(
        deps.env,
        'WATCHDOG_EXECUTE_TIMEOUT_SEC',
        WATCHDOG_DEFAULTS.executeTimeoutSec,
      ),
    },
  };
  const verdict: StaleVerdict = isPhaseStale(state, new Date(deps.now), timeouts);
  if (!verdict.stale) {
    await writeHeartbeat(logDir, deps.fs, {
      ts,
      stale: false,
      phase: verdict.phase,
      age_sec: verdict.ageSec,
      limit_sec: verdict.limitSec,
      action,
      acted: false,
    });
    return EXIT.OK;
  }

  // 3. stale → action 実行 + watchdog.jsonl へ記録。
  if (action === 'kill' || action === 'skip') {
    const graceSec = envInt(deps.env, 'WATCHDOG_KILL_GRACE_SEC', WATCHDOG_DEFAULTS.killGraceSec);
    await killWedgedRun(lock.pid, deps, graceSec);
  }
  if (action === 'skip') {
    await quarantineTask(haloDir, state.task_id, deps.fs);
  }
  await appendJournal(logDir, deps.fs, {
    ts,
    action,
    pid: lock.pid,
    task_id: state.task_id,
    phase: verdict.phase,
    age_sec: verdict.ageSec,
    limit_sec: verdict.limitSec,
  });
  await writeHeartbeat(logDir, deps.fs, {
    ts,
    stale: true,
    phase: verdict.phase,
    age_sec: verdict.ageSec,
    limit_sec: verdict.limitSec,
    action,
    acted: action !== 'report',
  });
  io.print(
    `watchdog: stale loop detected — pid ${lock.pid}, phase ${verdict.phase}, ` +
      `age ${Math.round(verdict.ageSec)}s > limit ${verdict.limitSec}s (action: ${action})`,
  );
  return EXIT.OK;
}

/** `halo watchdog install` (ADR-0023, D9 §2.6)。 */
async function installWatchdog(
  parsed: ParsedArgs,
  io: Io,
  deps: WatchdogDeps,
  profile: string | undefined,
): Promise<ExitCode> {
  // 既定を持たせない: 「存在するが何もしない監督」こそがこの ADR の直す欠陥であり、
  // 登録が黙って report に倒れるとその欠陥を一段上で再生産する。
  const action = parseAction(parsed);
  const minutes = parseEveryMinutes(stringFlag(parsed, 'every'));
  const scheduler = deps.scheduler;
  const cliArgv = deps.cliArgv;
  if (scheduler === undefined || cliArgv === undefined || cliArgv.length === 0) {
    throw new CliError('watchdog install is not wired in this build', EXIT.RUNTIME, {
      hint: 'scheduler seam / CLI path unavailable',
    });
  }

  // 実 profile は登録コマンド内に --profile として明示する。schedulerInstall が末尾へ
  // 足すのは名前空間用のキーであって、lock 解決に使える profile ではない。
  const fireArgv = [
    ...cliArgv,
    'watchdog',
    '--action',
    action,
    '--cwd',
    io.flags.cwd,
    ...(profile !== undefined ? ['--profile', profile] : []),
  ];
  try {
    scheduler.install(
      WATCHDOG_TRIGGER,
      watchdogSchedulerKey(profile),
      `interval:${minutes}`,
      fireArgv,
    );
  } catch (err) {
    throw new CliError(`watchdog install failed: ${(err as Error).message}`, EXIT.RUNTIME, {
      hint: "run 'halo doctor' to check the scheduler backend",
    });
  }

  // doctor c14 は「heartbeat が登録間隔の 2 倍以内か」で判定するので、間隔をどこかに
  // 残す必要がある。heartbeat 自体は検知パスが書くもので登録間隔を知らない。
  const logDir = join(`${io.flags.cwd.replace(/\/$/, '')}/.halo`, 'logs');
  try {
    await deps.fs.mkdir(logDir, { recursive: true });
    await deps.fs.writeFile(
      join(logDir, 'watchdog-schedule.json'),
      `${JSON.stringify(
        {
          every_minutes: minutes,
          action,
          profile: profile ?? null,
          installed_at: new Date(deps.now).toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    /* best-effort: 登録自体は成功しているので、marker 失敗で失敗扱いにしない */
  }

  if (io.flags.json) {
    io.printJson({
      ok: true,
      action: 'install',
      watchdogAction: action,
      profile: profile ?? null,
      everyMinutes: minutes,
      key: watchdogSchedulerKey(profile),
    });
  } else {
    io.print(
      `登録しました: watchdog (${profile ?? '既定プロファイル'}) — ${minutes} 分毎, action=${action}`,
    );
    if (action === 'report') {
      io.warn(
        'note: action=report は検知して記録するだけで回収しません。' +
          'D9 §6.3 の手順で timeout を調整してから --action kill へ昇格してください。',
      );
    }
  }
  return EXIT.OK;
}

/** `halo watchdog uninstall` (冪等)。 */
async function uninstallWatchdog(
  io: Io,
  deps: WatchdogDeps,
  profile: string | undefined,
): Promise<ExitCode> {
  const scheduler = deps.scheduler;
  if (scheduler === undefined) {
    throw new CliError('watchdog uninstall is not wired in this build', EXIT.RUNTIME);
  }
  try {
    scheduler.uninstall(WATCHDOG_TRIGGER, watchdogSchedulerKey(profile));
  } catch (err) {
    throw new CliError(`watchdog uninstall failed: ${(err as Error).message}`, EXIT.RUNTIME);
  }
  if (io.flags.json) io.printJson({ ok: true, action: 'uninstall', profile: profile ?? null });
  else io.print(`解除しました: watchdog (${profile ?? '既定プロファイル'})`);
  return EXIT.OK;
}
