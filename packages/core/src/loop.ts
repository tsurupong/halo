// loop — the core state machine of D2 §2. One iteration = one task (fresh-context
// principle, 要件 §3.2); no iteration state lives in memory beyond the per-task
// retry reason re-injected into the next prompt (D2 §2.4). The driver is a pure-ish
// orchestrator: every side effect (process spawn, worktree add/remove, STOP/budget
// reads, logging) is injected, so the whole machine is exercised in loop.test.ts
// with fakes and in loop.regression.test.ts with real fixture plugins — zero
// network, zero claude billing (D8 §2).
//
// The four port strategies of D2 §3.6 (single / merge / logical-AND / best-effort)
// are assembled here from a single injected {@link PortRunner} (one runPort call).
// The pure decision pieces (fragment merge, gate verdict, prompt build, executor
// status classification, termination predicates) are exported for direct unit test.

import type {
  TaskSourceOut,
  ContextOut,
  Fragment,
  ExecutorIn,
  ExecutorOut,
  GateIn,
  GateOut,
  SinkIn,
  OnFailIn,
  MinAutonomy,
} from '@tsurupong/halo-contracts';
import type { DiscoveredPlugin } from './discovery.js';
import type { HeavyDecision } from './preflight.js';
import type { KindPrompt } from './harness.js';
import { shouldRunSink } from './autonomy.js';
import { classifyExit, parseJsonStdout, type ExitClass, type RunPortResult } from './runPort.js';
import type {
  ExecutorRecord,
  GateResult,
  IterationInput,
  Logger,
  Outcome,
  PluginDiagnostic,
} from './logger.js';
import type { LoopPhase, PhaseTracker } from './phase.js';

/** Adjustable initial values (要件 §11.2). The loop hardcodes none of these. */
export const LOOP_DEFAULTS = {
  /** Retry-count at which the loop labels an outcome `escalated` in logs (D2 §2.4). */
  retryThreshold: 3,
  /** Context token ceiling before truncation (要件 §3.2 原則4, 100k 初期値). */
  contextTokenLimit: 100_000,
  /** Executor `max_turns` (D1 §1.3 default 40). */
  maxTurns: 40,
  /** Executor `timeout_sec` (D1 §1.3 default 900). */
  executorTimeoutSec: 900,
  /**
   * Grace (seconds) the executor's process-level wall gets over its budget
   * `timeout_sec` (D2 §3.3): the process timeout must be the *last resort*, firing
   * only after the adapter had a chance to declare its own `status:"timeout"`.
   */
  executorTimeoutGraceSec: 30,
} as const;

/**
 * Terminal conditions of D2 §2.7 — every one exits the loop cleanly. Beyond the
 * original five, `TASK_SOURCE_ERROR` distinguishes a broken task-source from a
 * healthy idle `NO_TASK` (M4), `ABORTED_ENV` marks a global environment failure
 * surfaced by PreflightHeavy (dirty worktree, low disk, stale graph — M3), and
 * `ABORTED_SIGNAL` marks a cooperative shutdown requested by SIGINT/SIGTERM
 * (ADR-0022) — the only reason that can interrupt an iteration mid-flight.
 */
export type LoopEndReason =
  | 'STOP'
  | 'BUDGET_EXCEEDED'
  | 'NO_TASK'
  | 'MAX_ITER'
  | 'TIMEOUT'
  | 'TASK_SOURCE_ERROR'
  | 'ABORTED_ENV'
  | 'ABORTED_SIGNAL';

/** Thrown for a configuration error the loop must not silently continue past (D2 §2.7). */
export class LoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopError';
  }
}

// ─── pure: context merge (D2 §2.6) ──────────────────────────────────────────

/** Rough token estimate (~4 chars/token); injectable so callers can swap a tokenizer. Pure. */
export function estimateTokensDefault(text: string): number {
  return Math.ceil(text.length / 4);
}

function isValidFragment(f: unknown): f is Fragment {
  return (
    typeof f === 'object' &&
    f !== null &&
    typeof (f as Fragment).source === 'string' &&
    typeof (f as Fragment).content === 'string' &&
    typeof (f as Fragment).priority === 'number'
  );
}

/**
 * Merge every context plugin's fragments into one list (D2 §2.6): stable-sorted by
 * `priority` descending (larger = higher, D1 §1.2), then truncated at `tokenLimit`
 * (the crossing fragment is sliced to what fits, later ones dropped). Malformed
 * fragments are ignored. Pure — no fs, deterministic.
 */
export function mergeFragments(
  lists: readonly ContextOut[],
  tokenLimit: number = LOOP_DEFAULTS.contextTokenLimit,
  estimate: (text: string) => number = estimateTokensDefault,
): Fragment[] {
  const all: Array<{ f: Fragment; i: number }> = [];
  for (const list of lists) {
    if (!list || !Array.isArray(list.fragments)) continue;
    for (const f of list.fragments) {
      if (isValidFragment(f)) all.push({ f, i: all.length });
    }
  }
  // Stable descending sort: priority first, original index breaks ties.
  all.sort((a, b) => b.f.priority - a.f.priority || a.i - b.i);

  const out: Fragment[] = [];
  let used = 0;
  for (const { f } of all) {
    const cost = estimate(f.content);
    if (used + cost <= tokenLimit) {
      out.push(f);
      used += cost;
      continue;
    }
    const remaining = tokenLimit - used;
    if (remaining > 0) out.push({ ...f, content: f.content.slice(0, remaining * 4) });
    break;
  }
  return out;
}

// ─── pure: prompt build (D2 §2.4 再注入) ─────────────────────────────────────

/** The failure carried into the next iteration's prompt for the same task (D2 §2.4). */
export interface LastFailure {
  reason: string;
  hint?: string;
  gate?: string;
}

/**
 * Assemble the executor prompt from task + merged context + the previous gate
 * failure (D2 §2.4 直近 reason の即時再注入). The "前回の失敗" section is what makes
 * the learning loop work — the next attempt sees exactly why the last one failed. Pure.
 */
export function buildPrompt(
  task: TaskSourceOut,
  fragments: readonly Fragment[],
  lastFailure?: LastFailure,
  instructions?: string,
): string {
  const parts: string[] = [`# Task ${task.task_id ?? ''}`.trim()];
  // The kind's prompt template from `.harness.yml` (D2 §7.2) comes first: it is the
  // repository's standing instructions, and the task is what to apply them to.
  if (instructions !== undefined && instructions.trim() !== '')
    parts.push(`## Instructions\n${instructions.trim()}`);
  if (task.title) parts.push(`## Title\n${task.title}`);
  if (task.body) parts.push(`## Requirement\n${task.body}`);
  if (fragments.length > 0) {
    parts.push('## Context');
    for (const f of fragments) parts.push(`### ${f.source}\n${f.content}`);
  }
  if (lastFailure) {
    const lines = [`reason: ${lastFailure.reason}`];
    if (lastFailure.hint) lines.push(`hint: ${lastFailure.hint}`);
    if (lastFailure.gate) lines.push(`gate: ${lastFailure.gate}`);
    parts.push(`## 前回の失敗 (Previous failure — fix this)\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

// ─── pure: executor status classification (D2 §2.3) ─────────────────────────

/** Executor outcome the loop branches on. `error` folds a crash/timeout to the safe side. */
export type ExecOutcome = 'done' | 'stuck' | 'timeout' | 'error';

export interface ExecClassification {
  outcome: ExecOutcome;
  out?: ExecutorOut;
}

/**
 * Classify an executor run by its stdout `status`, not its exit code (D1 §1.3,
 * D2 §2.3). A process-level timeout or non-zero exit or unparseable/invalid stdout
 * all fold to `error` (安全側に倒す → failure path). Pure.
 */
export function classifyExecutor(result: RunPortResult): ExecClassification {
  if (result.timedOut) return { outcome: 'error' };
  if (result.exitCode !== 0) return { outcome: 'error' };
  const parsed = parseJsonStdout<ExecutorOut>(result.stdout);
  if (!parsed.ok) return { outcome: 'error' };
  const status = parsed.value.status;
  if (status === 'done' || status === 'stuck' || status === 'timeout')
    return { outcome: status, out: parsed.value };
  return { outcome: 'error' };
}

// ─── pure: executor selection (D1 §1.8 kind.executor, issue #51) ───────────

/** Outcome of resolving a kind's optional `executor` name against the enabled plugins. */
export type ExecutorSelection =
  { status: 'selected'; executor: DiscoveredPlugin } | { status: 'needs-human'; reason: string };

/**
 * Select the executor plugin for a task (D1 §1.8, D2 §7): an unspecified `name`
 * keeps the current default (first enabled `executor` port plugin, discovery
 * order). A `name` that does not match any enabled executor plugin is not a
 * fallback — it never silently switches to the first plugin — it yields
 * `needs-human` so the caller can escalate the task instead. Pure; assumes
 * `plugins` is non-empty (the caller guards the empty-port case separately).
 */
export function selectExecutor(
  plugins: readonly DiscoveredPlugin[],
  name?: string,
): ExecutorSelection {
  if (name == null || name === '') return { status: 'selected', executor: plugins[0]! };
  const found = plugins.find((p) => p.name === name);
  if (found) return { status: 'selected', executor: found };
  const enabled = plugins.map((p) => p.name).join(', ') || 'none';
  return {
    status: 'needs-human',
    reason: `kind declares executor '${name}' but it is not enabled (enabled: ${enabled})`,
  };
}

/**
 * The executor's process-level wall (D2 §3.3, M2): the budget `timeout_sec` is
 * what the adapter uses to self-declare `status:"timeout"`; the process kill must
 * sit a grace margin *past* it so it is the last resort, never a preemption. An
 * explicit manifest `timeoutSec` (M1) wins when it is larger than that margin. Pure.
 */
export function execProcessTimeoutFor(
  executor: DiscoveredPlugin,
  execTimeout: number,
  execGrace: number,
): number {
  return Math.max(executor.manifest.timeoutSec ?? 0, execTimeout + execGrace);
}

// ─── pure: gate logical-AND (D2 §3.6, §2.2) ─────────────────────────────────

/** One gate execution result handed to {@link evaluateGates}. */
export interface GateRun {
  name: string;
  result: RunPortResult;
}

export interface GateVerdict {
  passed: boolean;
  /** First failure's reason/hint/gate, re-injected next iteration (D2 §2.4). */
  failure?: LastFailure;
  /** Per-gate results for the iteration log. */
  results: GateResult[];
}

/**
 * Logical-AND over all gate runs (D2 §3.6): pass only if every gate exits 0. The
 * first non-pass (exit 2 fail, or any other exit folded to fail 安全側) sets the
 * retained failure; remaining gates still run and are recorded (D2 §2.2 gate.d 全実行).
 * A fail gate's `reason` is read from its stdout `GateOut`, else synthesized. Pure.
 */
export function evaluateGates(runs: readonly GateRun[]): GateVerdict {
  const results: GateResult[] = [];
  let failure: LastFailure | undefined;
  for (const run of runs) {
    const cls: ExitClass = classifyExit(run.result);
    if (cls === 'pass') {
      results.push({ name: run.name, result: 'pass' });
      continue;
    }
    const parsed = parseJsonStdout<GateOut>(run.result.stdout);
    const out = parsed.ok && typeof parsed.value.reason === 'string' ? parsed.value : undefined;
    const reason =
      out?.reason ??
      (cls === 'error'
        ? `gate '${run.name}' errored (exit ${run.result.exitCode ?? 'signal'})`
        : `gate '${run.name}' failed`);
    results.push({
      name: run.name,
      result: 'fail',
      reason,
      ...(out?.hint != null ? { hint: out.hint } : {}),
    });
    if (!failure)
      failure = {
        reason,
        ...(out?.hint != null ? { hint: out.hint } : {}),
        gate: out?.gate ?? run.name,
      };
  }
  return failure ? { passed: false, failure, results } : { passed: true, results };
}

// ─── pure: termination predicates (D2 §2.7) ─────────────────────────────────

/** True when the about-to-start iteration number exceeds MAX_ITER (D2 §2.7 #4). Pure. */
export function reachedMaxIter(nextIter: number, maxIter: number): boolean {
  return nextIter > maxIter;
}

/** True when elapsed wall-clock exceeds the profile TIMEOUT (D2 §2.7 #5). Pure. */
export function exceededTimeout(startMs: number, now: number, timeoutSec: number): boolean {
  return now - startMs > timeoutSec * 1000;
}

// ─── driver ──────────────────────────────────────────────────────────────────

/** One runPort call (execPath + stdin → result). The loop builds strategies over it. */
export type PortRunner = (
  plugin: DiscoveredPlugin,
  stdin: unknown,
  opts?: { timeoutSec?: number },
) => Promise<RunPortResult>;

/** Sink for one plugin's captured stderr during an iteration (D1 §3.3). */
type DiagnosticCollector = (port: string, plugin: string, result: RunPortResult) => void;

/**
 * A timed-out run (`result.timedOut`) is force-terminated: the child may leave no
 * stderr at all, which previously vanished without a trace (#48). This synthesizes
 * a diagnostic line so the operator sees *why* the phase produced nothing, distinct
 * from `aborted` (cooperative shutdown, ADR-0022) which is deliberately not
 * annotated here — that is expected noise, not a fault. Pure.
 */
function timeoutDiagnosticLine(durationMs: number): string {
  return `timeout after ${Math.round(durationMs / 1000)}s`;
}

/** Discovered plugins by port (single-port lists carry only their order-first entry). */
export interface LoopPorts {
  taskSource: readonly DiscoveredPlugin[];
  context: readonly DiscoveredPlugin[];
  executor: readonly DiscoveredPlugin[];
  gate: readonly DiscoveredPlugin[];
  sink: readonly DiscoveredPlugin[];
  onFail: readonly DiscoveredPlugin[];
}

/** Runtime knobs the loop reads (subset of the resolved HaloConfig + loop tunables). */
export interface LoopConfig {
  autonomy: MinAutonomy;
  maxIter: number;
  timeoutSec: number;
  profileName?: string;
  retryThreshold?: number;
  contextTokenLimit?: number;
  maxTurns?: number;
  /** 1 実行あたりの USD 上限 (ADR-0021)。executor.in.budget.max_budget_usd へパススルー。 */
  maxBudgetUsd?: number;
  executorTimeoutSec?: number;
  /** Seconds added to the executor budget to derive its process-level wall (D2 §3.3, M2). */
  executorTimeoutGraceSec?: number;
  /**
   * `.harness.yml` `protectedPaths` (ADR-0004), passed through to every gate via
   * `gate.in.protected_paths` so the audit gate can protect repo-declared paths.
   */
  protectedPaths?: readonly string[];
}

/** Everything the driver needs; all side effects are injected (D2 §2 委譲). */
export interface LoopDeps {
  config: LoopConfig;
  ports: LoopPorts;
  runner: PortRunner;
  logger: Logger;
  /** Monotonic-ish clock in ms; injected so TIMEOUT / log timestamps are testable. */
  now: () => number;
  /** PreflightLight STOP check (D2 §4.1 #1). */
  isStopPresent: () => boolean | Promise<boolean>;
  /** PreflightLight budget check — true = may run (D2 §4.1 #3). */
  isBudgetOk: () => boolean | Promise<boolean>;
  /** PreflightHeavy (D2 §4.2); omitted → always proceeds (Phase 1 stub). */
  preflightHeavy?: (task: TaskSourceOut) => HeavyDecision | Promise<HeavyDecision>;
  /**
   * Resolve this task's `kind` to its `.harness.yml` prompt template (D2 §7.2).
   * Omitted → no repository instructions are injected (tests / repos predating the
   * wiring). A `needs-human` result escalates this task and the loop continues.
   */
  kindPrompt?: (task: TaskSourceOut) => KindPrompt | Promise<KindPrompt>;
  /** Create the disposable worktree, returning its absolute path (D2 §8.2). */
  createWorktree: (task: TaskSourceOut) => string | Promise<string>;
  /** Remove the worktree (`git worktree remove --force`), always in a finally (D2 §8.3). */
  removeWorktree: (workdir: string) => void | Promise<void>;
  /** Changed files for the gate input; defaults to `[]`. */
  changedFiles?: (workdir: string) => string[] | Promise<string[]>;
  /**
   * Worktree base commit for the gate input `base` (C2 / D4 §4.2): the HEAD captured
   * at worktree creation, so diff-based gates audit committed + uncommitted changes.
   * Omitted or returning '' → gates fall back to `git diff HEAD`.
   */
  gateBase?: (workdir: string) => string | Promise<string>;
  /**
   * Result reference passed to task-source `op=complete` — a PR URL, or any
   * non-empty delivery reference such as `commit:<sha>` (ADR-0016). Empty string
   * means "nothing delivered": complete is not fired and the task stays queued.
   */
  resolvePrUrl?: (task: TaskSourceOut, workdir: string) => string | Promise<string>;
  estimateTokens?: (text: string) => number;
  /** Hang-detection phase file (`current.json`); omitted → no phase writes. */
  phaseTracker?: PhaseTracker;
  /**
   * Cooperative shutdown requested from outside (ADR-0022, D9 §5). The CLI aborts
   * this on the first SIGINT/SIGTERM. The loop consults it at the iteration
   * boundary and after each long-running port phase, and ends `ABORTED_SIGNAL`
   * without recording a failure. The same signal must also be handed to `runPort`
   * by the wiring, so the in-flight child is torn down rather than awaited.
   */
  abort?: AbortSignal;
}

/** Per-iteration summary returned to the caller (and mirrored into `iter_N.json`). */
export interface IterationSummary {
  iter: number;
  taskId: string | null;
  outcome: Outcome;
  prompt?: string;
  executorStatus?: ExecOutcome;
  gateFailure?: LastFailure;
  retryCount: number;
}

export interface LoopResult {
  endReason: LoopEndReason;
  iterations: IterationSummary[];
  /** Human-readable detail for a non-clean end (TASK_SOURCE_ERROR / ABORTED_ENV); the caller logs it. */
  endDetail?: string;
}

interface TaskState {
  retryCount: number;
  lastFailure?: LastFailure;
}

/**
 * Drive the core loop until one of the five terminal conditions (D2 §2.7). Each
 * iteration: PreflightLight → Next → PreflightHeavy → Context(merge) → BuildPrompt
 * → Execute → Gate(AND) → Sink+Complete | OnFail+retry-reinjection. The single
 * per-task memory is the retry reason (D2 §2.4); everything else is fresh context.
 */
export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  const cfg = deps.config;
  const retryThreshold = cfg.retryThreshold ?? LOOP_DEFAULTS.retryThreshold;
  const tokenLimit = cfg.contextTokenLimit ?? LOOP_DEFAULTS.contextTokenLimit;
  const maxTurns = cfg.maxTurns ?? LOOP_DEFAULTS.maxTurns;
  const execTimeout = cfg.executorTimeoutSec ?? LOOP_DEFAULTS.executorTimeoutSec;
  const execGrace = cfg.executorTimeoutGraceSec ?? LOOP_DEFAULTS.executorTimeoutGraceSec;
  const estimate = deps.estimateTokens ?? estimateTokensDefault;
  const profile = cfg.profileName ?? 'default';

  if (deps.ports.taskSource.length === 0)
    throw new LoopError("no enabled plugin for single port 'task-source'");
  if (deps.ports.executor.length === 0)
    throw new LoopError("no enabled plugin for single port 'executor'");

  const startMs = deps.now();
  const iterations: IterationSummary[] = [];
  const taskStates = new Map<string, TaskState>();
  let iter = 0;
  // ADR-0021 決定(2): この launch で executor が報告した cost.usd の累計。
  // `max_budget_usd` は契約上「任意」フィールドなので、ランタイムがそれを無視しても
  // ここが最後の砦になる。イテレーション数はコストの代理指標にならない。
  let accumulatedCostUsd = 0;

  // Phase boundary marker for hang detection (`current.json`). Guarded so an
  // injected tracker that throws still cannot abort the loop (best-effort like sinks).
  const markPhase = async (taskId: string | null, phase: LoopPhase): Promise<void> => {
    try {
      await deps.phaseTracker?.set(iter, taskId, phase);
    } catch {
      /* best-effort */
    }
  };

  const finish = async (endReason: LoopEndReason, endDetail?: string): Promise<LoopResult> => {
    await markPhase(null, 'idle');
    return endDetail != null ? { endReason, iterations, endDetail } : { endReason, iterations };
  };

  /** Cooperative shutdown requested (ADR-0022). Cheap enough to poll at every phase edge. */
  const aborted = (): boolean => deps.abort?.aborted === true;

  /**
   * End the run because a signal interrupted this iteration (ADR-0022, D9 §5.3).
   * Deliberately does **not** run on-fail, does **not** send `op=fail`, and leaves
   * `retryCount` untouched: an operator stopping the harness is not a task failure,
   * and counting it as one would escalate healthy work to `needs-human` after a few
   * routine stops. The task stays wherever the task-source left it and is
   * re-supplied next run. The caller returns this from inside the worktree `try`,
   * so the `finally` still removes the worktree.
   */
  const abortIteration = async (
    task: TaskSourceOut,
    taskId: string,
    startedAt: string,
    state: TaskState,
    diagnostics: PluginDiagnostic[],
  ): Promise<LoopResult> => {
    await record(deps, {
      iter,
      startedAt,
      profile,
      task,
      outcome: 'aborted_signal',
      retryCount: state.retryCount,
      diagnostics,
    });
    iterations.push({ iter, taskId, outcome: 'aborted_signal', retryCount: state.retryCount });
    return finish('ABORTED_SIGNAL');
  };

  for (;;) {
    // Shutdown wins over every other terminal check: once a signal has been seen,
    // starting another iteration would only produce work we are about to discard.
    if (aborted()) return finish('ABORTED_SIGNAL');
    // Terminal checks at the iteration boundary (D2 §2.7 #4, #5).
    if (exceededTimeout(startMs, deps.now(), cfg.timeoutSec)) return finish('TIMEOUT');
    iter += 1;
    if (reachedMaxIter(iter, cfg.maxIter)) return finish('MAX_ITER');

    // PreflightLight (D2 §4.1): STOP then budget (lock is a startup-only concern).
    if (await deps.isStopPresent()) return finish('STOP');
    if (!(await deps.isBudgetOk())) return finish('BUDGET_EXCEEDED');
    // ADR-0021: 累積コストがこの launch のドル上限に達したら、イテレーション境界で
    // 正当な非実行として終了する (exit 0)。日次の DAILY_MAX_COST_USD とはスコープが
    // 違う (あちらは暦日、こちらは 1 launch) ので、互いの代替にはならない。
    if (cfg.maxBudgetUsd !== undefined && accumulatedCostUsd >= cfg.maxBudgetUsd)
      return finish(
        'BUDGET_EXCEEDED',
        `accumulated executor cost ${accumulatedCostUsd.toFixed(4)} USD >= max_budget_usd ${cfg.maxBudgetUsd}`,
      );

    // Plugin stderr captured during this iteration (D1 §3.3, D2 §3.4). Sinks and
    // on-fail plugins are best-effort — without this their failures leave no trace
    // anywhere, which is precisely what an unattended run cannot afford. Created
    // ahead of Next (below) so a silent `op=next`/`op=complete` timeout on the
    // task-source port is captured too (#48), not just gate/executor/sink/on-fail.
    const diagnostics: PluginDiagnostic[] = [];
    const collect: DiagnosticCollector = (port, plugin, result) => {
      const text = result.stderr.trim();
      if (result.timedOut) {
        const line = timeoutDiagnosticLine(result.durationMs);
        diagnostics.push({ port, plugin, stderr: text === '' ? line : `${text} (${line})` });
        return;
      }
      if (text !== '') diagnostics.push({ port, plugin, stderr: text });
    };

    // Next (single strategy, D2 §3.6): the ready check of §4.1 #4. A broken
    // task-source (non-pass exit / garbage stdout / spawn failure) is a distinct
    // terminal condition from a healthy idle `NO_TASK` (M4) — end loudly, not clean.
    await markPhase(null, 'next');
    const next = await runTaskSourceNext(deps, collect);
    if (next.kind === 'error') return finish('TASK_SOURCE_ERROR', next.reason);
    if (next.kind === 'none') return finish('NO_TASK');
    const task = next.task;
    const taskId = task.task_id!;
    const state = taskStates.get(taskId) ?? { retryCount: 0 };

    const startedAt = new Date(deps.now()).toISOString();

    // PreflightHeavy (D2 §4.2): a failure here (dirty worktree, low disk, stale
    // graph) is a *global* environment fault, not a fault of this task — running on
    // through every ready task would mislabel them all as `escalated`. Record this
    // iteration as `aborted_env` and end the loop (M3), like a light-stage stop.
    await markPhase(taskId, 'preflight_heavy');
    const heavy = deps.preflightHeavy
      ? await deps.preflightHeavy(task)
      : ({ proceed: true } as HeavyDecision);
    if (!heavy.proceed) {
      await record(deps, {
        iter,
        startedAt,
        profile,
        task,
        outcome: 'aborted_env',
        retryCount: state.retryCount,
        diagnostics,
      });
      iterations.push({ iter, taskId, outcome: 'aborted_env', retryCount: state.retryCount });
      return finish('ABORTED_ENV', `preflight: ${heavy.reason}`);
    }

    // Kind resolution (D2 §7.2): the committed `.harness.yml` decides which prompt
    // template this task runs under. Unlike PreflightHeavy this is a *task-level*
    // misconfiguration — an undeclared kind or unreadable template affects only this
    // task, so it escalates to a human and the loop moves on. Retrying cannot fix a
    // declaration error, so it escalates immediately rather than burning the retry
    // threshold. Resolved before the worktree exists: no point paying for one.
    let instructions: string | undefined;
    let kindExecutorName: string | undefined;
    if (deps.kindPrompt) {
      const resolved = await deps.kindPrompt(task);
      if (resolved.status === 'needs-human') {
        state.retryCount += 1;
        taskStates.set(taskId, state);
        await markPhase(taskId, 'on_fail');
        await runBestEffort(
          deps.ports.onFail,
          deps.runner,
          onFailInput(taskId, resolved.reason, state.retryCount),
          (plugin, result) => collect('on-fail', plugin, result),
        );
        await runTaskSourceFail(deps, taskId, resolved.reason, state.retryCount, collect);
        await record(deps, {
          iter,
          startedAt,
          profile,
          task,
          outcome: 'escalated',
          retryCount: state.retryCount,
          diagnostics,
        });
        iterations.push({
          iter,
          taskId,
          outcome: 'escalated',
          gateFailure: { reason: resolved.reason },
          retryCount: state.retryCount,
        });
        continue;
      }
      instructions = resolved.instructions;
      kindExecutorName = resolved.executor;
    }

    // Executor selection (D1 §1.8 kind.executor, issue #51): an explicit but
    // unenabled name is a task-level misconfiguration like an undeclared kind
    // above — it escalates to a human rather than silently falling back to the
    // first enabled executor. Resolved before the worktree exists, same reasoning
    // as kind resolution.
    const selection = selectExecutor(deps.ports.executor, kindExecutorName);
    if (selection.status === 'needs-human') {
      state.retryCount += 1;
      taskStates.set(taskId, state);
      await markPhase(taskId, 'on_fail');
      await runBestEffort(
        deps.ports.onFail,
        deps.runner,
        onFailInput(taskId, selection.reason, state.retryCount),
        (plugin, result) => collect('on-fail', plugin, result),
      );
      await runTaskSourceFail(deps, taskId, selection.reason, state.retryCount, collect);
      await record(deps, {
        iter,
        startedAt,
        profile,
        task,
        outcome: 'escalated',
        retryCount: state.retryCount,
        diagnostics,
      });
      iterations.push({
        iter,
        taskId,
        outcome: 'escalated',
        gateFailure: { reason: selection.reason },
        retryCount: state.retryCount,
      });
      continue;
    }
    const executor = selection.executor;
    const execProcessTimeout = execProcessTimeoutFor(executor, execTimeout, execGrace);

    const workdir = await deps.createWorktree(task);
    try {
      // Context (merge strategy, D2 §2.6 / §3.6).
      await markPhase(taskId, 'context');
      const ctxOuts = await runContext(deps, task, collect);
      const fragments = mergeFragments(ctxOuts, tokenLimit, estimate);

      // BuildPrompt with the previous failure re-injected (D2 §2.4).
      const prompt = buildPrompt(task, fragments, state.lastFailure, instructions);

      // Execute (single strategy). Classify by stdout status (D2 §2.3). A spawn
      // failure (RunPortError: ENOENT etc.) must not escape and crash the loop —
      // fold it to the safe side (`error` → failure path), D1 §3.1 (H1).
      const execIn: ExecutorIn = {
        prompt,
        workdir,
        budget: {
          max_turns: maxTurns,
          timeout_sec: execTimeout,
          // ADR-0021: 設定時のみ付与 (契約上は任意フィールド、MINOR)。
          ...(cfg.maxBudgetUsd !== undefined ? { max_budget_usd: cfg.maxBudgetUsd } : {}),
        },
      };
      await markPhase(taskId, 'execute');
      let exec: ExecClassification;
      try {
        const execResult = await deps.runner(executor, execIn, { timeoutSec: execProcessTimeout });
        collect('executor', executor.name, execResult);
        exec = classifyExecutor(execResult);
      } catch {
        exec = { outcome: 'error' };
      }
      // 失敗した実行でも課金は発生しているので、status を問わず加算する (ADR-0021)。
      accumulatedCostUsd += Math.max(0, readCostUsd(exec.out?.cost) ?? 0);

      // ADR-0022: シグナルで executor を落とした場合、その `error` は「タスクが悪い」
      // ではなく「人がハーネスを止めた」。ここで抜けないと下の失敗経路に落ちて
      // retry_count++ と op=fail が走り、健全なタスクが needs-human へ押し出される。
      if (aborted()) return await abortIteration(task, taskId, startedAt, state, diagnostics);

      if (exec.outcome !== 'done') {
        // Executor failure path (stuck / timeout / crash) → OnFail, retry (D2 §2.3).
        // Retain the reason so the next attempt's prompt sees why it failed (L2).
        const execReason = executorFailureReason(exec);
        state.retryCount += 1;
        state.lastFailure = { reason: execReason };
        taskStates.set(taskId, state);
        await markPhase(taskId, 'on_fail');
        await runBestEffort(
          deps.ports.onFail,
          deps.runner,
          onFailInput(taskId, exec.outcome, state.retryCount, { gate: exec.outcome, workdir }),
          (plugin, result) => collect('on-fail', plugin, result),
        );
        // Report to the task-source so it records the failure and escalates at its
        // threshold (needs-human) — the infinite-loop breaker (要件 §4.2① / §11.2).
        await runTaskSourceFail(deps, taskId, execReason, state.retryCount, collect);
        const outcome = outcomeForFailure(state.retryCount, retryThreshold);
        // ADR-0025: below the retry threshold the task is released back to ready
        // (unclaimed) rather than left claimed. On escalation `fail` already owns
        // the terminal state (needs-human) — release is not called.
        if (outcome === 'failed') await runTaskSourceRelease(deps, taskId, execReason, collect);
        await record(deps, {
          iter,
          startedAt,
          profile,
          task,
          outcome,
          executor: toExecutorRecord(exec),
          retryCount: state.retryCount,
          diagnostics,
        });
        iterations.push({
          iter,
          taskId,
          outcome,
          prompt,
          executorStatus: exec.outcome,
          retryCount: state.retryCount,
        });
        continue;
      }

      // Gate (logical-AND strategy, D2 §3.6).
      await markPhase(taskId, 'gate');
      const changed = deps.changedFiles ? await deps.changedFiles(workdir) : [];
      const gateBase = deps.gateBase ? await deps.gateBase(workdir) : '';
      const gateIn: GateIn = {
        task_id: taskId,
        workdir,
        changed_files: changed,
        ...(gateBase !== '' ? { base: gateBase } : {}),
        // ADR-0004: 保護対象の追加宣言は core (リポジトリルートの .harness.yml) 由来。
        // worktree 内の複製を書き換えても、gate が従うリストは弱められない。
        ...(cfg.protectedPaths && cfg.protectedPaths.length > 0
          ? { protected_paths: [...cfg.protectedPaths] }
          : {}),
      };
      const gateRuns = await runGates(deps, gateIn, collect);
      // A gate whose child we just killed exits non-zero and would fail the
      // logical-AND — the same false failure the executor check above avoids.
      if (aborted()) return await abortIteration(task, taskId, startedAt, state, diagnostics);
      const verdict = evaluateGates(gateRuns);

      if (verdict.passed) {
        // Sink (best-effort, autonomy-filtered, D2 §2.5 / §3.6) then Complete.
        await markPhase(taskId, 'sink');
        await runSinks(
          deps,
          { task_id: taskId, workdir, summary: exec.out?.summary ?? '' },
          collect,
        );
        // Only report completion when a delivery reference was actually produced
        // (D1 §1.5, ADR-0016): a PR URL, or `commit:<sha>` from a local commit sink.
        // '' means nothing durable was delivered — this is not force-completed, but
        // (ADR-0025 H1) the claim must still be released: otherwise the task stays
        // claimed until the task-source's own stale-claim recovery kicks in (default
        // 3600s), which effectively blocks it from being retried in the meantime.
        const prUrl = deps.resolvePrUrl ? await deps.resolvePrUrl(task, workdir) : '';
        if (prUrl !== '') {
          await runTaskSourceComplete(deps, taskId, prUrl, collect);
        } else {
          await runTaskSourceRelease(
            deps,
            taskId,
            'gate passed but no delivery reference produced',
            collect,
          );
        }
        taskStates.delete(taskId);
        await record(deps, {
          iter,
          startedAt,
          profile,
          task,
          outcome: 'passed',
          executor: toExecutorRecord(exec),
          gates: verdict.results,
          retryCount: state.retryCount,
          diagnostics,
        });
        iterations.push({
          iter,
          taskId,
          outcome: 'passed',
          prompt,
          executorStatus: 'done',
          retryCount: state.retryCount,
        });
      } else {
        // Gate fail → OnFail (best-effort) + retain reason for re-injection (D2 §2.4).
        const failure = verdict.failure!;
        state.retryCount += 1;
        state.lastFailure = failure;
        taskStates.set(taskId, state);
        await markPhase(taskId, 'on_fail');
        await runBestEffort(
          deps.ports.onFail,
          deps.runner,
          onFailInput(taskId, failure.reason, state.retryCount, { gate: failure.gate, workdir }),
          (plugin, result) => collect('on-fail', plugin, result),
        );
        // Report to the task-source so it records the failure and escalates at its
        // threshold (needs-human) — the infinite-loop breaker (要件 §4.2① / §11.2).
        await runTaskSourceFail(deps, taskId, failure.reason, state.retryCount, collect);
        const outcome = outcomeForFailure(state.retryCount, retryThreshold);
        // ADR-0025: below the retry threshold the task is released back to ready
        // (unclaimed) rather than left claimed. On escalation `fail` already owns
        // the terminal state (needs-human) — release is not called.
        if (outcome === 'failed') await runTaskSourceRelease(deps, taskId, failure.reason, collect);
        await record(deps, {
          iter,
          startedAt,
          profile,
          task,
          outcome,
          executor: toExecutorRecord(exec),
          gates: verdict.results,
          retryCount: state.retryCount,
          diagnostics,
        });
        iterations.push({
          iter,
          taskId,
          outcome,
          prompt,
          executorStatus: 'done',
          gateFailure: failure,
          retryCount: state.retryCount,
        });
      }
    } finally {
      await deps.removeWorktree(workdir);
    }
  }
}

// --- port strategy helpers (D2 §3.6) ----------------------------------------

/** Outcome of one task-source `op=next` (M4): a task, a healthy idle, or a fault. */
type NextResult =
  { kind: 'task'; task: TaskSourceOut } | { kind: 'none' } | { kind: 'error'; reason: string };

async function runTaskSourceNext(
  deps: LoopDeps,
  collect: DiagnosticCollector,
): Promise<NextResult> {
  const ts = deps.ports.taskSource[0]!;
  let res: RunPortResult;
  try {
    res = await deps.runner(ts, { op: 'next' }, portOpts(ts));
  } catch (err) {
    // A spawn failure is a broken task-source, NOT an idle queue (M4).
    return { kind: 'error', reason: `task-source spawn failed: ${errText(err)}` };
  }
  collect('task-source', ts.name, res);
  // A non-pass exit or unparseable stdout is a fault, distinct from a valid
  // `{task_id:null}` idle — end with TASK_SOURCE_ERROR rather than silent NO_TASK.
  // The adapter's stderr rides along: on a broken task source it is the only
  // human-readable clue that reaches the operator (D1 §3.3), and the NO_TASK path
  // writes no iteration log at all.
  if (classifyExit(res) !== 'pass')
    return {
      kind: 'error',
      reason: `task-source exited non-pass (exit ${res.exitCode ?? 'signal'})${stderrTail(res.stderr)}`,
    };
  const parsed = parseJsonStdout<TaskSourceOut>(res.stdout);
  if (!parsed.ok)
    return {
      kind: 'error',
      reason: `task-source stdout invalid: ${parsed.error}${stderrTail(res.stderr)}`,
    };
  if (parsed.value.task_id == null) return { kind: 'none' };
  return { kind: 'task', task: parsed.value };
}

async function runTaskSourceComplete(
  deps: LoopDeps,
  taskId: string,
  prUrl: string,
  collect: DiagnosticCollector,
): Promise<void> {
  const ts = deps.ports.taskSource[0]!;
  try {
    const res = await deps.runner(
      ts,
      { op: 'complete', task_id: taskId, pr_url: prUrl },
      portOpts(ts),
    );
    collect('task-source', ts.name, res);
  } catch {
    /* best-effort: a complete failure must not crash the loop */
  }
}

/**
 * Report a failed iteration to the task-source (D1 §1.1 op=fail). The task-source is
 * the source of truth for retry accounting: it records the failure and, on reaching
 * its threshold, escalates (needs-human label / needs-human/ move) to break the
 * infinite-retry loop (要件 §4.2① / §11.2). Best-effort — a fail-report failure must
 * not crash the loop, mirroring runTaskSourceComplete.
 */
async function runTaskSourceFail(
  deps: LoopDeps,
  taskId: string,
  reason: string,
  retryCount: number,
  collect: DiagnosticCollector,
): Promise<void> {
  const ts = deps.ports.taskSource[0]!;
  try {
    const res = await deps.runner(
      ts,
      { op: 'fail', task_id: taskId, reason, retry_count: retryCount },
      portOpts(ts),
    );
    collect('task-source', ts.name, res);
  } catch {
    /* best-effort: a fail-report failure must not crash the loop */
  }
}

/**
 * Release a claimed task back to ready (D1 §1.1 op=release, ADR-0025). Called at
 * the tail of the failure path once `op=fail` has recorded the attempt, but only
 * when the retry threshold has not been reached — escalation already leaves the
 * task-source's own terminal state (needs-human) in place, so release is skipped
 * there. Best-effort, mirroring runTaskSourceComplete/runTaskSourceFail: a
 * task-source implementation that predates this op exits non-zero, and that
 * failure is swallowed as a migration accommodation (ADR-0025 Consequences).
 */
async function runTaskSourceRelease(
  deps: LoopDeps,
  taskId: string,
  reason: string,
  collect: DiagnosticCollector,
): Promise<void> {
  const ts = deps.ports.taskSource[0]!;
  try {
    const res = await deps.runner(ts, { op: 'release', task_id: taskId, reason }, portOpts(ts));
    collect('task-source', ts.name, res);
  } catch {
    /* best-effort: a release failure must not crash the loop */
  }
}

async function runContext(
  deps: LoopDeps,
  task: TaskSourceOut,
  collect: DiagnosticCollector,
): Promise<ContextOut[]> {
  const outs: ContextOut[] = [];
  for (const plugin of deps.ports.context) {
    try {
      const res = await deps.runner(plugin, task, portOpts(plugin));
      collect('context', plugin.name, res);
      const parsed = parseJsonStdout<ContextOut>(res.stdout);
      if (parsed.ok && Array.isArray(parsed.value.fragments)) outs.push(parsed.value);
    } catch {
      /* individual context failure → skip this plugin, others continue (D2 §2.6) */
    }
  }
  return outs;
}

async function runGates(
  deps: LoopDeps,
  gateIn: GateIn,
  collect: DiagnosticCollector,
): Promise<GateRun[]> {
  const runs: GateRun[] = [];
  for (const plugin of deps.ports.gate) {
    // A gate spawn failure must not escape and crash the loop — fold it to a
    // safe-side failing GateRun so the logical-AND fails closed (H1, D2 §3.1).
    try {
      const result = await deps.runner(plugin, gateIn, portOpts(plugin));
      collect('gate', plugin.name, result);
      runs.push({ name: plugin.name, result });
    } catch (err) {
      runs.push({
        name: plugin.name,
        result: spawnFailureResult(`gate '${plugin.name}' failed to run: ${errText(err)}`),
      });
    }
  }
  return runs;
}

async function runSinks(
  deps: LoopDeps,
  sinkIn: SinkIn,
  collect: DiagnosticCollector,
): Promise<void> {
  const enabled = deps.ports.sink.filter((s) =>
    shouldRunSink(s.manifest.minAutonomy, deps.config.autonomy),
  );
  await runBestEffort(enabled, deps.runner, sinkIn, (plugin, result) =>
    collect('sink', plugin, result),
  );
}

async function runBestEffort(
  plugins: readonly DiscoveredPlugin[],
  runner: PortRunner,
  stdin: unknown,
  onResult?: (plugin: string, result: RunPortResult) => void,
): Promise<void> {
  for (const plugin of plugins) {
    try {
      const result = await runner(plugin, stdin, portOpts(plugin));
      onResult?.(plugin.name, result);
    } catch {
      /* best-effort: one plugin's failure must not affect the others (D2 §3.6) */
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Trailing slice of a plugin's stderr, appended to a failure reason. stderr carries no
 * contractual meaning (D1 §3.3) but it is the diagnostic channel, so a fault reason
 * that drops it leaves the operator with an exit code and nothing else. Pure.
 */
function stderrTail(stderr: string, maxChars = 400): string {
  const text = stderr.trim();
  if (text === '') return '';
  return `: ${text.length > maxChars ? `…${text.slice(-maxChars)}` : text}`;
}

/** Runner opts carrying the plugin's manifest `timeoutSec` when set (M1). Pure. */
function portOpts(plugin: DiscoveredPlugin): { timeoutSec?: number } {
  return plugin.manifest.timeoutSec != null ? { timeoutSec: plugin.manifest.timeoutSec } : {};
}

/**
 * Synthesize a {@link RunPortResult} for a spawn failure, carrying the reason as a
 * `GateOut`-shaped stdout with a non-pass exit so {@link classifyExit} folds it to
 * `error` and {@link evaluateGates} surfaces the reason (H1). Pure.
 */
function spawnFailureResult(reason: string): RunPortResult {
  return {
    exitCode: null,
    signal: null,
    stdout: JSON.stringify({ reason }),
    stderr: '',
    timedOut: false,
    aborted: false,
    durationMs: 0,
  };
}

// --- log + shape helpers ----------------------------------------------------

function onFailInput(
  taskId: string,
  reason: string,
  retryCount: number,
  extra?: { gate?: string | undefined; workdir?: string | undefined },
): OnFailIn {
  return {
    task_id: taskId,
    reason,
    retry_count: retryCount,
    ...(extra?.gate != null ? { gate: extra.gate } : {}),
    ...(extra?.workdir != null ? { workdir: extra.workdir } : {}),
  };
}

function outcomeForFailure(retryCount: number, threshold: number): Outcome {
  return retryCount >= threshold ? 'escalated' : 'failed';
}

/** Re-injectable reason for a non-`done` executor run (L2): status plus any summary. */
function executorFailureReason(exec: ExecClassification): string {
  const summary = exec.out?.summary;
  return summary ? `executor ${exec.outcome}: ${summary}` : `executor ${exec.outcome}`;
}

/**
 * Read the dollar amount out of an executor's optional `cost` object (D1 §1.3).
 * Accepts both `usd_estimate` (what the bundled adapter emits) and `usd` (the shape
 * D1's example uses). Returns undefined when nothing usable was reported — a
 * non-reporting executor degrades to count/time budgets, as ADR-0021 accepts. Pure.
 */
function readCostUsd(cost: unknown): number | undefined {
  if (cost === undefined || cost === null || typeof cost !== 'object') return undefined;
  const record = cost as Record<string, unknown>;
  const raw = record['usd_estimate'] ?? record['usd'];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function toExecutorRecord(exec: ExecClassification): ExecutorRecord {
  const status = exec.outcome === 'error' ? undefined : exec.outcome;
  const usd = readCostUsd(exec.out?.cost);
  return {
    ...(status != null ? { status } : {}),
    ...(usd != null ? { cost: { usdEstimate: usd } } : {}),
  };
}

interface RecordArgs {
  iter: number;
  startedAt: string;
  profile: string;
  task: TaskSourceOut;
  outcome: Outcome;
  executor?: ExecutorRecord;
  gates?: GateResult[];
  retryCount?: number;
  diagnostics?: PluginDiagnostic[];
}

async function record(deps: LoopDeps, args: RecordArgs): Promise<void> {
  const input: IterationInput = {
    iter: args.iter,
    startedAt: args.startedAt,
    endedAt: new Date(deps.now()).toISOString(),
    profile: args.profile,
    autonomy: deps.config.autonomy,
    task: {
      taskId: args.task.task_id,
      ...(args.task.kind != null ? { kind: args.task.kind } : {}),
      ...(args.task.title != null ? { title: args.task.title } : {}),
      ...(args.retryCount != null ? { retryCount: args.retryCount } : {}),
    },
    ...(args.executor ? { executor: args.executor } : {}),
    ...(args.gates ? { gates: args.gates } : {}),
    ...(args.diagnostics && args.diagnostics.length > 0 ? { diagnostics: args.diagnostics } : {}),
    outcome: args.outcome,
  };
  await deps.logger.writeIteration(input);
}
