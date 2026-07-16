// `halo watchdog` (D9 §2.3-§2.5, ADR-0013): 外部監督プロセス。1 回実行して
// 「lock の持ち主が生きているのに current.json が停滞している」wedge を検知し、
// --action に応じて報告 / プロセス木 kill / タスク隔離まで行う。常駐しない
// （スケジューリングは trigger 系に委ねる）。誤殺より見逃し: 判定材料が欠けたら
// 常に何もせず exit 0。
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
} as const;

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

export async function watchdogCommand(
  parsed: ParsedArgs,
  io: Io,
  deps: WatchdogDeps,
): Promise<ExitCode> {
  const action = (stringFlag(parsed, 'action') ?? 'report') as WatchdogAction;
  if (action !== 'report' && action !== 'kill' && action !== 'skip') {
    throw new CliError(`invalid --action '${String(action)}'`, EXIT.USAGE, {
      hint: 'use one of: report | kill | skip',
    });
  }
  const profile = stringFlag(parsed, 'profile');
  const haloDir = `${io.flags.cwd.replace(/\/$/, '')}/.halo`;
  const logDir = join(haloDir, 'logs');

  // 1. lock: 無い / 持ち主が死んでいる / 別ホスト → 監督対象なし。
  const lockPath = defaultLockPath(deps.tmpdir, profile);
  let lockBody: string;
  try {
    lockBody = await deps.fs.readFile(lockPath);
  } catch {
    return EXIT.OK;
  }
  const lock = parseLockFile(lockBody);
  if (lock === null) return EXIT.OK;
  if (!deps.isProcessAlive(lock.pid)) return EXIT.OK;
  if (lock.host !== undefined && lock.host !== deps.host) return EXIT.OK;

  // 2. current.json の停滞判定 (欠落・破損は誤殺回避のため何もしない)。
  const state = await readPhaseState(logDir, deps.fs);
  if (state === null) return EXIT.OK;
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
  if (!verdict.stale) return EXIT.OK;

  // 3. stale → action 実行 + watchdog.jsonl へ記録。
  if (action === 'kill' || action === 'skip') {
    const graceSec = envInt(deps.env, 'WATCHDOG_KILL_GRACE_SEC', WATCHDOG_DEFAULTS.killGraceSec);
    await killWedgedRun(lock.pid, deps, graceSec);
  }
  if (action === 'skip') {
    await quarantineTask(haloDir, state.task_id, deps.fs);
  }
  await appendJournal(logDir, deps.fs, {
    ts: new Date(deps.now).toISOString(),
    action,
    pid: lock.pid,
    task_id: state.task_id,
    phase: verdict.phase,
    age_sec: verdict.ageSec,
    limit_sec: verdict.limitSec,
  });
  io.print(
    `watchdog: stale loop detected — pid ${lock.pid}, phase ${verdict.phase}, ` +
      `age ${Math.round(verdict.ageSec)}s > limit ${verdict.limitSec}s (action: ${action})`,
  );
  return EXIT.OK;
}
