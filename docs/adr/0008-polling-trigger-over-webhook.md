# ADR-0008: Adopt a Polling Trigger (no webhook)

**Date**: 2026-07-09
**Status**: accepted
**Deciders**: Owner (recorded from HALO Requirements Specification v1.5 §4.4)

## Context

A startup method for the core loop is needed. The execution environment is a single WSL2 machine with no public endpoint. There is a trade-off between the delay from GitHub Issue submission to task execution and the cost/security risk of a resident receiver.

## Decision

Make the trigger an interchangeable adapter (three scripts: install / uninstall / fire), with the initial implementations being `schedule/` (the Windows Task Scheduler, a primary trigger that also serves to boot the WSL2 VM) and `polling/` (high-frequency startup at 15-minute intervals + preflight's "exit immediately if zero ready tasks"). Webhook is not adopted.

## Alternatives Considered

### Alternative 1: Webhook (directly receiving GitHub Issue events)
- **Pros**: Minimal delay (event-driven).
- **Cons**: Requires a resident receiver process and a tunnel (public inbound path). A path of public input → local execution is dangerous from a prompt-injection standpoint.
- **Why not**: Polling + immediate exit on zero tasks achieves effectively task-existence-driven behavior, and a 15-minute delay is not a problem for nightly unattended operation. Reconsider only if the delay requirement becomes a measured problem (a structure addressable by swapping the trigger alone is already secured).

### Alternative 2: A resident daemon (systemd timer / cron continuous monitoring)
- **Pros**: Self-contained within WSL2.
- **Cons**: Because the WSL2 VM auto-stops, the trigger itself does not fire while the VM is stopped.
- **Why not**: Making the Windows Task Scheduler the primary trigger is needed so it also serves to boot the VM.

## Consequences

### Positive
- Zero public endpoints, creating no injection path.
- Everything under run.sh is unaware of what the trigger is, so a future swap to webhook / manual is possible by file operations alone.

### Negative
- Up to 15 minutes (the polling interval) of delay before starting a task.
- High-frequency startup makes total-volume control via a daily budget, flock, and lightweight preflight mandatory (addressed as standard equipment in run.sh).

### Risks
- Worktree destruction from concurrent schedule startups → avoided by flock exclusion + a profile TIMEOUT.
