import { describe, it, expect } from 'vitest';
import {
  AUTONOMY_ORDER,
  autonomyRank,
  isAutonomyLevel,
  resolveMinAutonomy,
  shouldRunSink,
  filterSinksByAutonomy,
  UNDECLARED_AUTONOMY,
} from './autonomy.js';
import type { MinAutonomy } from '@tsurupong/halo-contracts';

describe('autonomyRank / AUTONOMY_ORDER', () => {
  it('ranks levels cumulatively L1 < L2 < L3', () => {
    expect(autonomyRank('L1')).toBeLessThan(autonomyRank('L2'));
    expect(autonomyRank('L2')).toBeLessThan(autonomyRank('L3'));
    expect(AUTONOMY_ORDER).toEqual(['L1', 'L2', 'L3']);
  });
});

describe('isAutonomyLevel', () => {
  it('accepts the three valid levels', () => {
    for (const l of ['L1', 'L2', 'L3']) expect(isAutonomyLevel(l)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const v of ['l1', 'L4', '', undefined, null, 1, {}]) expect(isAutonomyLevel(v)).toBe(false);
  });
});

describe('resolveMinAutonomy', () => {
  it('passes through valid levels', () => {
    expect(resolveMinAutonomy('L2')).toBe('L2');
  });

  it('falls back to the safest side (L3) for undeclared / invalid', () => {
    expect(UNDECLARED_AUTONOMY).toBe('L3');
    expect(resolveMinAutonomy(undefined)).toBe('L3');
    expect(resolveMinAutonomy(null)).toBe('L3');
    expect(resolveMinAutonomy('nonsense')).toBe('L3');
  });
});

describe('shouldRunSink', () => {
  it('runs when current level meets or exceeds the required minimum', () => {
    expect(shouldRunSink('L1', 'L1')).toBe(true);
    expect(shouldRunSink('L1', 'L3')).toBe(true); // cumulative: L3 ⊇ L1
    expect(shouldRunSink('L2', 'L2')).toBe(true);
    expect(shouldRunSink('L2', 'L3')).toBe(true);
  });

  it('skips when the required minimum is above the current level', () => {
    expect(shouldRunSink('L3', 'L1')).toBe(false);
    expect(shouldRunSink('L2', 'L1')).toBe(false);
    expect(shouldRunSink('L3', 'L2')).toBe(false);
  });

  it('treats undeclared minAutonomy as most restrictive (L3)', () => {
    expect(shouldRunSink(undefined, 'L1')).toBe(false);
    expect(shouldRunSink(undefined, 'L2')).toBe(false);
    expect(shouldRunSink(undefined, 'L3')).toBe(true);
  });
});

describe('filterSinksByAutonomy', () => {
  it('skips L3 sink when current autonomy is L1 (D8 §1.3)', () => {
    const sinks = [
      { name: '15-create-pr', minAutonomy: 'L3' as MinAutonomy },
      { name: '20-progress-log', minAutonomy: 'L1' as MinAutonomy },
    ];
    const enabled = filterSinksByAutonomy(sinks, 'L1');
    expect(enabled.map((s) => s.name)).toEqual(['20-progress-log']);
  });

  it('treats undeclared minAutonomy as most restrictive (L3) (D8 §1.3)', () => {
    const sinks = [{ name: '10-git-commit' }];
    expect(filterSinksByAutonomy(sinks, 'L2')).toEqual([]);
  });

  it('enables the full L2 set at L2 (progress-log + git-commit + create-pr)', () => {
    const sinks = [
      { name: '10-git-commit', minAutonomy: 'L1' as MinAutonomy },
      { name: '15-create-pr', minAutonomy: 'L2' as MinAutonomy }, // draft at L2, normal at L3 — filter only decides run/skip
      { name: '20-progress-log', minAutonomy: 'L1' as MinAutonomy },
    ];
    expect(filterSinksByAutonomy(sinks, 'L2').map((s) => s.name)).toEqual([
      '10-git-commit',
      '15-create-pr',
      '20-progress-log',
    ]);
  });

  it('preserves input order and does not mutate the source array', () => {
    const sinks = [
      { name: 'b', minAutonomy: 'L1' as MinAutonomy },
      { name: 'a', minAutonomy: 'L1' as MinAutonomy },
    ];
    const snapshot = [...sinks];
    const result = filterSinksByAutonomy(sinks, 'L3');
    expect(result.map((s) => s.name)).toEqual(['b', 'a']);
    expect(sinks).toEqual(snapshot);
    expect(result).not.toBe(sinks);
  });

  it('returns an empty array for no sinks', () => {
    expect(filterSinksByAutonomy([], 'L3')).toEqual([]);
  });
});
