// logger — structured iteration log (`iter_N.json`) formatting, stderr redaction,
// and gate pass-rate computation (D2 §1.1 #9, D8 §1.2 #9, obs schema 06 §6.2).
//
// The formatting logic is pure so it is unit-testable without touching the
// filesystem (D2 §1.2 zero-global-state, D8 §1.1). The only side-effecting piece
// is `createLogger`, whose fs + clock dependencies are injected — no singletons,
// no module-level mutable state.

import type { MinAutonomy } from '@halo/contracts';

/** Result of a single gate execution (subset of obs schema 06 §6.2 `gates[]`). */
export interface GateResult {
  name: string;
  result: 'pass' | 'fail' | 'skipped';
  reason?: string | null;
  hint?: string | null;
  durationSec?: number;
}

/** Executor cost accounting (obs schema `executor.cost`). */
export interface ExecutorCost {
  inputTokens?: number;
  outputTokens?: number;
  usdEstimate?: number | null;
}

/** Executor result block (obs schema `executor`). */
export interface ExecutorRecord {
  status?: 'done' | 'stuck' | 'timeout';
  turnsUsed?: number;
  durationSec?: number;
  cost?: ExecutorCost;
}

/** Task block (obs schema `task`). */
export interface TaskRecord {
  taskId: string | null;
  kind?: string;
  title?: string;
  runtimes?: string[];
  retryCount?: number;
}

export type Outcome = 'passed' | 'failed' | 'escalated' | 'no_task' | 'stopped';

/** Structured input the loop hands to the logger for one iteration. */
export interface IterationInput {
  iter: number;
  startedAt: string;
  endedAt: string;
  profile: string;
  autonomy: MinAutonomy;
  trigger?: 'schedule' | 'polling' | 'manual';
  task?: Partial<TaskRecord>;
  executor?: ExecutorRecord;
  gates?: GateResult[];
  outcome: Outcome;
}

/** The serialisable `iter_N.json` document (obs schema 06 §6.2). */
export interface IterationLog {
  iter: number;
  started_at: string;
  ended_at: string;
  profile: string;
  autonomy: MinAutonomy;
  trigger?: 'schedule' | 'polling' | 'manual';
  task: { task_id: string | null; kind: string; title?: string; runtimes?: string[]; retry_count?: number };
  executor?: {
    status?: 'done' | 'stuck' | 'timeout';
    turns_used?: number;
    duration_sec?: number;
    cost?: { input_tokens?: number; output_tokens?: number; usd_estimate?: number | null };
  };
  gates: Array<{
    name: string;
    result: 'pass' | 'fail' | 'skipped';
    reason?: string | null;
    hint?: string | null;
    duration_sec?: number;
  }>;
  gate_pass_rate: number | null;
  outcome: Outcome;
}

/**
 * Adjustable defaults (要件 §11.2 / D2 principle). Not hardcoded into loop logic
 * — the caller may override every one.
 */
export const LOGGER_DEFAULTS = {
  /** kind label used when a task omits it (D1 §1.8 default `code`). */
  defaultKind: 'code',
  /**
   * Regexes whose matches are replaced by `redactionMask` before any stderr text
   * or reason reaches disk. Covers common credential shapes; extend via options.
   */
  secretPatterns: [
    /ghp_[A-Za-z0-9]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /gho_[A-Za-z0-9]{20,}/g,
    /sk-[A-Za-z0-9]{20,}/g,
    /Bearer\s+\S+/gi,
    /(?:token|authorization)\s*[:=]\s*\S+/gi,
    /(?:GH_TOKEN|GITHUB_TOKEN|API_KEY|SECRET|PASSWORD)\s*=\s*\S+/gi,
  ] as RegExp[],
  redactionMask: '***REDACTED***',
} as const;

export interface RedactionOptions {
  secretPatterns?: RegExp[];
  redactionMask?: string;
}

/**
 * Replace anything matching a secret pattern with the mask. Pure. Used both for
 * captured stderr and for gate `reason` text that is re-injected next iteration,
 * so no credential leaks into `iter_N.json` (D8 §1.2 「機微情報の非混入」).
 */
export function redactSecrets(text: string, options: RedactionOptions = {}): string {
  const patterns = options.secretPatterns ?? LOGGER_DEFAULTS.secretPatterns;
  const mask = options.redactionMask ?? LOGGER_DEFAULTS.redactionMask;
  return patterns.reduce((acc, re) => acc.replace(re, mask), text);
}

/**
 * gate pass rate = pass / (pass + fail); `skipped` gates are excluded from both
 * numerator and denominator (obs schema 06 §6.2 `gate_pass_rate`). Returns `null`
 * when no gate actually ran (denominator 0) so callers can distinguish "no data"
 * from a genuine 0.0.
 */
export function computeGatePassRate(gates: readonly GateResult[]): number | null {
  let pass = 0;
  let counted = 0;
  for (const g of gates) {
    if (g.result === 'pass') {
      pass += 1;
      counted += 1;
    } else if (g.result === 'fail') {
      counted += 1;
    }
  }
  return counted === 0 ? null : pass / counted;
}

export interface FormatOptions extends RedactionOptions {
  defaultKind?: string;
}

/**
 * Build the `iter_N.json` document from loop input. Pure. Fills defaults for
 * omitted fields (task/kind, empty gates) and redacts secrets from any gate
 * `reason`/`hint` so nothing sensitive is persisted (D8 §1.2 欄欠落既定 + 機微非混入).
 */
export function formatIterationLog(input: IterationInput, options: FormatOptions = {}): IterationLog {
  const defaultKind = options.defaultKind ?? LOGGER_DEFAULTS.defaultKind;
  const gates = (input.gates ?? []).map((g) => ({
    name: g.name,
    result: g.result,
    ...(g.reason != null ? { reason: redactSecrets(g.reason, options) } : {}),
    ...(g.hint != null ? { hint: redactSecrets(g.hint, options) } : {}),
    ...(g.durationSec != null ? { duration_sec: g.durationSec } : {}),
  }));

  const task = input.task ?? {};
  const log: IterationLog = {
    iter: input.iter,
    started_at: input.startedAt,
    ended_at: input.endedAt,
    profile: input.profile,
    autonomy: input.autonomy,
    ...(input.trigger ? { trigger: input.trigger } : {}),
    task: {
      task_id: task.taskId ?? null,
      kind: task.kind ?? defaultKind,
      ...(task.title != null ? { title: task.title } : {}),
      ...(task.runtimes != null ? { runtimes: task.runtimes } : {}),
      ...(task.retryCount != null ? { retry_count: task.retryCount } : {}),
    },
    ...(input.executor ? { executor: formatExecutor(input.executor) } : {}),
    gates,
    gate_pass_rate: computeGatePassRate(input.gates ?? []),
    outcome: input.outcome,
  };
  return log;
}

function formatExecutor(e: ExecutorRecord): NonNullable<IterationLog['executor']> {
  return {
    ...(e.status != null ? { status: e.status } : {}),
    ...(e.turnsUsed != null ? { turns_used: e.turnsUsed } : {}),
    ...(e.durationSec != null ? { duration_sec: e.durationSec } : {}),
    ...(e.cost
      ? {
          cost: {
            ...(e.cost.inputTokens != null ? { input_tokens: e.cost.inputTokens } : {}),
            ...(e.cost.outputTokens != null ? { output_tokens: e.cost.outputTokens } : {}),
            ...(e.cost.usdEstimate !== undefined ? { usd_estimate: e.cost.usdEstimate } : {}),
          },
        }
      : {}),
  };
}

/**
 * Relative log path for iteration N (obs schema stores flat `logs/iter_N.json`,
 * 06 §6.2 / 要件 §8.2). Pure so tests need no fs. `baseDir` is the `.halo/logs`
 * directory the caller resolved from config.
 */
export function buildLogPath(baseDir: string, iter: number): string {
  const sep = baseDir.endsWith('/') ? '' : '/';
  return `${baseDir}${sep}iter_${iter}.json`;
}

/** Injected filesystem seam (subset of node:fs/promises) so the logger stays pure at its core. */
export interface LoggerFs {
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
}

export interface LoggerOptions extends FormatOptions {
  /** `.halo/logs` directory. */
  logDir: string;
  fs: LoggerFs;
}

export interface Logger {
  /** Format + persist one iteration; returns the written path and document. */
  writeIteration(input: IterationInput): Promise<{ path: string; log: IterationLog }>;
}

/**
 * Construct a logger bound to a log directory and an fs seam. Holds no global
 * state (D2 §1.2); every instance is independent so parallel profiles never
 * collide through a shared singleton.
 */
export function createLogger(options: LoggerOptions): Logger {
  const { logDir, fs, ...formatOptions } = options;
  return {
    async writeIteration(input) {
      const log = formatIterationLog(input, formatOptions);
      const path = buildLogPath(logDir, input.iter);
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(path, `${JSON.stringify(log, null, 2)}\n`);
      return { path, log };
    },
  };
}
