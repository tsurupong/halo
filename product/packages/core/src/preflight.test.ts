// preflight unit tests (D2 §4, D8 §1.2 module 5): the ordered short-circuit of
// both stages, plus the concrete check builders. Pure — no real fs / git.
import { describe, expect, it, vi } from 'vitest';
import {
  isBudgetExhausted,
  isStopFilePresent,
  isWorktreeClean,
  runPreflightHeavy,
  runPreflightLight,
  stopFilePath,
  STOP_FILENAME,
  type LightChecks,
} from './preflight.js';
import type { BudgetStatus } from './budget.js';

function lightChecks(over: Partial<LightChecks> = {}): LightChecks {
  return {
    stopFilePresent: () => false,
    lockHeldByOther: () => false,
    budgetExhausted: () => false,
    ...over,
  };
}

describe('runPreflightLight', () => {
  it('proceeds when no check fires', async () => {
    expect(await runPreflightLight(lightChecks())).toEqual({ proceed: true });
  });

  it('stops on STOP first, before lock or budget (order)', async () => {
    const lock = vi.fn(() => true);
    const budget = vi.fn(() => true);
    const decision = await runPreflightLight(lightChecks({ stopFilePresent: () => true, lockHeldByOther: lock, budgetExhausted: budget }));
    expect(decision).toEqual({ proceed: false, reason: 'STOP' });
    // Short-circuit: later checks never run.
    expect(lock).not.toHaveBeenCalled();
    expect(budget).not.toHaveBeenCalled();
  });

  it('checks lock before budget', async () => {
    const budget = vi.fn(() => true);
    const decision = await runPreflightLight(lightChecks({ lockHeldByOther: () => true, budgetExhausted: budget }));
    expect(decision).toEqual({ proceed: false, reason: 'LOCK_HELD' });
    expect(budget).not.toHaveBeenCalled();
  });

  it('stops on budget when STOP and lock pass', async () => {
    expect(await runPreflightLight(lightChecks({ budgetExhausted: () => true }))).toEqual({
      proceed: false,
      reason: 'BUDGET_EXCEEDED',
    });
  });

  it('awaits async checks', async () => {
    expect(await runPreflightLight(lightChecks({ stopFilePresent: async () => true }))).toEqual({
      proceed: false,
      reason: 'STOP',
    });
  });
});

describe('runPreflightHeavy', () => {
  it('proceeds when the worktree is clean and optional checks are omitted', async () => {
    expect(await runPreflightHeavy({ worktreeClean: () => true })).toEqual({ proceed: true });
  });

  it('aborts with DIRTY_WORKTREE first', async () => {
    const disk = vi.fn(() => true);
    const decision = await runPreflightHeavy({ worktreeClean: () => false, diskOk: disk });
    expect(decision).toEqual({ proceed: false, reason: 'DIRTY_WORKTREE' });
    expect(disk).not.toHaveBeenCalled();
  });

  it('aborts on disk after a clean worktree', async () => {
    expect(await runPreflightHeavy({ worktreeClean: () => true, diskOk: () => false })).toEqual({
      proceed: false,
      reason: 'DISK_LOW',
    });
  });

  it('aborts on stale graph last', async () => {
    expect(await runPreflightHeavy({ worktreeClean: () => true, diskOk: () => true, graphFresh: () => false })).toEqual({
      proceed: false,
      reason: 'GRAPH_STALE',
    });
  });
});

describe('concrete check builders', () => {
  it('stopFilePath joins STOP under the .halo dir', () => {
    expect(stopFilePath('/repo/.halo')).toBe(`/repo/.halo/${STOP_FILENAME}`);
  });

  it('isStopFilePresent consults the fs seam at the STOP path', async () => {
    const fs = { exists: vi.fn(async (p: string) => p === '/repo/.halo/STOP') };
    expect(await isStopFilePresent('/repo/.halo', fs)).toBe(true);
    expect(fs.exists).toHaveBeenCalledWith('/repo/.halo/STOP');
  });

  it('isBudgetExhausted is the negation of BudgetStatus.ok', () => {
    expect(isBudgetExhausted({ ok: true } as BudgetStatus)).toBe(false);
    expect(isBudgetExhausted({ ok: false } as BudgetStatus)).toBe(true);
  });

  it('isWorktreeClean is true only when git status --porcelain is empty', async () => {
    expect(await isWorktreeClean(async () => ({ stdout: '   \n' }))).toBe(true);
    expect(await isWorktreeClean(async () => ({ stdout: ' M src/a.ts\n' }))).toBe(false);
  });
});
