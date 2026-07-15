# ADR-0014: Transient-Failure Requeue and Quarantine

**Date**: 2026-07-15
**Status**: proposed
**Deciders**: Owner

## Context

When a task fails its gates, the loop already performs bounded in-memory retries within the run process, then invokes the `on-fail` port (best-effort) with `{task_id, reason, retry_count, gate?}`. Failures that are transient across processes — rate limits, flaky tests, network errors — currently end as a `failure-catalog.md` entry and require a human to re-submit the task. For unattended operation on the local markdown task queue (`.halo/tasks/queue/*.md`), transient failures should flow back into the queue automatically, while persistent failures must not loop forever.

## Decision

Add an `on-fail` port plugin `on-fail-requeue` (alongside `on-fail-record`). It classifies `reason` against a transient-pattern list (rate limit, flaky test, network, timeout); transient failures move the task file back into `.halo/tasks/queue/`, with a per-task attempt counter persisted under `.halo/requeue/<task_id>.count`. When attempts exceed `REQUEUE_MAX_ATTEMPTS`, the task file is moved (never deleted) to `.halo/tasks/quarantine/`. Scope is the local task source only; GitHub task-source requeue is out of scope. Responsibility split: in-process retry (existing, unchanged) handles intra-run flakiness; `on-fail-requeue` handles cross-process re-supply only.

## Alternatives Considered

### Alternative 1: Implement requeue inside core (`loop.ts`)
- **Pros**: Single authority over retry policy.
- **Cons**: Couples core to one task-source's storage layout; violates the ports-and-adapters delegation of ADR-0001.
- **Why not**: Task-queue mutation is adapter territory, not core.

### Alternative 2: Classify failures inside `on-fail-record` (one plugin)
- **Pros**: Fewer plugins.
- **Cons**: Mixes an append-only human-readable log with queue mutation; contract fixtures and failure modes diverge.
- **Why not**: One plugin, one side effect keeps contracts testable; `on-fail` supports multiple ordered plugins.

### Alternative 3: Delete tasks that exceed the attempt limit
- **Pros**: Cleaner queue directory.
- **Cons**: Irreversible; contradicts the safety principle of archiving over deleting.
- **Why not**: Quarantine preserves evidence and allows manual re-triage.

## Consequences

### Positive
- Transient overnight failures self-heal without human intervention; persistent failures converge to quarantine instead of burning iterations.
- Core is untouched; the feature is fully removable by deleting the plugin directory.

### Negative
- Double-retry surface: a transient failure may consume both in-process retries and requeue attempts. Accepted — the two layers cover different failure lifetimes, and both are bounded.
- Reason classification is regex-based and will misclassify novel messages (defaults to non-transient → recorded, not requeued — fail-safe direction).

### Risks
- Requeue loops if the counter file is lost → counter lives under `.halo/requeue/` (outside worktrees, stable across runs); quarantine is the hard backstop.
- Concurrent runs racing on the same task file → moves use `mv` (atomic on the same filesystem); a missing source file is treated as already-handled and exits 0.
- ADR-0004 alignment: the plugin writes only under `.halo/tasks/` and `.halo/requeue/`; it never modifies `CLAUDE.md` / `PROMPT.md` / `.harness.yml` / tests.
