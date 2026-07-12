// `halo status` (T26, D3 §2.5): budget.checkBudget + 直近ログ + トリガー一覧を整形するだけ。
import { stringFlag, type ParsedArgs } from '../args.js';
import type { ExitCode } from '../exit-codes.js';
import { EXIT } from '../exit-codes.js';
import type { Io } from '../io.js';
import type { CliFs } from '../core-ext/fs.js';
import { listTriggers, type SpawnAdapter } from '../core-ext/triggers.js';
import {
  checkBudget,
  isIterationLogName,
  parseEnvFile,
  type BudgetStatus,
  type IterationLog,
  type BudgetLimits,
} from '@tsurupong/halo-core';

export interface StatusDeps {
  fs: CliFs;
  now: number;
  /** listTriggers 用 (status では spawn しないがコンテキスト整合のため受ける)。 */
  spawn: SpawnAdapter;
  /** 予算上限。テスト注入用の上書き。未指定時は --profile のプロファイル env から解決する。 */
  limits?: BudgetLimits;
}

function haloDirOf(cwd: string): string {
  return `${cwd.replace(/\/$/, '')}/.halo`;
}
function join(a: string, b: string): string {
  return `${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`;
}

/** プロファイル env の予算キー (DAILY_MAX_*) を BudgetLimits に写像する。純粋。 */
export function parseBudgetLimits(env: Record<string, string>): BudgetLimits {
  const limits: BudgetLimits = {};
  const iter = Number(env.DAILY_MAX_ITERATIONS);
  if (env.DAILY_MAX_ITERATIONS !== undefined && Number.isFinite(iter)) {
    limits.dailyMaxIterations = iter;
  }
  const cost = Number(env.DAILY_MAX_COST_USD);
  if (env.DAILY_MAX_COST_USD !== undefined && Number.isFinite(cost)) {
    limits.dailyMaxCostUsd = cost;
  }
  return limits;
}

/**
 * `--profile <name>` の env (.halo/profiles/<name>.env) から予算上限を解決する (D3 §2.5)。
 * profile 未指定・ファイル不在・読み取り失敗はいずれも無制限扱い (graceful, status は非致命)。
 * 不在時は io.warn で利用者に通知する。
 */
async function resolveProfileLimits(
  profilesDir: string,
  profile: string | undefined,
  fs: CliFs,
  io: Io,
): Promise<BudgetLimits> {
  if (profile === undefined) return {};
  let body: string;
  try {
    body = await fs.readFile(join(profilesDir, `${profile}.env`));
  } catch {
    io.warn(`warning: profile '${profile}' not found in ${profilesDir}/; showing unlimited budget.`);
    return {};
  }
  return parseBudgetLimits(parseEnvFile(body));
}

/** logs/ から最新 iter_N.json を読む (core に lastRun が無いため CLI 側で集約)。 */
export async function loadLastRun(logDir: string, fs: CliFs): Promise<IterationLog | null> {
  let names: string[];
  try {
    names = await fs.readdir(logDir);
  } catch {
    return null;
  }
  const iters = names
    .filter(isIterationLogName)
    .map((n) => ({ n, iter: Number(/^iter_(\d+)\.json$/.exec(n)![1]) }))
    .sort((a, b) => b.iter - a.iter);
  if (iters.length === 0) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(join(logDir, iters[0]!.n))) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as IterationLog;
  } catch {
    return null;
  }
}

export async function statusCommand(
  parsed: ParsedArgs,
  io: Io,
  deps: StatusDeps,
): Promise<ExitCode> {
  const profile = stringFlag(parsed, 'profile');
  const haloDir = haloDirOf(io.flags.cwd);
  const logDir = join(haloDir, 'logs');
  const profilesDir = stringFlag(parsed, 'profiles-dir') ?? join(haloDir, 'profiles');

  // limits: テスト注入 (deps.limits) 優先、無ければ --profile の env から解決 (D3 §2.5)。
  const limits = deps.limits ?? (await resolveProfileLimits(profilesDir, profile, deps.fs, io));

  const budget: BudgetStatus = await checkBudget({
    logDir,
    fs: deps.fs,
    now: deps.now,
    ...limits,
  });
  const lastRun = await loadLastRun(logDir, deps.fs);
  const stopPresent = await deps.fs.exists(join(haloDir, 'STOP'));
  const triggers = await listTriggers({
    haloDir,
    cwd: io.flags.cwd,
    fs: deps.fs,
    spawn: deps.spawn,
  });

  if (io.flags.json) {
    io.printJson({
      ok: true,
      stop: stopPresent,
      budget,
      lastRun: lastRun ? { iter: lastRun.iter, outcome: lastRun.outcome } : null,
      triggers: triggers.map((t) => ({ name: t.name, alive: t.alive })),
    });
    return EXIT.OK;
  }

  io.print(`STOP: ${stopPresent ? 'あり (停止中)' : 'なし'}`);
  io.print(
    `本日のイテレーション: ${budget.usedIterations}` +
      (budget.remainingIterations != null
        ? ` / 予算 ${budget.dailyMaxIterations} (残 ${budget.remainingIterations})`
        : ' (予算無制限)'),
  );
  io.print(`実行可否: ${budget.ok ? '可 (予算内)' : '不可 (予算超過)'}`);
  io.print(`直近ループ: ${lastRun ? `iter ${lastRun.iter} — ${lastRun.outcome}` : '実績なし'}`);
  io.print(
    `登録トリガー: ${triggers.length === 0 ? 'なし' : triggers.map((t) => `${t.name}${t.alive ? '' : ' (要再登録)'}`).join(', ')}`,
  );
  return EXIT.OK;
}
