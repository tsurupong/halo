# ADR-0009: Zero Global State (place all state under the target repository)

**Date**: 2026-07-11
**Status**: accepted
**Deciders**: Owner (recorded from HALO Requirements Specification v1.8 §8.2)

## Context

HALO is a general-purpose framework that may be used in parallel across multiple projects. Holding machine-global state (a registry, a budget ledger, a lock directory, etc.) increases setup/teardown steps, causes state interference between projects, and makes behavior depend on "which machine it ran on." Even in a personal verification environment (a single WSL2 machine), we want to prioritize environment reproducibility and ease of teardown above all.

## Decision

HALO holds no machine-global state whatsoever. All persistent state goes under the target repository's `.halo/` (gitignored); committed declarations go only in `.harness.yml` and CLAUDE.md. Setup is `npm i -D halo`; teardown is completed by deleting `.halo/` and removing the package. The source of truth for artifacts is GitHub (branches / PRs / Issue labels); volatile items (flock / disposable worktrees) go in the OS tmpdir.

## Alternatives Considered

### Alternative 1: Hold global state (registry, budget ledger) in `~/.halo/`
- **Pros**: A central list of multiple projects and cross-cutting budget management become possible.
- **Cons**: Teardown requires machine-level cleanup. State interferes across projects, reducing reproducibility.
- **Why not**: Exclusion is handled by the OS's flock, build caches by each tool's standard global store (pnpm store / CARGO_TARGET_DIR, etc.), trigger registration state by the OS scheduler itself as the ledger, and the budget can be measured on the fly at runtime without a ledger. Central state is unnecessary, and holding it would harm ease of teardown and reproducibility.

### Alternative 2: Hold a project registry (a list of managed repositories)
- **Pros**: You can centrally grasp "which repositories are under HALO management."
- **Cons**: Double management and inconsistency between the registry and the actual directories arise.
- **Why not**: You can judge by "the existence of `.halo/` = under management," making a registry redundant. The trigger only needs to register the absolute path to `.bin/halo` per project.

## Consequences

### Positive
- Setup and teardown are completed by package operations and deleting `.halo/`, leaving no trace on the machine.
- State does not interfere across projects, giving high environment reproducibility.
- The four categories of state (declaration / persistent state / artifact / volatile) are clearly separated by their location.

### Negative
- Cross-cutting budget/results aggregation is unavailable unless you collect each `.halo/logs/` (no central dashboard is held).

### Risks
- Forgetting to include `.halo/` in `.gitignore` causes local state to be committed → make it standard procedure at setup to always add `.halo/` to `.gitignore`.
