// watchdog の停滞判定 (D9 §2) と killProcessTree のシーム検証。新規追加テスト。
import { describe, expect, test, vi } from 'vitest';
import { isPhaseStale, type WatchdogTimeouts } from './watchdog.js';
import { killProcessTree } from './runPort.js';
import type { PhaseState } from './phase.js';

const NOW = new Date('2026-07-16T12:00:00Z');
const TIMEOUTS: WatchdogTimeouts = { defaultSec: 1800, perPhase: { execute: 3600 } };

function state(partial: Partial<PhaseState> = {}): PhaseState {
  return {
    iter: 3,
    task_id: 'T-1',
    phase: 'gate',
    updated_at: '2026-07-16T11:00:00Z',
    ...partial,
  };
}

describe('isPhaseStale (D9 §2)', () => {
  test('ageSec == limitSec is NOT stale; +1s is stale (boundary)', () => {
    const atLimit = state({ updated_at: new Date(NOW.getTime() - 1800_000).toISOString() });
    expect(isPhaseStale(atLimit, NOW, TIMEOUTS)).toMatchObject({
      stale: false,
      ageSec: 1800,
      limitSec: 1800,
    });
    const past = state({ updated_at: new Date(NOW.getTime() - 1801_000).toISOString() });
    expect(isPhaseStale(past, NOW, TIMEOUTS)).toMatchObject({ stale: true, ageSec: 1801 });
  });

  test('idle is never stale, even far past the limit', () => {
    const idle = state({ phase: 'idle', updated_at: '2026-07-01T00:00:00Z' });
    expect(isPhaseStale(idle, NOW, TIMEOUTS).stale).toBe(false);
  });

  test('perPhase override applies to the named phase only', () => {
    const updated = new Date(NOW.getTime() - 3000_000).toISOString(); // 3000s ago
    expect(
      isPhaseStale(state({ phase: 'execute', updated_at: updated }), NOW, TIMEOUTS),
    ).toMatchObject({ stale: false, limitSec: 3600 });
    expect(
      isPhaseStale(state({ phase: 'sink', updated_at: updated }), NOW, TIMEOUTS),
    ).toMatchObject({
      stale: true,
      limitSec: 1800,
    });
  });

  test('unparsable updated_at is not stale (prefer missing a hang over a false kill)', () => {
    const verdict = isPhaseStale(state({ updated_at: 'garbage' }), NOW, TIMEOUTS);
    expect(verdict).toEqual({ stale: false, phase: 'gate', ageSec: 0, limitSec: 1800 });
  });

  test('verdict carries phase / ageSec / limitSec for logging', () => {
    const verdict = isPhaseStale(state(), NOW, TIMEOUTS);
    expect(verdict.phase).toBe('gate');
    expect(verdict.ageSec).toBe(3600);
    expect(verdict.limitSec).toBe(1800);
    expect(verdict.stale).toBe(true);
  });
});

describe('killProcessTree', () => {
  test('signals the process group (negative pid) and reports success', () => {
    const kill = vi.fn();
    expect(killProcessTree(1234, 'SIGTERM', kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(-1234, 'SIGTERM');
  });

  test('returns false when the group is already gone', () => {
    const kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    expect(killProcessTree(1234, 'SIGKILL', kill)).toBe(false);
  });
});
