// watchdog — external-supervisor stale-phase judgement (D9 §2, ADR-0013). The
// `halo watchdog` CLI reads `.halo/logs/current.json` (phase.ts PhaseState) and
// asks this module whether the running loop is wedged. Pure: fs and the clock
// stay outside (`now` is an argument), mirroring phase.ts / lock.ts.

import type { LoopPhase, PhaseState } from './phase.js';

/** Per-phase stall limits. `perPhase` overrides `defaultSec` for named phases. */
export interface WatchdogTimeouts {
  defaultSec: number;
  perPhase?: Partial<Record<LoopPhase, number>>;
}

/** Judgement result, carrying the numbers so callers can log them verbatim. */
export interface StaleVerdict {
  stale: boolean;
  phase: LoopPhase;
  ageSec: number;
  limitSec: number;
}

/**
 * Is the loop stuck in its current phase? `idle` is never stale (the loop has
 * terminated normally), and an unparsable `updated_at` is treated as not stale —
 * a watchdog must prefer missing a hang over killing a healthy run (誤殺より見逃し).
 * Stale only when ageSec strictly exceeds the limit (age == limit is still alive).
 */
export function isPhaseStale(
  state: PhaseState,
  now: Date,
  timeouts: WatchdogTimeouts,
): StaleVerdict {
  const limitSec = timeouts.perPhase?.[state.phase] ?? timeouts.defaultSec;
  const updatedMs = Date.parse(state.updated_at);
  if (state.phase === 'idle' || Number.isNaN(updatedMs)) {
    return { stale: false, phase: state.phase, ageSec: 0, limitSec };
  }
  const ageSec = (now.getTime() - updatedMs) / 1000;
  return { stale: ageSec > limitSec, phase: state.phase, ageSec, limitSec };
}
