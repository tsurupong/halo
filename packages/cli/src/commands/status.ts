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
  type Outcome,
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
    io.warn(
      `warning: profile '${profile}' not found in ${profilesDir}/; showing unlimited budget.`,
    );
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

// --- 実行結果サマリ集計 (D9 §3) -----------------------------------------------

/** サマリの既定期間 (日)。`--days` で上書き可能。 */
export const DEFAULT_SUMMARY_WINDOW_DAYS = 7;

/** transient 失敗の理由分類 (D9 §3/§4 と同一の正規表現ファミリ)。判定順に評価する。 */
const FAILURE_REASON_CATEGORIES: ReadonlyArray<{ category: string; pattern: RegExp }> = [
  { category: 'rate_limit', pattern: /rate.?limit|429/i },
  { category: 'flaky_test', pattern: /flaky/i },
  { category: 'network', pattern: /ECONNRESET|ETIMEDOUT|ENETUNREACH|temporar/i },
  { category: 'timeout', pattern: /timed?.?out/i },
];

export interface RunSummary {
  /** 期間内の iter 件数。 */
  total: number;
  /** outcome 別件数 (期間内に存在した outcome のみキーを持つ)。 */
  byOutcome: Partial<Record<Outcome, number>>;
  /** 失敗 (failed / escalated) の理由分類別件数。 */
  failureCategories: Record<string, number>;
  /** 集計対象期間 (日)。 */
  windowDays: number;
}

/** 1 件の失敗 iter を理由分類へ写像する (D9 §3.2 判定順)。純粋。history でも利用。 */
export function classifyFailure(entry: IterationLog): string {
  const status = entry.executor?.status;
  if (status === 'timeout' || status === 'stuck') return status;
  const failedGates = (entry.gates ?? []).filter((g) => g.result === 'fail');
  for (const gate of failedGates) {
    if (gate.reason == null) continue;
    for (const { category, pattern } of FAILURE_REASON_CATEGORIES) {
      if (pattern.test(gate.reason)) return category;
    }
  }
  if (failedGates.length > 0) return `gate:${failedGates[0]!.name}`;
  return 'other';
}

/**
 * iter_N.json 群から期間内の実行結果サマリを組む (D9 §3)。純粋 (now は引数)。
 * started_at が期間外・解釈不能な iter は集計から除外する。
 */
export function aggregateRuns(
  entries: readonly IterationLog[],
  options: { windowDays: number; now: number },
): RunSummary {
  const cutoff = options.now - options.windowDays * 24 * 60 * 60 * 1000;
  const byOutcome: Partial<Record<Outcome, number>> = {};
  const failureCategories: Record<string, number> = {};
  let total = 0;
  for (const entry of entries) {
    const startedMs = Date.parse(entry.started_at);
    if (Number.isNaN(startedMs) || startedMs < cutoff || startedMs > options.now) continue;
    total += 1;
    byOutcome[entry.outcome] = (byOutcome[entry.outcome] ?? 0) + 1;
    if (entry.outcome === 'failed' || entry.outcome === 'escalated') {
      const category = classifyFailure(entry);
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
    }
  }
  return { total, byOutcome, failureCategories, windowDays: options.windowDays };
}

/** 期間内 executor コストの合算。 */
export interface CostSummary {
  input_tokens: number;
  output_tokens: number;
  usd: number;
}

/**
 * iter_N.json 群から期間内の executor コストを合算する。純粋 (now は引数)。
 * cost 欠損 (旧ログ) は 0 扱い。RunSummary とは分離 (既存 summary 形状の互換維持)。
 */
export function aggregateCost(
  entries: readonly IterationLog[],
  options: { windowDays: number; now: number },
): CostSummary {
  const cutoff = options.now - options.windowDays * 24 * 60 * 60 * 1000;
  const total: CostSummary = { input_tokens: 0, output_tokens: 0, usd: 0 };
  for (const entry of entries) {
    const startedMs = Date.parse(entry.started_at);
    if (Number.isNaN(startedMs) || startedMs < cutoff || startedMs > options.now) continue;
    const cost = entry.executor?.cost;
    if (cost === undefined) continue;
    total.input_tokens += cost.input_tokens ?? 0;
    total.output_tokens += cost.output_tokens ?? 0;
    total.usd += cost.usd_estimate ?? 0;
  }
  return total;
}

/** logs/ の全 iter_N.json を読む (壊れた/非オブジェクトのログは黙って除外)。 */
export async function loadRuns(logDir: string, fs: CliFs): Promise<IterationLog[]> {
  let names: string[];
  try {
    names = await fs.readdir(logDir);
  } catch {
    return [];
  }
  const out: IterationLog[] = [];
  for (const name of names.filter(isIterationLogName)) {
    try {
      const parsed = JSON.parse(await fs.readFile(join(logDir, name))) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      out.push(parsed as IterationLog);
    } catch {
      // 読めないログは集計対象外 (status は非致命)。
    }
  }
  return out;
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
  // --days: 不正値・未指定は既定 7 日 (status は非致命、graceful degrade)。
  const daysRaw = Number(stringFlag(parsed, 'days'));
  const windowDays =
    Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : DEFAULT_SUMMARY_WINDOW_DAYS;
  const runs = await loadRuns(logDir, deps.fs);
  const summary = aggregateRuns(runs, { windowDays, now: deps.now });
  const cost = aggregateCost(runs, { windowDays, now: deps.now });
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
      summary,
      cost,
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
  const outcomeText = Object.entries(summary.byOutcome)
    .map(([k, v]) => `${k} ${v}`)
    .join(' / ');
  io.print(
    `直近${summary.windowDays}日の実績: ${summary.total} 件` +
      (outcomeText === '' ? '' : ` (${outcomeText})`),
  );
  io.print(
    `直近${summary.windowDays}日のコスト: $${cost.usd.toFixed(2)} (in ${cost.input_tokens} / out ${cost.output_tokens} tokens)`,
  );
  const failureText = Object.entries(summary.failureCategories)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  if (failureText !== '') io.print(`失敗内訳: ${failureText}`);
  io.print(
    `登録トリガー: ${triggers.length === 0 ? 'なし' : triggers.map((t) => `${t.name}${t.alive ? '' : ' (要再登録)'}`).join(', ')}`,
  );
  return EXIT.OK;
}
