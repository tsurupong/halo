# ADR-0013: External Watchdog Supervisor Process

**Date**: 2026-07-15
**Status**: proposed
**Deciders**: Owner

## Context

`halo run` executes the loop in a single Node process and `await`s each port synchronously (`packages/cli/src/core-ext/run-wiring.ts`). Per-port process timeouts already exist in `runPort` (SIGTERM → grace → SIGKILL on the detached process group), so a hang inside one port invocation is bounded. What remains unbounded is a wedge of the run process itself: a state where the loop stops advancing phases but no port timeout fires (e.g. runner stuck between phases, fs stalls, or endless retry churn). Unattended overnight operation must not silently stall until morning.

The phase-boundary log (`.halo/logs/current.json`, written by `markPhase` at every phase transition with an `updated_at` timestamp) and the run lock file (which records the run process pid) together provide enough observable state to detect and break such a wedge from outside.

## Decision

Add a `halo watchdog` CLI command that runs as a separate supervisor process (invoked periodically, e.g. via a trigger/cron). It reads `current.json` and the lock file; if `now - updated_at` exceeds a per-phase timeout, it kills the run's process group (reusing the `killTree` mechanism from `runPort`) and optionally quarantines the offending task (skip mode). Recovery to the next run is delegated to the existing trigger schedule. Stall-detection logic lives in core as a pure function (`isPhaseStale`) with injected clock/fs for testability.

## Alternatives Considered

### Alternative 1: In-process watchdog (timer inside `halo run`)
- **Pros**: No extra process or scheduling; single deployment unit.
- **Cons**: While the loop `await`s an executor, the same process cannot preempt itself reliably; a wedged event loop also wedges the watchdog.
- **Why not**: The failure mode we defend against (whole-process wedge) disables an in-process guard by definition.

### Alternative 2: New `watchdog` port kind
- **Pros**: Fits the plugin discovery model.
- **Cons**: Ports follow a one-shot stdin/stdout JSON contract driven by the loop; a supervisor must outlive and observe the loop from outside. Adding a port kind ripples through the `Port` union, schema generation, discovery, and contract tests.
- **Why not**: Wrong lifecycle; the supervisor is not a loop stage.

### Alternative 3: Rely solely on per-port timeouts
- **Pros**: Zero new code.
- **Cons**: Does not cover wedges between ports, fs stalls, or livelock-style non-progress.
- **Why not**: Overnight unattended operation requires a last-resort backstop.

## Consequences

### Positive
- Silent overnight stalls become bounded: detection latency ≤ watchdog interval + phase timeout.
- Reuses existing observable state (`current.json`, lock pid); no changes to the loop's hot path.
- Pure detection logic is unit-testable without processes.

### Negative
- One more process to schedule; if the watchdog itself is not scheduled, no protection (mitigated by documenting it in the ops runbook and trigger setup).
- Kill is by process group: any orphaned children sharing the group die too (intended, same semantics as `runPort` timeouts).

### Risks
- Stale `current.json` from a *cleanly finished* run must not trigger kills → the watchdog verifies the lock pid is alive before acting, and treats terminal phases (`idle`, absent lock) as non-stall.
- Clock skew / paused laptop (WSL2 sleep) can fake staleness → timeouts are configured per phase via profile env (`WATCHDOG_*_TIMEOUT_SEC`) with conservative defaults.
- ADR-0004 alignment: the watchdog writes only to `.halo/logs` and the task queue/quarantine directories; it never touches `CLAUDE.md` / `PROMPT.md` / `.harness.yml` / tests.
