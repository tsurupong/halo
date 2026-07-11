import { describe, it, expect, vi } from 'vitest';
import {
  localDayKey,
  logTimestampMs,
  aggregateDailyUsage,
  evaluateBudget,
  isIterationLogName,
  checkBudget,
  type BudgetFs,
} from './budget.js';
import type { IterationLog } from './logger.js';

// A minimal valid iteration log for a given day + optional cost.
function makeLog(iso: string, usd?: number): IterationLog {
  return {
    iter: 1,
    started_at: iso,
    ended_at: iso,
    profile: 'test',
    autonomy: 'L1',
    task: { task_id: null, kind: 'code' },
    gates: [],
    gate_pass_rate: null,
    outcome: 'passed',
    ...(usd !== undefined ? { executor: { cost: { usd_estimate: usd } } } : {}),
  };
}

const NOON = Date.parse('2026-07-11T12:00:00.000Z');

describe('localDayKey', () => {
  it('produces a YYYY-MM-DD key', () => {
    expect(localDayKey(NOON)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('is stable across times within the same local day', () => {
    const a = localDayKey(Date.parse('2026-07-11T01:00:00'));
    const b = localDayKey(Date.parse('2026-07-11T23:00:00'));
    expect(a).toBe(b);
  });
});

describe('logTimestampMs', () => {
  it('prefers ended_at, falls back to started_at', () => {
    expect(logTimestampMs({ started_at: '2026-07-01T00:00:00Z', ended_at: '2026-07-02T00:00:00Z' })).toBe(
      Date.parse('2026-07-02T00:00:00Z'),
    );
    expect(logTimestampMs({ started_at: '2026-07-01T00:00:00Z', ended_at: 'garbage' })).toBe(
      Date.parse('2026-07-01T00:00:00Z'),
    );
  });

  it('returns null when neither timestamp parses', () => {
    expect(logTimestampMs({ started_at: 'x', ended_at: 'y' })).toBeNull();
  });
});

describe('aggregateDailyUsage', () => {
  it('counts only today and sums recorded cost', () => {
    const local = new Date(NOON);
    const todayIso = local.toISOString();
    const logs = [makeLog(todayIso, 0.5), makeLog(todayIso, 1.25), makeLog('2020-01-01T00:00:00Z', 99)];
    const usage = aggregateDailyUsage(logs, NOON);
    expect(usage.usedIterations).toBe(2);
    expect(usage.usedCostUsd).toBeCloseTo(1.75);
  });

  it('treats logs without cost as zero cost', () => {
    const todayIso = new Date(NOON).toISOString();
    const usage = aggregateDailyUsage([makeLog(todayIso), makeLog(todayIso)], NOON);
    expect(usage).toEqual({ usedIterations: 2, usedCostUsd: 0 });
  });

  it('ignores logs whose date cannot be parsed', () => {
    const usage = aggregateDailyUsage([makeLog('not-a-date', 5)], NOON);
    expect(usage).toEqual({ usedIterations: 0, usedCostUsd: 0 });
  });

  it('is empty for no logs', () => {
    expect(aggregateDailyUsage([], NOON)).toEqual({ usedIterations: 0, usedCostUsd: 0 });
  });
});

describe('evaluateBudget', () => {
  it('is ok below the iteration limit', () => {
    const s = evaluateBudget({ usedIterations: 3, usedCostUsd: 0 }, { dailyMaxIterations: 5 });
    expect(s.ok).toBe(true);
    expect(s.remainingIterations).toBe(2);
    expect(s.remainingCostUsd).toBeNull();
  });

  it('is not ok exactly at the iteration limit (boundary: used == limit)', () => {
    const s = evaluateBudget({ usedIterations: 5, usedCostUsd: 0 }, { dailyMaxIterations: 5 });
    expect(s.ok).toBe(false);
    expect(s.remainingIterations).toBe(0);
  });

  it('clamps remaining at zero when over the limit', () => {
    const s = evaluateBudget({ usedIterations: 7, usedCostUsd: 0 }, { dailyMaxIterations: 5 });
    expect(s.ok).toBe(false);
    expect(s.remainingIterations).toBe(0);
  });

  it('enforces the cost cap when set, at the boundary', () => {
    expect(evaluateBudget({ usedIterations: 1, usedCostUsd: 9.99 }, { dailyMaxCostUsd: 10 }).ok).toBe(true);
    expect(evaluateBudget({ usedIterations: 1, usedCostUsd: 10 }, { dailyMaxCostUsd: 10 }).ok).toBe(false);
  });

  it('requires both dimensions to have headroom when both are set', () => {
    const limits = { dailyMaxIterations: 5, dailyMaxCostUsd: 10 };
    expect(evaluateBudget({ usedIterations: 2, usedCostUsd: 12 }, limits).ok).toBe(false);
    expect(evaluateBudget({ usedIterations: 6, usedCostUsd: 2 }, limits).ok).toBe(false);
    expect(evaluateBudget({ usedIterations: 2, usedCostUsd: 2 }, limits).ok).toBe(true);
  });

  it('imposes no cap when no limits are given (ok, null remainders)', () => {
    const s = evaluateBudget({ usedIterations: 999, usedCostUsd: 999 });
    expect(s.ok).toBe(true);
    expect(s.remainingIterations).toBeNull();
    expect(s.remainingCostUsd).toBeNull();
  });
});

describe('isIterationLogName', () => {
  it('matches iter_N.json only', () => {
    expect(isIterationLogName('iter_1.json')).toBe(true);
    expect(isIterationLogName('iter_42.json')).toBe(true);
    expect(isIterationLogName('iter_.json')).toBe(false);
    expect(isIterationLogName('summary.json')).toBe(false);
    expect(isIterationLogName('iter_1.json.bak')).toBe(false);
  });
});

describe('checkBudget', () => {
  const todayIso = new Date(NOON).toISOString();

  function fsWith(files: Record<string, string>): BudgetFs {
    return {
      readdir: vi.fn(async () => Object.keys(files)),
      readFile: vi.fn(async (p: string) => {
        const name = p.split('/').pop() as string;
        if (!(name in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return files[name] as string;
      }),
    };
  }

  it('aggregates iter logs and evaluates against limits', async () => {
    const fs = fsWith({
      'iter_1.json': JSON.stringify(makeLog(todayIso, 1)),
      'iter_2.json': JSON.stringify(makeLog(todayIso, 2)),
      'other.json': 'ignored',
    });
    const s = await checkBudget({ logDir: '/logs', fs, now: NOON, dailyMaxIterations: 5, dailyMaxCostUsd: 10 });
    expect(s.usedIterations).toBe(2);
    expect(s.usedCostUsd).toBeCloseTo(3);
    expect(s.ok).toBe(true);
    expect(s.remainingIterations).toBe(3);
    expect(fs.readFile).not.toHaveBeenCalledWith(expect.stringContaining('other.json'));
  });

  it('treats a missing log directory as no usage (full budget)', async () => {
    const fs: BudgetFs = {
      readdir: vi.fn(async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      }),
      readFile: vi.fn(),
    };
    const s = await checkBudget({ logDir: '/missing', fs, now: NOON, dailyMaxIterations: 5 });
    expect(s.usedIterations).toBe(0);
    expect(s.ok).toBe(true);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('skips corrupt / unreadable log files without crashing', async () => {
    const fs = fsWith({
      'iter_1.json': '{ this is not json',
      'iter_2.json': JSON.stringify(makeLog(todayIso, 1)),
      'iter_3.json': '[]', // valid JSON but not an object → skipped
    });
    const s = await checkBudget({ logDir: '/logs', fs, now: NOON, dailyMaxIterations: 5 });
    expect(s.usedIterations).toBe(1);
    expect(s.ok).toBe(true);
  });

  it('reports over-budget when the day is at the iteration limit', async () => {
    const fs = fsWith({
      'iter_1.json': JSON.stringify(makeLog(todayIso)),
      'iter_2.json': JSON.stringify(makeLog(todayIso)),
    });
    const s = await checkBudget({ logDir: '/logs', fs, now: NOON, dailyMaxIterations: 2 });
    expect(s.ok).toBe(false);
    expect(s.remainingIterations).toBe(0);
  });

  it('propagates a non-ENOENT readdir error', async () => {
    const fs: BudgetFs = {
      readdir: vi.fn(async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }),
      readFile: vi.fn(),
    };
    await expect(checkBudget({ logDir: '/logs', fs, now: NOON })).rejects.toThrow('EACCES');
  });
});
