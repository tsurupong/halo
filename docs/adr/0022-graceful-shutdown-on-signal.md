# ADR-0022: Graceful Shutdown on SIGINT / SIGTERM

**Date**: 2026-07-28
**Status**: accepted (implemented 2026-07-29)
**Deciders**: Owner

## Context

`halo run` installs no signal handlers — there is no `process.on('SIGINT' | 'SIGTERM')` anywhere under `packages/`. Every cleanup path in a run is a JavaScript `finally`:

- the run lock is released in `packages/cli/src/core-ext/run-wiring.ts:553-555`,
- the disposable worktree is removed in `packages/core/src/loop.ts:696-698`,
- the phase log is reset to `idle` by `finish()` in `packages/core/src/loop.ts:424-427`.

Node's default disposition for SIGINT/SIGTERM is immediate termination, so a signal bypasses all three. What is left behind is a leaked worktree, a lock file that survives until the next run's stale-reclaim (`lock.ts:80-86` — owner-dead, or older than six hours), and a `current.json` frozen at a non-`idle` phase. That frozen phase file is the exact input `halo watchdog` reads, so a cleanly-stopped run leaves the harness looking wedged.

Signals are not an edge case for this system. ADR-0013's `kill` action sends SIGTERM to the run's process group; `systemctl stop`, `schtasks /End` and a host reboot do the same; and an operator debugging a nightly run presses Ctrl-C. Design 04 §4.7 already specifies that when the loop is cut off, "cleanup (flock release, logs write)" is performed — the promise is in the design and has never been implemented.

## Decision

`halo run` installs SIGINT/SIGTERM handlers that request a **cooperative abort** instead of letting the process die.

1. **First signal** — abort the in-flight port child through the existing `runPort` kill path (SIGTERM → grace → SIGKILL on the detached process group) and unwind the loop through the `finally` chain that already exists. The run ends with a new terminal reason `ABORTED_SIGNAL`, mapped to exit 0 (a legitimate non-execution, like `STOP`).
2. **The interrupted task is recorded neutrally** — iteration outcome `aborted_signal`, with **no** `retry_count` increment and **no** `op=fail` sent to the task-source. A scheduler-initiated stop must never consume a healthy task's retry budget.
3. **Second signal** — exit immediately with `128 + signum` and no cleanup, so a cleanup that itself wedges can always be escaped.

Mechanism: an `AbortSignal` is threaded from the CLI into the loop (`LoopDeps.abort`) and into `runPort` (`RunPortInput.signal`). The loop consults it at the iteration boundary and immediately after the executor returns; `runPort` reuses `killTree` on abort. No new timers and no polling — the signal handler only flips a controller.

## Alternatives Considered

### Alternative 1: Wait for the current iteration to finish, then stop at the iteration boundary
- **Pros**: Strongest consistency — no iteration is ever half-executed, and no new outcome value is needed.
- **Cons**: `executorTimeoutSec` defaults to 900 s with a 30 s grace (`loop.ts:388-389`, `LOOP_DEFAULTS`), so Ctrl-C appears hung for 15+ minutes. systemd's default `TimeoutStopSec` (90 s) escalates to SIGKILL long before that, reproducing exactly the uncleaned state this ADR exists to fix.
- **Why not**: It does not actually bound stop latency, so it fails under the very schedulers that generate most of our signals.

### Alternative 2: Record the interruption as a failure (`retry_count++`, `op=fail`)
- **Pros**: A watchdog `kill` of a wedged run then progresses deterministically toward `needs-human`.
- **Cons**: Every routine stop — nightly window closing, host reboot, operator Ctrl-C — burns retry budget on tasks that never failed, and after `retryThreshold` (default 3) escalates healthy work to a human.
- **Why not**: It conflates "the operator stopped the harness" with "the task is bad". The wedge case is already recorded independently in `watchdog.jsonl` (ADR-0013), so nothing is lost by keeping the abort neutral.

### Alternative 3: Leave it to the external watchdog (status quo)
- **Pros**: Zero new code.
- **Cons**: The watchdog's own `kill` is one of the signal sources, so the leak persists by construction. Worse, the frozen non-`idle` `current.json` left behind is what a *later* watchdog invocation reads.
- **Why not**: The external supervisor is the trigger of this problem, not a remedy for it. ADR-0013 explicitly scopes itself to detecting a wedge from outside; in-process shutdown hygiene is a separate concern.

## Consequences

### Positive
- Ctrl-C, `systemctl stop`, and a watchdog `kill` all converge on the same bounded path: child killed, worktree removed, phase set to `idle`, lock released.
- The design-04 §4.7 promise ("cut off with SIGTERM and perform cleanup") stops being aspirational.
- A stopped run no longer looks wedged to the next `halo watchdog` invocation, removing a class of false-positive kills.
- Stop latency is bounded by the port kill grace (5 s, `RUN_PORT_DEFAULTS.killGraceMs`), not by the executor timeout.

### Negative
- Exit 0 for a signal-aborted run means monitoring cannot tell "stopped by operator" from "completed normally" by exit code alone. The distinction lives in the iteration log (`aborted_signal`) and, for wedges, in `watchdog.jsonl`.
- The new `aborted_signal` value widens the iteration-log `outcome` enum — an additive contracts (JSON Schema) change that downstream readers of `iter_N.json` must tolerate. `halo status` aggregation must learn the new value or it falls into `other`.
- Two code paths gain an abort parameter (`runLoop`, `runPort`), which is threaded through the wiring; a future port added without honouring the signal would silently not abort.

### Risks
- **A handler that throws or hangs traps the process.** Mitigated by keeping the handler to "abort the controller and print one line" with all filesystem work on the normal unwind path, and by the second-signal immediate exit.
- **Abort during the `sink` phase** can leave a commit created but `op=complete` unsent, leaving the task in-progress until the next run re-supplies it. This is the same window a crash already opens (`loop.ts:636-637`), not a new one.
- **ADR-0004 alignment**: the shutdown path writes only `.halo/logs/` and removes the worktree it created; `CLAUDE.md` / `PROMPT.md` / `.harness.yml` / tests are untouched.
