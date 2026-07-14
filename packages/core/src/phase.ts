// phase — hang-detection phase-boundary state (`current.json`). While iter_N.json
// records an iteration only after it ends, current.json is overwritten at every
// phase boundary so an operator can see where a hung loop is stuck with a single
// `cat .halo/logs/current.json` (D6 §6.1 「ファイルが公式インターフェース」).
//
// Same shape as logger.ts: pure formatting + an injected fs/clock seam, no
// module-level state. Writes are best-effort — observability must never be the
// thing that kills the loop it observes.

/** The loop step about to run (D2 §2 の各工程 + terminal `idle`). */
export type LoopPhase =
  'next' | 'preflight_heavy' | 'context' | 'execute' | 'gate' | 'sink' | 'on_fail' | 'idle';

/** The serialisable `current.json` document. Operational file, not part of the contracts schema. */
export interface PhaseState {
  iter: number;
  task_id: string | null;
  phase: LoopPhase;
  updated_at: string;
}

export interface PhaseStateInput {
  iter: number;
  taskId: string | null;
  phase: LoopPhase;
  nowMs: number;
}

/** Build the `current.json` document. Pure. Carries no free-form text, so no redaction path. */
export function formatPhaseState(input: PhaseStateInput): PhaseState {
  return {
    iter: input.iter,
    task_id: input.taskId,
    phase: input.phase,
    updated_at: new Date(input.nowMs).toISOString(),
  };
}

/** Path of the phase file inside the log directory (flat, next to `iter_N.json`). Pure. */
export function buildCurrentPath(baseDir: string): string {
  const sep = baseDir.endsWith('/') ? '' : '/';
  return `${baseDir}${sep}current.json`;
}

/** Injected filesystem seam (same subset as LoggerFs). */
export interface PhaseTrackerFs {
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
}

export interface PhaseTrackerOptions {
  /** `.halo/logs` directory. */
  logDir: string;
  fs: PhaseTrackerFs;
  now: () => number;
}

export interface PhaseTracker {
  /** Overwrite `current.json` with the phase about to run. Never throws (best-effort). */
  set(iter: number, taskId: string | null, phase: LoopPhase): Promise<void>;
}

/**
 * Construct a tracker bound to a log directory. Holds no global state; every
 * instance is independent, mirroring `createLogger`.
 */
export function createPhaseTracker(options: PhaseTrackerOptions): PhaseTracker {
  const { logDir, fs, now } = options;
  const path = buildCurrentPath(logDir);
  return {
    async set(iter, taskId, phase) {
      try {
        const doc = formatPhaseState({ iter, taskId, phase, nowMs: now() });
        await fs.mkdir(logDir, { recursive: true });
        await fs.writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
      } catch {
        // best-effort: a failed observability write must not abort the loop.
      }
    },
  };
}
