// preflight — the two-stage preflight of D2 §4. The light stage (STOP / lock /
// budget) runs at the top of every iteration and must be cheap; the heavy stage
// (worktree clean / disk / graph freshness) runs only once a real task exists
// (D2 §4.1–4.2, 要件 §4.4). Both are ordered short-circuit orchestrators whose
// individual checks are injected, so the ordering + short-circuit is unit-testable
// without touching the filesystem or git, and the loop wires in the concrete
// side-effecting checks (STOP file read, `lock` acquire, `budget` aggregate).
//
// The "ready タスク有無" step of D2 §4.1 is realised by the loop's Next state
// (task-source `op=next`, which the loop needs anyway): folding it in here would
// spawn task-source twice per iteration. So this module owns STOP / lock / budget
// and the loop owns the ready check — see loop.ts (D2 §2.1 diagram: Next is a
// distinct state after PreflightLight).

import { join } from 'node:path';
import type { BudgetStatus } from './budget.js';

/** A light-stage stop (each maps to a clean exit 0 in the loop, D2 §2.7). */
export type LightStopReason = 'STOP' | 'LOCK_HELD' | 'BUDGET_EXCEEDED';

/** A heavy-stage abort — the loop skips executing this task and records it (D2 §4.2). */
export type HeavyStopReason = 'DIRTY_WORKTREE' | 'DISK_LOW' | 'GRAPH_STALE';

export type LightDecision = { proceed: true } | { proceed: false; reason: LightStopReason };
export type HeavyDecision = { proceed: true } | { proceed: false; reason: HeavyStopReason };

/** Awaitable predicate; checks may be sync or async so tests can stay synchronous. */
export type Check = () => boolean | Promise<boolean>;

/**
 * The three light-stage checks (D2 §4.1), each returning `true` when it should
 * stop the run. Ordered "cheapest + most decisive first": STOP (human intent),
 * then lock (cheapest multi-launch guard), then budget (cheaper than spawning
 * task-source). Injected so the ordering is testable without real fs/lock.
 */
export interface LightChecks {
  /** `.halo/STOP` kill-switch present (D2 §4.1 #1). */
  stopFilePresent: Check;
  /** The single-instance lock is held by a live other process (D2 §4.1 #2). */
  lockHeldByOther: Check;
  /** The daily budget has no headroom left (D2 §4.1 #3). */
  budgetExhausted: Check;
}

/**
 * Run the light stage in the canonical order, short-circuiting on the first
 * check that fires (D2 §4.1). Never runs a later check once an earlier one stops
 * — order is load-bearing (cheap before expensive). Pure orchestration over the
 * injected checks.
 */
export async function runPreflightLight(checks: LightChecks): Promise<LightDecision> {
  if (await checks.stopFilePresent()) return { proceed: false, reason: 'STOP' };
  if (await checks.lockHeldByOther()) return { proceed: false, reason: 'LOCK_HELD' };
  if (await checks.budgetExhausted()) return { proceed: false, reason: 'BUDGET_EXCEEDED' };
  return { proceed: true };
}

/**
 * The heavy-stage checks (D2 §4.2). Only `worktreeClean` is required for Phase 1;
 * disk and graph-freshness are optional stubs (T19: Phase 1 no-op / Phase 4). An
 * omitted optional check is treated as passing.
 */
export interface HeavyChecks {
  /** git working tree has no uncommitted changes (D2 §4.2 #1). */
  worktreeClean: Check;
  /** Free disk above the worktree threshold (D2 §4.2 #2; Phase 1 stub → omit). */
  diskOk?: Check;
  /** Code graph is fresh vs main HEAD (D2 §4.2 #4; Phase 4 stub → omit). */
  graphFresh?: Check;
}

/**
 * Run the heavy stage in order, short-circuiting on the first failing check
 * (D2 §4.2). A failure aborts this task without stopping the loop — the loop
 * records it and moves on (§4.2 中止(記録)). Optional checks default to pass.
 */
export async function runPreflightHeavy(checks: HeavyChecks): Promise<HeavyDecision> {
  if (!(await checks.worktreeClean())) return { proceed: false, reason: 'DIRTY_WORKTREE' };
  if (checks.diskOk && !(await checks.diskOk())) return { proceed: false, reason: 'DISK_LOW' };
  if (checks.graphFresh && !(await checks.graphFresh())) return { proceed: false, reason: 'GRAPH_STALE' };
  return { proceed: true };
}

// --- concrete side-effecting check builders ---------------------------------

/** Kill-switch filename under `.halo/` (D2 §2.7 #1, 要件 §4.4). */
export const STOP_FILENAME = 'STOP';

/** Absolute path to the STOP kill-switch for a `.halo` directory. Pure. */
export function stopFilePath(haloDir: string): string {
  return join(haloDir, STOP_FILENAME);
}

/** Minimal fs seam for the STOP check (subset of the discovery/budget seams). */
export interface PreflightFs {
  exists(path: string): Promise<boolean>;
}

/** Concrete STOP-file check: is `<haloDir>/STOP` present? (D2 §4.1 #1). */
export async function isStopFilePresent(haloDir: string, fs: PreflightFs): Promise<boolean> {
  return fs.exists(stopFilePath(haloDir));
}

/** Map a {@link BudgetStatus} to the light-stage "exhausted" predicate (D2 §4.1 #3). Pure. */
export function isBudgetExhausted(status: BudgetStatus): boolean {
  return !status.ok;
}

/** Injected git runner returning captured stdout (so the check needs no real repo). */
export type GitRunner = (args: readonly string[]) => Promise<{ stdout: string }>;

/**
 * Concrete worktree-clean check (D2 §4.2 #1): `git status --porcelain` is empty.
 * Any output means uncommitted changes exist → not clean.
 */
export async function isWorktreeClean(git: GitRunner): Promise<boolean> {
  const { stdout } = await git(['status', '--porcelain']);
  return stdout.trim() === '';
}
