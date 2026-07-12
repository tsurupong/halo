# ADR-0002: Adoption of the Disposable Worktree Approach

**Date**: 2026-07-09
**Status**: accepted
**Deciders**: Owner (recorded from HALO Requirements Specification v1.5 §4.2③)

## Context

We want to physically separate the AI's working directory from the human's working directory to prevent state contamination between tasks. We also want to apply the fresh-context principle (one task per iteration) to the filesystem as well, and to clearly delineate the write boundary of the bubblewrap sandbox.

## Decision

Treat it as 1 Issue = 1 branch = 1 worktree, operated on a disposable lifecycle of `add → setup → run → (pass: PR / fail: finalize after 3 attempts) → remove --force`. Make bubblewrap's write-permission scope match the worktree.

## Alternatives Considered

### Alternative 1: Reusing a fixed working directory (cleaned via git reset)
- **Pros**: Dependency installs can be reused, so setup is fast.
- **Cons**: Leftovers from the previous task (untracked files, caches) leak into the next task. The cleanup logic itself becomes a source of bugs.
- **Why not**: We prioritize zero state contamination and "cleanup in a single delete." Setup speedup is solved on the runtime side (link-based sharing).

### Alternative 2: Cloning the repository each time
- **Pros**: Isolation is complete.
- **Cons**: Clone cost is high, and a separate mechanism to prevent branch collisions is needed.
- **Why not**: With worktrees, git itself forbids double-checkout of the same branch, giving collision prevention during parallelism for free.

## Consequences

### Positive
- Zero state contamination; cleanup on failure is a single `worktree remove --force`.
- Sandbox boundary = task working scope, so for auditing "where this task touched" is clear.

### Negative
- Setup runs every task, so each runtime is required to provide "fast materialization of dependencies."
- A placement constraint arises where wt/, the store, and cache/ must be on the WSL2 ext4 side (link sharing is only effective within the same FS).

### Risks
- Errors from corrupted shared build cache → tolerated on the premise that correctness is detected by gates.
