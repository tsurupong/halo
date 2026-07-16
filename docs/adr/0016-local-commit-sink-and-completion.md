# ADR-0016: Local Commit Sink and Generalized Completion Reference

**Date**: 2026-07-16
**Status**: proposed
**Deciders**: Owner

## Context

At autonomy L1 the loop has no PR-producing sink, so `resolvePrUrl` returns `''` and
`op=complete` never fires (D1 §1.5 forbids force-completing with an empty pr_url).
With the local markdown task source this creates two field-verified failures
(2026-07-16 run): a task that passes its gates (1) is re-picked and re-executed
indefinitely because it never leaves `queue/`, and (2) leaves no durable artifact —
the executor edits the disposable worktree, nothing commits, and worktree removal
discards the work. L1 as implemented can produce work but cannot deliver it.

## Decision

1. **Add a `sink-git-commit` plugin**: on gate-passed iterations it stages and commits
   the worktree's changes to the per-task branch `feature/issue-<task_id>` (created by
   the core worktree lifecycle). It never pushes; the artifact stays local. Allowed at
   L1 — "report-only" is reinterpreted as "no external publication (push/PR/deploy)";
   a local branch commit is evidence, not publication.
2. **Generalize the completion reference**: `resolvePrUrl` may return any non-empty
   result reference, not only a PR URL (`commit:<sha>` for local delivery). The
   CLI wiring resolves it by comparing the worktree HEAD against the target repo HEAD
   after sinks run: a new commit exists → `commit:<sha>` → `op=complete` fires;
   no commit → `''` → the task stays in queue (unchanged semantics).
   `resolvePrUrl` becomes sync-or-async (`string | Promise<string>`); the loop awaits it.

## Alternatives Considered

### Alternative 1: Have the task source complete on `passed` outcome directly
- **Pros**: No core change.
- **Cons**: "Gates passed" without a durable artifact would count as delivered;
  work would still be discarded silently.
- **Why not**: Completion must be tied to evidence of delivery, not to gate results.

### Alternative 2: Commit inside the executor adapter
- **Pros**: One plugin fewer.
- **Cons**: Commits would happen before gates judge the diff; a failed gate would
  leave a committed-but-rejected branch tip. Executor contract stays "produce changes".
- **Why not**: Persisting artifacts is a sink concern by the port taxonomy (D1 §1.5).

### Alternative 3: Skip completion and let the operator empty the queue manually
- **Pros**: Zero code.
- **Cons**: Defeats unattended operation; every pass burns budget re-doing done work.
- **Why not**: The 2026-07-16 run demonstrated exactly this failure burning 3 iterations.

## Consequences

### Positive
- L1 + local task source becomes end-to-end deliverable: pass → commit on
  `feature/issue-<id>` → complete → queue advances. The operator reviews branches
  and opens PRs manually (human-in-the-loop preserved).
- The completion mechanism is sink-agnostic: a future PR sink returns a PR URL
  through the same channel with no further core changes.

### Negative
- `pr_url` fields in the task-source contract and `done/*.result` now carry
  non-URL references (`commit:<sha>`). Accepted: the schema types it as string;
  docs note the generalization.
- A sink other than `sink-git-commit` that commits to the worktree would also
  trigger completion. Accepted: any committed artifact is a delivery.
