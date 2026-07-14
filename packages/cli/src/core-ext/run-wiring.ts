// run の実配線 (D3 §6, D2 §2/§4/§8): CLI の `RunHooks` を core の discovery /
// preflight / loop / runPort へ結線する唯一の場所。deps.ts はここを node シームで
// 束ねるだけ。ロジックは持たず「core 関数呼び出し → 結果を RunHooks 形へ」に徹する
// (D3 §0)。全シームは注入可能なので、統合テストはネットワーク/claude 課金ゼロで
// 実プロセス境界 (runPort + bash フィクスチャ) を通せる。
import { spawn as nodeSpawn } from 'node:child_process';
import { hostname } from 'node:os';
import { readdir, readFile, mkdir, writeFile, access } from 'node:fs/promises';
import type {
  DiscoveredPlugin,
  DiscoveryFs,
  LoopPorts,
  LoopDeps,
  PortRunner,
  LockSys,
  LightDecision,
  HeavyDecision,
  LoopResult,
} from '@tsurupong/halo-core';
import {
  discoverPort,
  createNodeDiscoveryFs,
  runPort,
  runPreflightLight,
  runPreflightHeavy,
  isStopFilePresent,
  isBudgetExhausted,
  isWorktreeClean,
  checkBudget,
  createLogger,
  createPhaseTracker,
  runLoop as coreRunLoop,
  acquireLock,
  releaseLock,
  defaultLockPath,
  parseLockFile,
  isStaleLock,
  type GitRunner,
} from '@tsurupong/halo-core';
import type { RunHooks, RunContext } from '../commands/run.js';

/** ports/*.d 走査対象 (D2 §2.1 の loop が使う 6 ポート)。trigger/mcp は run では未使用。 */
const LOOP_PORT_ORDER = ['task-source', 'context', 'executor', 'gate', 'sink', 'on-fail'] as const;

/** manifest に timeoutSec を持たない非 executor プラグインの既定プロセス上限 (秒)。 */
export const DEFAULT_PORT_TIMEOUT_SEC = 300;

/** worktree 生成/破棄シーム (D2 §8 は CLI/createWorktree の責務と規定)。 */
export interface WorktreeSeam {
  create(cwd: string, taskId: string): Promise<string>;
  remove(cwd: string, workdir: string): Promise<void>;
}

/** 実配線が触れる全 I/O シーム。既定は node 実装、テストは必要な物だけ差し替える。 */
export interface RunWiringSeams {
  discoveryFs: DiscoveryFs;
  /** budget/logger/preflight 用の最小 fs (readdir/readFile/mkdir/writeFile/exists)。 */
  logsFs: {
    readdir(path: string): Promise<string[]>;
    readFile(path: string): Promise<string>;
    mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
    writeFile(path: string, data: string): Promise<void>;
    exists(path: string): Promise<boolean>;
  };
  lockSys: LockSys;
  git(cwd: string): GitRunner;
  worktree: WorktreeSeam;
  tmpdir: string;
  pid: number;
  host: string;
  now(): number;
}

function join(a: string, b: string): string {
  return `${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`;
}

/** process.env を string 値のみに絞った子プロセス用の基底 env。 */
function baseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** child_process.spawn を Promise 化して stdout/stderr/exit を集める最小ランナー。 */
function spawnCapture(
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = nodeSpawn(cmd, args as string[], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', () => resolve({ code: 1, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** 既定 (node) シーム束。 */
export function nodeRunWiringSeams(): RunWiringSeams {
  const logsFs = {
    readdir: (path: string) => readdir(path),
    readFile: (path: string) => readFile(path, 'utf8'),
    mkdir: (path: string, opts: { recursive: true }) => mkdir(path, opts),
    writeFile: async (path: string, data: string) => {
      await writeFile(path, data, 'utf8');
    },
    exists: (path: string) =>
      access(path).then(
        () => true,
        () => false,
      ),
  };
  const lockSys: LockSys = {
    async writeExclusive(path, data) {
      await writeFile(path, data, { flag: 'wx' });
    },
    readFile: (path) => readFile(path, 'utf8'),
    async unlink(path) {
      const { unlink } = await import('node:fs/promises');
      await unlink(path);
    },
    isProcessAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    now: () => Date.now(),
  };
  const git =
    (cwd: string): GitRunner =>
    async (args) => {
      const r = await spawnCapture('git', args, cwd);
      return { stdout: r.stdout };
    };
  const worktree: WorktreeSeam = {
    async create(cwd, taskId) {
      // 置き場は HALO_WORKTREE_DIR で上書き可能 (既定は $TMPDIR — WSL2 では ext4 側が
      // 高速。観察したいデバッグ時などに見える場所を指定する用途)。
      const base = process.env['HALO_WORKTREE_DIR']?.replace(/\/$/, '') || seamTmpdir();
      const path = join(base, `halo-wt-issue-${taskId}`);
      const branch = `feature/issue-${taskId}`;
      // 既存の残骸を掃除してから add (冪等)。ブランチ二重チェックアウトは git が禁止する。
      await spawnCapture('git', ['worktree', 'remove', '--force', path], cwd);
      // -B: 過去 run の残骸ブランチが古いコミットを指していても常に現 HEAD へ
      // リセットする (worktree は使い捨てで、起点は常に最新 HEAD)。
      const r = await spawnCapture('git', ['worktree', 'add', '--force', '-B', branch, path], cwd);
      if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr}`.trim());
      return path;
    },
    async remove(cwd, workdir) {
      await spawnCapture('git', ['worktree', 'remove', '--force', workdir], cwd);
    },
  };
  const tmpdir = seamTmpdir();
  return {
    discoveryFs: createNodeDiscoveryFs(),
    logsFs,
    lockSys,
    git,
    worktree,
    tmpdir,
    pid: process.pid,
    host: hostname(),
    now: () => Date.now(),
  };
}

function seamTmpdir(): string {
  return process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp';
}

// --- discovery: 6 ポートを LoopPorts へ ---------------------------------------

/** haloDir 下の全 loop ポートを走査して LoopPorts を組む (D2 §6)。 */
export async function discoverLoopPorts(haloDir: string, fs: DiscoveryFs): Promise<LoopPorts> {
  const [taskSource, context, executor, gate, sink, onFail] = await Promise.all(
    LOOP_PORT_ORDER.map((port) => discoverPort({ haloRoot: haloDir, port, fs, requireExec: true })),
  );
  return {
    taskSource: taskSource!.plugins,
    context: context!.plugins,
    executor: executor!.plugins,
    gate: gate!.plugins,
    sink: sink!.plugins,
    onFail: onFail!.plugins,
  };
}

// --- 予算 / STOP の共通判定 ---------------------------------------------------

function logsDir(haloDir: string): string {
  return join(haloDir, 'logs');
}

async function isBudgetExhaustedFor(ctx: RunContext, seams: RunWiringSeams): Promise<boolean> {
  const status = await checkBudget({
    logDir: logsDir(ctx.haloDir),
    fs: seams.logsFs,
    now: ctx.now,
    ...(ctx.config.dailyMaxIterations != null
      ? { dailyMaxIterations: ctx.config.dailyMaxIterations }
      : {}),
    ...(ctx.config.dailyMaxCostUsd != null ? { dailyMaxCostUsd: ctx.config.dailyMaxCostUsd } : {}),
  });
  return isBudgetExhausted(status);
}

/** preflight 軽量段の lock 検査 (読み取りのみ)。真の排他は runLoop の O_EXCL acquire。 */
async function isLockHeldByOther(
  profile: string | undefined,
  seams: RunWiringSeams,
): Promise<boolean> {
  const path = defaultLockPath(seams.tmpdir, profile);
  let body: string;
  try {
    body = await seams.lockSys.readFile(path);
  } catch {
    return false; // ロック無し
  }
  const info = parseLockFile(body);
  if (info === null) return false; // 破損 = 再取得可能、ブロックしない
  return !isStaleLock({
    info,
    now: seams.lockSys.now(),
    ownerAlive: seams.lockSys.isProcessAlive(info.pid),
  });
}

// --- PortRunner ---------------------------------------------------------------

function makeRunner(ctx: RunContext): PortRunner {
  return (plugin: DiscoveredPlugin, stdin: unknown, opts?: { timeoutSec?: number }) =>
    runPort({
      execPath: plugin.execPath,
      cwd: ctx.cwd,
      env: { ...baseEnv(), ...(plugin.manifest.env ?? {}) },
      stdin,
      timeoutMs: (opts?.timeoutSec ?? DEFAULT_PORT_TIMEOUT_SEC) * 1000,
    });
}

// --- RunHooks 組み立て --------------------------------------------------------

/** 注入シームから RunHooks を組む。1 回の run 内で 3 メソッドは lock 保持状態を共有する。 */
export function createRunHooks(seams: RunWiringSeams = nodeRunWiringSeams()): RunHooks {
  return {
    async preflightLight(ctx: RunContext): Promise<LightDecision> {
      return runPreflightLight({
        stopFilePresent: () => isStopFilePresent(ctx.haloDir, seams.logsFs),
        lockHeldByOther: () => isLockHeldByOther(ctx.config.profileName, seams),
        budgetExhausted: () => isBudgetExhaustedFor(ctx, seams),
      });
    },

    async preflightHeavy(ctx: RunContext): Promise<HeavyDecision> {
      // Phase 1 重量段は worktree clean のみ (disk/graph は D2 §4.2 の後続フェーズ)。
      return runPreflightHeavy({
        worktreeClean: () => isWorktreeClean(seams.git(ctx.cwd)),
      });
    },

    async runLoop(ctx: RunContext): Promise<LoopResult> {
      // 真の単一インスタンス排他: O_EXCL acquire。別インスタンスが保持中なら
      // 正当な非実行 (STOP 相当) として exit 0 に写像 (D2 §4.1 #2)。
      const acq = await acquireLock({
        path: defaultLockPath(seams.tmpdir, ctx.config.profileName),
        pid: seams.pid,
        host: seams.host,
        sys: seams.lockSys,
      });
      if (!acq.acquired) return { endReason: 'STOP', iterations: [] };

      try {
        const ports = await discoverLoopPorts(ctx.haloDir, seams.discoveryFs);
        const logger = createLogger({ logDir: logsDir(ctx.haloDir), fs: seams.logsFs });
        // ハング検知: 各工程境界で logs/current.json を上書き (task md: phase-boundary-log)。
        const phaseTracker = createPhaseTracker({
          logDir: logsDir(ctx.haloDir),
          fs: seams.logsFs,
          now: seams.now,
        });
        const deps: LoopDeps = {
          config: {
            autonomy: ctx.config.autonomy,
            maxIter: ctx.config.maxIter,
            timeoutSec: ctx.config.timeoutSec,
            ...(ctx.config.profileName != null ? { profileName: ctx.config.profileName } : {}),
          },
          ports,
          runner: makeRunner(ctx),
          logger,
          phaseTracker,
          now: seams.now,
          isStopPresent: () => isStopFilePresent(ctx.haloDir, seams.logsFs),
          isBudgetOk: async () => !(await isBudgetExhaustedFor(ctx, seams)),
          createWorktree: (task) => seams.worktree.create(ctx.cwd, String(task.task_id)),
          removeWorktree: (workdir) => seams.worktree.remove(ctx.cwd, workdir),
          changedFiles: async (workdir) => {
            const { stdout } = await seams.git(workdir)(['status', '--porcelain']);
            return stdout
              .split('\n')
              .map((l) => l.slice(3).trim())
              .filter((l) => l !== '');
          },
          // Phase 1 / L1: PR を生成する sink が無いため op=complete は発火させない (D1 §1.5)。
          resolvePrUrl: () => '',
        };
        return await coreRunLoop(deps);
      } finally {
        await releaseLock(acq.handle, seams.lockSys);
      }
    },
  };
}
