// runPort — launch one plugin as a child process and enforce the D1 execution
// contract: a single JSON object on stdin, a single JSON object on stdout,
// judgement by exit code, stderr forwarded to the logger (D2 §1.1 #3, §3; D1 §3).
//
// This module owns exactly "run one process + enforce the contract". Port-level
// strategies (single / merge / logical-AND / best-effort) are assembled by the
// loop from repeated calls (D2 §3.6). No global state: the child_process seam is
// injectable so tests can drive fake processes, while the default uses fixture
// scripts across a real process boundary.

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** Adjustable defaults (要件 §11.2). Not hardcoded into loop logic. */
export const RUN_PORT_DEFAULTS = {
  /** Grace between SIGTERM and SIGKILL when a plugin exceeds its timeout (D2 §3.3). */
  killGraceMs: 5000,
  /** Cap on captured stdout/stderr to bound memory on a runaway plugin. */
  maxBufferBytes: 8 * 1024 * 1024,
} as const;

/** Minimal shape of the spawned child this module relies on. */
export type SpawnedChild = ChildProcessWithoutNullStreams;

/** Injectable spawn seam (defaults to `node:child_process.spawn`, shell: false). */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string>; detached?: boolean },
) => SpawnedChild;

export interface RunPortInput {
  /** Absolute path to the plugin executable. */
  execPath: string;
  /** Extra argv (rarely used; the contract is via stdin). */
  args?: readonly string[];
  /** Working directory for the child. */
  cwd?: string;
  /**
   * Environment for the child. When omitted the child inherits nothing beyond the
   * spawn default; the loop supplies a scrubbed env (要件 §6.1 PATH re-homing).
   */
  env?: Record<string, string>;
  /** The single JSON value written to the child's stdin, then EOF. */
  stdin: unknown;
  /** Hard process timeout in ms (from `timeoutSec`, D2 §3.3). */
  timeoutMs: number;
  /** SIGTERM→SIGKILL grace; defaults to {@link RUN_PORT_DEFAULTS.killGraceMs}. */
  killGraceMs?: number;
  /** Per-line stderr callback for logger forwarding (D2 §3.4). */
  onStderr?: (line: string) => void;
  /** Cap on captured bytes; defaults to {@link RUN_PORT_DEFAULTS.maxBufferBytes}. */
  maxBufferBytes?: number;
  /** Spawn override for tests. */
  spawn?: SpawnFn;
}

export interface RunPortResult {
  /** Process exit code, or `null` if it was killed by a signal. */
  exitCode: number | null;
  /** Terminating signal, or `null` on normal exit. */
  signal: NodeJS.Signals | null;
  /** Full captured stdout (the JSON-only channel, D1 §3.2). */
  stdout: string;
  /** Full captured stderr (diagnostic only, D1 §3.3). */
  stderr: string;
  /** True when the timeout fired and the child was force-terminated. */
  timedOut: boolean;
  /** Wall-clock duration of the run in ms. */
  durationMs: number;
}

/** Thrown when the child process cannot be spawned at all (e.g. ENOENT). */
export class RunPortError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RunPortError';
  }
}

/**
 * Spawn one plugin, write `stdin` as a single JSON object, capture stdout/stderr,
 * forward stderr lines to `onStderr`, and enforce `timeoutMs` at the process
 * level (SIGTERM, then SIGKILL after the grace). Resolves once the child closes;
 * rejects with {@link RunPortError} only when the process fails to start. Never
 * throws on a non-zero exit — mapping to pass/fail/error is the caller's job
 * ({@link classifyExit}, D1 §3.1).
 */
export function runPort(input: RunPortInput): Promise<RunPortResult> {
  const spawn = input.spawn ?? defaultSpawn;
  const killGraceMs = input.killGraceMs ?? RUN_PORT_DEFAULTS.killGraceMs;
  const maxBufferBytes = input.maxBufferBytes ?? RUN_PORT_DEFAULTS.maxBufferBytes;
  const startedAt = Date.now();

  return new Promise<RunPortResult>((resolve, reject) => {
    let child: SpawnedChild;
    try {
      child = spawn(input.execPath, input.args ?? [], {
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        detached: true,
      });
    } catch (err) {
      reject(new RunPortError(`failed to spawn plugin: ${input.execPath}`, err));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stderrLineBuf = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), killGraceMs);
      killTimer.unref?.();
    }, input.timeoutMs);
    timeoutTimer.unref?.();

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < maxBufferBytes) stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < maxBufferBytes) stderr += chunk;
      if (input.onStderr) {
        stderrLineBuf += chunk;
        let nl = stderrLineBuf.indexOf('\n');
        while (nl !== -1) {
          input.onStderr(stderrLineBuf.slice(0, nl));
          stderrLineBuf = stderrLineBuf.slice(nl + 1);
          nl = stderrLineBuf.indexOf('\n');
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new RunPortError(`plugin process error: ${input.execPath}`, err));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (input.onStderr && stderrLineBuf !== '') input.onStderr(stderrLineBuf);
      resolve({
        exitCode: code,
        signal: signal as NodeJS.Signals | null,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    // Write the single JSON object then EOF. A child that closed stdin early
    // (EPIPE) must not crash the run — the exit code still decides the outcome.
    child.stdin.on('error', () => undefined);
    child.stdin.end(serializeStdin(input.stdin));
  });
}

function serializeStdin(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string>; detached?: boolean },
): SpawnedChild {
  return nodeSpawn(command, args as string[], { ...options, shell: false });
}

/** Injectable `process.kill` seam for {@link killProcessTree} (tests / watchdog). */
export type KillFn = (pid: number, signal: NodeJS.Signals) => void;

/**
 * Kill a whole process group by its leader pid (`kill(-pid)`), so grandchildren
 * die with the leader. Returns true when the group signal was delivered; false
 * when the group is already gone (or the pid is not a leader), leaving any
 * fallback to the caller. Shared by runPort's timeout enforcement and the
 * external watchdog (D9 §2.4) so tree-kill semantics live in one place.
 */
export function killProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  kill: KillFn = (p, s) => process.kill(p, s),
): boolean {
  try {
    kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill the child's whole process group when possible (detached spawn makes the
 * child a group leader), falling back to the single process. Without this, a
 * grandchild holding the stdio pipes would keep the run alive past timeoutSec
 * (D2 §3.3 の強制終了はプロセス木全体が対象).
 */
function killTree(child: SpawnedChild, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined && killProcessTree(pid, signal)) return;
  child.kill(signal);
}

// --- pure result interpretation ---------------------------------------------

/** How the loop should treat a finished plugin run (D1 §3.1). */
export type ExitClass = 'pass' | 'fail' | 'error';

/**
 * Map an exit code to pass/fail/error (D1 §3.1): 0 = pass, 2 = fail, everything
 * else (incl. 1, and a timeout/signal kill) = error, which the loop folds into
 * the failure path (安全側に倒す). Pure.
 */
export function classifyExit(result: Pick<RunPortResult, 'exitCode' | 'timedOut'>): ExitClass {
  if (result.timedOut) return 'error';
  if (result.exitCode === 0) return 'pass';
  if (result.exitCode === 2) return 'fail';
  return 'error';
}

export type JsonParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse a plugin's stdout as a single JSON object (D1 §3.2, stdout is a
 * JSON-only channel). Returns a discriminated result rather than throwing so the
 * caller can apply its port's rule (context: skip, gate: safe-side fail, D1 §6.2).
 * Pure.
 */
export function parseJsonStdout<T = unknown>(stdout: string): JsonParseResult<T> {
  const trimmed = stdout.trim();
  if (trimmed === '') return { ok: false, error: 'empty stdout (expected one JSON object)' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `stdout is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'stdout JSON must be an object' };
  }
  return { ok: true, value: parsed as T };
}
