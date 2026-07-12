# ADR-0003: Adopting KuzuDB and Merge-Driven Reindexing (no watch)

**Date**: 2026-07-09
**Status**: accepted
**Deciders**: Owner (recorded from HALO Requirements Specification v1.5 §5.1–5.2)

## Context

A backend is needed for the code graph (CodeGraphContext) and the knowledge graph. We want to avoid a resident server in a personal verification environment (a single WSL2 machine). We also need to decide when the graph is updated under the disposable worktree approach (ADR-0002).

## Decision

The backend is KuzuDB (embedded, single file, no server). Updates are "merge-driven + preflight" (Option A): on loop startup, reindex if main has advanced from the previous index. During loop execution the graph is shared across all worktrees as a read-only snapshot based on main, and is immutable.

## Alternatives Considered

### Alternative 1: Neo4j
- **Pros**: Mature ecosystem, supports multi-process writes.
- **Cons**: Resident server and operational cost. Overkill at the personal verification stage.
- **Why not**: Migrate once the need arises (recorded as a deferred decision).

### Alternative 2: Real-time updates via watch mode
- **Pros**: Graph freshness is always current.
- **Cons**: The watch target becomes the ephemeral worktrees rather than main, contaminating the graph with intermediate states.
- **Why not**: Structurally incompatible with the disposable worktree approach.

## Consequences

### Positive
- Zero server management; the graph DB is a single file (graphs/*.kuzu).
- Immutability of the graph during loop execution guarantees context reproducibility across iterations.
- KuzuDB's single-process write constraint is structurally avoided by "writing only once, at preflight."

### Negative
- The graph goes stale between a merge and the next preflight (mitigated by bidirectional auto-reflection: docs merge → sink 35-reindex, code change → staleness detection → auto-file a kind:docs Issue).

### Risks
- Lock contention during parallelism → avoided by sharing a read-only snapshot (§10).
- Cypher dialect differences when migrating to Neo4j → the migration surface is minimized by limiting the initial tools to two (search_docs / trace_spec_to_code).
