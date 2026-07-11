// budget — daily budget by on-the-fly measurement (D2 §5, 要件 §4.4/§8.2). Holds
// no ledger: the source of truth is the day's `logs/iter_N.json` records, which
// the loop counts and sums each time, comparing against injected limits (D2 §5.2
// グローバル状態ゼロ). `.halo/` deletion alone resets everything.
//
// The aggregation + comparison is pure (D2 §1.2, D8 §1.1); only `checkBudget`
// touches the filesystem, through an injected seam so tests need no real files
// and corrupt/missing logs are handled gracefully.

import type { IterationLog } from './logger.js';

/**
 * Injected limits (要件 §11.2 調整可能な初期値, given by the profile — D2 §5.2).
 * Both optional: an undefined dimension imposes no cap. Cost is auxiliary and may
 * be omitted even when the iteration cap is set (D2 §5.1).
 */
export interface BudgetLimits {
  /** `DAILY_MAX_ITERATIONS` — max iterations per local calendar day. */
  dailyMaxIterations?: number;
  /** `DAILY_MAX_COST_USD` — optional max summed executor cost per day. */
  dailyMaxCostUsd?: number;
}

/** Aggregated usage for the current local day. */
export interface BudgetUsage {
  /** Count of today's iteration logs. */
  usedIterations: number;
  /** Sum of today's recorded `executor.cost.usd_estimate` (0 when none recorded). */
  usedCostUsd: number;
}

/** Full budget judgement handed back to preflight / status (D3 §2.5). */
export interface BudgetStatus extends BudgetUsage {
  /** Whether another iteration may run (all set limits still have headroom). */
  ok: boolean;
  dailyMaxIterations?: number;
  dailyMaxCostUsd?: number;
  /** Remaining iterations (limit − used, clamped ≥ 0); null when no iteration cap. */
  remainingIterations: number | null;
  /** Remaining cost (limit − used, clamped ≥ 0); null when no cost cap. */
  remainingCostUsd: number | null;
}

/**
 * Local calendar day key `YYYY-MM-DD` for a timestamp (day boundary is the local
 * timezone, D2 §5.2). Pure. Used to bucket logs into "today".
 */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Timestamp a log is attributed to: its recorded `ended_at`, falling back to
 * `started_at`. Returns null when neither is a parseable date (a foreign / corrupt
 * record the caller excludes from today's tally). Pure.
 */
export function logTimestampMs(log: Pick<IterationLog, 'started_at' | 'ended_at'>): number | null {
  for (const raw of [log.ended_at, log.started_at]) {
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return null;
}

/**
 * Aggregate today's usage from parsed logs (D2 §5.1). Pure. Counts one iteration
 * per log dated today and sums any `executor.cost.usd_estimate`. Logs from other
 * days, or without a parseable date, are ignored.
 */
export function aggregateDailyUsage(logs: readonly IterationLog[], now: number): BudgetUsage {
  const today = localDayKey(now);
  let usedIterations = 0;
  let usedCostUsd = 0;
  for (const log of logs) {
    const ts = logTimestampMs(log);
    if (ts === null || localDayKey(ts) !== today) continue;
    usedIterations += 1;
    const usd = log.executor?.cost?.usd_estimate;
    if (typeof usd === 'number' && Number.isFinite(usd)) usedCostUsd += usd;
  }
  return { usedIterations, usedCostUsd };
}

/**
 * Compare aggregated usage against limits (D2 §5.1):
 *   ok = usedIters < limitIters AND (limitCost unset OR usedCost < limitCost)
 * An unset limit does not constrain that dimension. Pure — no fs, no clock.
 */
export function evaluateBudget(usage: BudgetUsage, limits: BudgetLimits = {}): BudgetStatus {
  const { dailyMaxIterations, dailyMaxCostUsd } = limits;
  const iterOk = dailyMaxIterations === undefined || usage.usedIterations < dailyMaxIterations;
  const costOk = dailyMaxCostUsd === undefined || usage.usedCostUsd < dailyMaxCostUsd;
  return {
    ok: iterOk && costOk,
    usedIterations: usage.usedIterations,
    usedCostUsd: usage.usedCostUsd,
    ...(dailyMaxIterations !== undefined ? { dailyMaxIterations } : {}),
    ...(dailyMaxCostUsd !== undefined ? { dailyMaxCostUsd } : {}),
    remainingIterations: dailyMaxIterations === undefined ? null : Math.max(0, dailyMaxIterations - usage.usedIterations),
    remainingCostUsd: dailyMaxCostUsd === undefined ? null : Math.max(0, dailyMaxCostUsd - usage.usedCostUsd),
  };
}

// --- side-effecting read of the logs directory ------------------------------

/** Injected filesystem seam (subset of node:fs/promises) so the core stays pure. */
export interface BudgetFs {
  /** List directory entries (names only). Should reject with `code === 'ENOENT'` when absent. */
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

export interface CheckBudgetOptions extends BudgetLimits {
  /** `.halo/logs` directory holding `iter_N.json` records. */
  logDir: string;
  fs: BudgetFs;
  /** Current time (ms since epoch). Injected so the day boundary is testable. */
  now: number;
}

/** True for `iter_<n>.json` names the logger writes (buildLogPath). */
export function isIterationLogName(name: string): boolean {
  return /^iter_\d+\.json$/.test(name);
}

/**
 * Read the day's logs and evaluate the budget (D2 §5). Robust to a missing log
 * directory (treated as no usage → full budget) and to individual missing /
 * corrupt / non-conforming files (skipped, never fatal — D2 §5, budget must not
 * crash preflight). Only `iter_N.json` files are considered.
 */
export async function checkBudget(options: CheckBudgetOptions): Promise<BudgetStatus> {
  const { logDir, fs, now, ...limits } = options;
  const logs = await readDailyLogs(logDir, fs);
  const usage = aggregateDailyUsage(logs, now);
  return evaluateBudget(usage, limits);
}

async function readDailyLogs(logDir: string, fs: BudgetFs): Promise<IterationLog[]> {
  let names: string[];
  try {
    names = await fs.readdir(logDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const sep = logDir.endsWith('/') ? '' : '/';
  const logs: IterationLog[] = [];
  for (const name of names) {
    if (!isIterationLogName(name)) continue;
    const parsed = await readLog(`${logDir}${sep}${name}`, fs);
    if (parsed !== null) logs.push(parsed);
  }
  return logs;
}

/** Read + parse one log file; null on any read/parse error or non-object body. */
async function readLog(path: string, fs: BudgetFs): Promise<IterationLog | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path)) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as IterationLog;
  } catch {
    return null;
  }
}
