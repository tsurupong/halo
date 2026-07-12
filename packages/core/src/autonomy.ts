// autonomy — sink autonomy filter (D2 §2.5, §7; D1 §1.5, §2). Matches each sink's
// declared `minAutonomy` against the current AUTONOMY level and decides run/skip.
//
// Levels are cumulative: L3 ⊇ L2 ⊇ L1 — a higher current level runs every sink a
// lower level would (D1 §1.5). A sink runs when the current level is at least its
// declared minimum. An undeclared `minAutonomy` is treated as the safest side
// (effectively L3, so it is skipped at L1/L2 — D1 §2, D8 §1.3).
//
// This module is pure (no fs, no clock, no global state — D2 §1 table row 7,
// §1.2). The loop calls it in the Sink state to filter before running effects.

import type { MinAutonomy } from '@tsurupong/halo-contracts';

/** Ordered levels, low → high. Index encodes cumulative rank (L1 < L2 < L3). */
export const AUTONOMY_ORDER: readonly MinAutonomy[] = ['L1', 'L2', 'L3'];

/** Rank of a level (higher = more autonomous). Pure. */
export function autonomyRank(level: MinAutonomy): number {
  return AUTONOMY_ORDER.indexOf(level);
}

/**
 * The level an undeclared `minAutonomy` collapses to: the safest side, so an
 * un-annotated sink never runs below full autonomy (D1 §2, D2 §2.5).
 */
export const UNDECLARED_AUTONOMY: MinAutonomy = 'L3';

/** Whether `value` is one of the valid level strings. Pure type guard. */
export function isAutonomyLevel(value: unknown): value is MinAutonomy {
  return typeof value === 'string' && (AUTONOMY_ORDER as readonly string[]).includes(value);
}

/**
 * Resolve a possibly-undeclared / unknown `minAutonomy` to a concrete level.
 * `undefined`, `null`, and any non-level value fall back to the safest side
 * ({@link UNDECLARED_AUTONOMY}) rather than throwing — a malformed manifest must
 * not run effects, it must be skipped (D2 §2.5 最安全側).
 */
export function resolveMinAutonomy(min: unknown): MinAutonomy {
  return isAutonomyLevel(min) ? min : UNDECLARED_AUTONOMY;
}

/**
 * Core judgement: does a sink requiring `min` run at the `current` level? True
 * when current rank ≥ required rank (cumulative L3 ⊇ L2 ⊇ L1). `min` undefined /
 * invalid is resolved to the safest side first. Pure.
 */
export function shouldRunSink(min: MinAutonomy | undefined, current: MinAutonomy): boolean {
  return autonomyRank(current) >= autonomyRank(resolveMinAutonomy(min));
}

/** Minimal shape a sink must expose to be filtered (subset of its `plugin.json`). */
export interface AutonomyFilterable {
  name: string;
  minAutonomy?: MinAutonomy;
}

/**
 * Keep only the sinks enabled at `current`, preserving input order (discovery has
 * already ordered them, D2 §6.2). Pure — returns a new array, never mutates input
 * (immutability, coding-style). Undeclared `minAutonomy` → skipped below L3.
 */
export function filterSinksByAutonomy<T extends AutonomyFilterable>(sinks: readonly T[], current: MinAutonomy): T[] {
  return sinks.filter((s) => shouldRunSink(s.minAutonomy, current));
}
