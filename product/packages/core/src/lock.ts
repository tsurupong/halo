// lock — single-instance exclusive lock (D2 §1.1 #8, 要件 §4.4). flock-equivalent
// via an atomic O_EXCL create of `$TMPDIR/halo.lock` (or a profile-scoped file so
// distinct profiles never block each other, D2 §1.2). Non-blocking: a second
// launch that finds a live lock exits immediately (preflight maps to exit 0).
//
// The stale-detection + parse/format logic is pure (D2 §1.2, D8 §1.1); only
// acquire/release touch the filesystem, through an injected seam so tests need no
// real files or processes.

/** Contents persisted in the lock file. */
export interface LockInfo {
  pid: number;
  /** ISO-8601 acquisition time. */
  startedAt: string;
  /** Hostname, for cross-host diagnostics (WSL2 / container). */
  host?: string;
}

/** Adjustable defaults (要件 §11.2). Not hardcoded in loop logic. */
export const LOCK_DEFAULTS = {
  lockName: 'halo.lock',
  /** A held lock older than this with a dead owner is considered stale. */
  staleMs: 6 * 60 * 60 * 1000,
} as const;

/**
 * Path to the lock file. Profile-scoped when a profile is given so `continuous`
 * and `nightly` runs are independently serialised (D2 §1.2). Pure.
 */
export function defaultLockPath(tmpdir: string, profile?: string, lockName = LOCK_DEFAULTS.lockName): string {
  const sep = tmpdir.endsWith('/') ? '' : '/';
  const name = profile ? lockName.replace(/\.lock$/, `-${profile}.lock`) : lockName;
  return `${tmpdir}${sep}${name}`;
}

/** Serialise lock info to the file body. Pure. */
export function formatLockFile(info: LockInfo): string {
  return `${JSON.stringify(info)}\n`;
}

/**
 * Parse a lock file body back to {@link LockInfo}, or `null` when the content is
 * absent / malformed (a corrupt lock is treated as reclaimable, not fatal). Pure.
 */
export function parseLockFile(content: string): LockInfo | null {
  const trimmed = content.trim();
  if (trimmed === '') return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return null;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      ...(typeof parsed.host === 'string' ? { host: parsed.host } : {}),
    };
  } catch {
    return null;
  }
}

export interface StaleCheckInput {
  info: LockInfo;
  /** Current time (ms since epoch). */
  now: number;
  /** Whether the owning pid is a live process. */
  ownerAlive: boolean;
  staleMs?: number;
}

/**
 * Pure judgement: is a held lock stale and therefore safe to reclaim? A lock is
 * stale when its owner process is gone, OR when it is older than `staleMs`
 * (belt-and-suspenders against a pid that was recycled to an unrelated process).
 * A corrupt/unparseable lock is handled by the caller (parse → null → reclaim).
 */
export function isStaleLock(input: StaleCheckInput): boolean {
  const staleMs = input.staleMs ?? LOCK_DEFAULTS.staleMs;
  if (!input.ownerAlive) return true;
  const startedMs = Date.parse(input.info.startedAt);
  if (Number.isNaN(startedMs)) return true;
  return input.now - startedMs > staleMs;
}

// --- side-effecting acquire / release ---------------------------------------

/** Injected filesystem + process seam (subset of node:fs + process). */
export interface LockSys {
  /** Atomic exclusive create (O_EXCL). Rejects/throws with `code === 'EEXIST'` if the file exists. */
  writeExclusive(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
  /** True when a pid is a live process (`process.kill(pid, 0)` equivalent). */
  isProcessAlive(pid: number): boolean;
  now(): number;
}

export interface AcquireOptions {
  path: string;
  pid: number;
  host?: string;
  sys: LockSys;
  staleMs?: number;
}

export interface LockHandle {
  path: string;
  info: LockInfo;
}

export type AcquireResult =
  | { acquired: true; handle: LockHandle; reclaimedStale: boolean }
  | { acquired: false; heldBy: LockInfo | null };

/**
 * Try to acquire the lock without blocking (D2 §4.1 プリフライト軽量段). Returns
 * `acquired: false` when a live lock is held (caller exits 0). If the existing
 * lock is stale ({@link isStaleLock}) or corrupt it is removed and re-taken once;
 * a genuine race on that retry yields `acquired: false` rather than throwing.
 */
export async function acquireLock(options: AcquireOptions): Promise<AcquireResult> {
  const { path, pid, sys } = options;
  const info: LockInfo = { pid, startedAt: new Date(sys.now()).toISOString(), ...(options.host ? { host: options.host } : {}) };

  const first = await tryCreate(path, info, sys);
  if (first) return { acquired: true, handle: { path, info }, reclaimedStale: false };

  // Lock exists — decide whether it is reclaimable.
  const existing = await readExisting(path, sys);
  const reclaim =
    existing === null ||
    isStaleLock({ info: existing, now: sys.now(), ownerAlive: sys.isProcessAlive(existing.pid), ...(options.staleMs != null ? { staleMs: options.staleMs } : {}) });

  if (!reclaim) return { acquired: false, heldBy: existing };

  await sys.unlink(path).catch(() => undefined);
  const second = await tryCreate(path, info, sys);
  if (second) return { acquired: true, handle: { path, info }, reclaimedStale: true };
  return { acquired: false, heldBy: await readExisting(path, sys) };
}

async function tryCreate(path: string, info: LockInfo, sys: LockSys): Promise<boolean> {
  try {
    await sys.writeExclusive(path, formatLockFile(info));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

async function readExisting(path: string, sys: LockSys): Promise<LockInfo | null> {
  try {
    return parseLockFile(await sys.readFile(path));
  } catch {
    return null;
  }
}

/**
 * Release a lock this process holds. Idempotent: a missing file (ENOENT) is not an
 * error, so double-release / crash-cleanup never throws. Only removes the file
 * when it still belongs to us, so a reclaimed-by-someone-else lock is left intact.
 */
export async function releaseLock(handle: LockHandle, sys: LockSys): Promise<void> {
  const current = await readExisting(handle.path, sys);
  if (current !== null && current.pid !== handle.info.pid) return;
  await sys.unlink(handle.path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return;
    throw err;
  });
}
