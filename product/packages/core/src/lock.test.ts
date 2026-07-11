import { describe, it, expect, vi } from 'vitest';
import {
  defaultLockPath,
  formatLockFile,
  parseLockFile,
  isStaleLock,
  acquireLock,
  releaseLock,
  LOCK_DEFAULTS,
  type LockSys,
  type LockInfo,
} from './lock.js';

describe('defaultLockPath', () => {
  it('is $TMPDIR/halo.lock by default', () => {
    expect(defaultLockPath('/tmp')).toBe('/tmp/halo.lock');
    expect(defaultLockPath('/tmp/')).toBe('/tmp/halo.lock');
  });

  it('is profile-scoped so distinct profiles do not block each other', () => {
    expect(defaultLockPath('/tmp', 'nightly')).toBe('/tmp/halo-nightly.lock');
  });
});

describe('parseLockFile / formatLockFile', () => {
  it('round-trips lock info', () => {
    const info: LockInfo = { pid: 123, startedAt: '2026-07-11T00:00:00.000Z', host: 'wsl' };
    expect(parseLockFile(formatLockFile(info))).toEqual(info);
  });

  it('returns null for empty or malformed content', () => {
    expect(parseLockFile('')).toBeNull();
    expect(parseLockFile('not json')).toBeNull();
    expect(parseLockFile('{"pid":"x"}')).toBeNull();
  });
});

describe('isStaleLock', () => {
  const info: LockInfo = { pid: 500, startedAt: '2026-07-11T00:00:00.000Z' };
  const now = Date.parse('2026-07-11T00:00:10.000Z');

  it('is stale when the owner process is gone', () => {
    expect(isStaleLock({ info, now, ownerAlive: false })).toBe(true);
  });

  it('is NOT stale when owner alive and within the age window', () => {
    expect(isStaleLock({ info, now, ownerAlive: true })).toBe(false);
  });

  it('is stale when older than staleMs even if a pid is alive (pid recycle guard)', () => {
    const later = Date.parse('2026-07-11T00:00:00.000Z') + LOCK_DEFAULTS.staleMs + 1;
    expect(isStaleLock({ info, now: later, ownerAlive: true })).toBe(true);
  });

  it('is stale when the timestamp is unparseable', () => {
    expect(isStaleLock({ info: { pid: 1, startedAt: 'garbage' }, now, ownerAlive: true })).toBe(true);
  });
});

function makeSys(overrides: Partial<LockSys> & { files?: Record<string, string> } = {}): LockSys {
  const files: Record<string, string> = overrides.files ?? {};
  return {
    async writeExclusive(path, data) {
      if (path in files) {
        const err = new Error('exists') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      files[path] = data;
    },
    async readFile(path) {
      if (!(path in files)) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return files[path]!;
    },
    async unlink(path) {
      delete files[path];
    },
    isProcessAlive: overrides.isProcessAlive ?? (() => true),
    now: overrides.now ?? (() => Date.parse('2026-07-11T00:00:00.000Z')),
  };
}

describe('acquireLock', () => {
  it('acquires a free lock and writes owner info', async () => {
    const files: Record<string, string> = {};
    const sys = makeSys({ files });
    const res = await acquireLock({ path: '/tmp/halo.lock', pid: 111, host: 'wsl', sys });
    expect(res.acquired).toBe(true);
    if (res.acquired) {
      expect(res.reclaimedStale).toBe(false);
      expect(res.handle.info.pid).toBe(111);
    }
    expect(parseLockFile(files['/tmp/halo.lock']!)?.pid).toBe(111);
  });

  it('refuses when a live lock is held (double-launch rejected)', async () => {
    const held = formatLockFile({ pid: 999, startedAt: '2026-07-11T00:00:00.000Z' });
    const sys = makeSys({ files: { '/tmp/halo.lock': held }, isProcessAlive: () => true });
    const res = await acquireLock({ path: '/tmp/halo.lock', pid: 111, sys });
    expect(res.acquired).toBe(false);
    if (!res.acquired) expect(res.heldBy?.pid).toBe(999);
  });

  it('reclaims a stale lock whose owner is dead', async () => {
    const held = formatLockFile({ pid: 999, startedAt: '2026-07-11T00:00:00.000Z' });
    const sys = makeSys({ files: { '/tmp/halo.lock': held }, isProcessAlive: () => false });
    const res = await acquireLock({ path: '/tmp/halo.lock', pid: 222, sys });
    expect(res.acquired).toBe(true);
    if (res.acquired) expect(res.reclaimedStale).toBe(true);
  });

  it('reclaims a corrupt lock file', async () => {
    const sys = makeSys({ files: { '/tmp/halo.lock': 'garbage' } });
    const res = await acquireLock({ path: '/tmp/halo.lock', pid: 222, sys });
    expect(res.acquired).toBe(true);
  });
});

describe('releaseLock', () => {
  it('removes a lock we own', async () => {
    const files: Record<string, string> = {};
    const sys = makeSys({ files });
    const res = await acquireLock({ path: '/tmp/halo.lock', pid: 111, sys });
    if (!res.acquired) throw new Error('setup failed');
    await releaseLock(res.handle, sys);
    expect('/tmp/halo.lock' in files).toBe(false);
  });

  it('is idempotent when the file is already gone', async () => {
    const sys = makeSys();
    await expect(releaseLock({ path: '/tmp/halo.lock', info: { pid: 1, startedAt: 'x' } }, sys)).resolves.toBeUndefined();
  });

  it('does not remove a lock reclaimed by another process', async () => {
    const other = formatLockFile({ pid: 777, startedAt: '2026-07-11T01:00:00.000Z' });
    const files: Record<string, string> = { '/tmp/halo.lock': other };
    const unlink = vi.fn();
    const sys = makeSys({ files });
    sys.unlink = unlink;
    await releaseLock({ path: '/tmp/halo.lock', info: { pid: 111, startedAt: 'x' } }, sys);
    expect(unlink).not.toHaveBeenCalled();
  });
});
