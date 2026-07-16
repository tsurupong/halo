# Architecture Decision Records

A record of HALO's design decisions. Source: HALO Requirements Specification v1.5 (2026-07-09); ADR-0009 onward is v1.8 (2026-07-11).
The current top-level authority is Requirements Specification v1.8, and ADR-0009 onward takes v1.8 as its starting point (0008 and earlier record decisions as of v1.5).

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-ports-and-adapters-unified-contract.md) | Adoption of Ports & Adapters Structure and a Unified Contract | accepted | 2026-07-09 |
| [0002](0002-disposable-worktree.md) | Adoption of the Disposable Worktree Approach | accepted | 2026-07-09 |
| [0003](0003-kuzudb-merge-driven-reindex.md) | Adopting KuzuDB and Merge-Driven Reindexing (no watch) | accepted | 2026-07-09 |
| [0004](0004-self-modification-prohibition.md) | Prohibition of Self-Modification (Safety Invariant) | accepted | 2026-07-09 |
| [0005](0005-knowledge-graph-schema-granularity.md) | Knowledge Graph Schema Granularity (fixed at 5 node types, 5 edge types) | accepted | 2026-07-09 |
| [0006](0006-autonomy-levels.md) | Sink-Filter Implementation of Autonomy Levels (L1→L3) | accepted | 2026-07-09 |
| [0007](0007-runtime-as-artifact-kind.md) | Runtime Absorbs "Artifact Kind," Not "Language" | accepted | 2026-07-09 |
| [0008](0008-polling-trigger-over-webhook.md) | Adopt a Polling Trigger (no webhook) | accepted | 2026-07-09 |
| [0009](0009-zero-global-state.md) | Zero Global State (place all state under the target repository) | accepted | 2026-07-11 |
| [0010](0010-typescript-core.md) | TypeScript for Core, CLI, and Contracts (plugins remain any-language) | accepted | 2026-07-11 |
| [0011](0011-specs-abolition-graph-consolidation.md) | Abolishing specs/ and Consolidating Requirements into the Knowledge Graph | accepted | 2026-07-11 |
| [0012](0012-no-premature-numeric-fixing.md) | Do Not Fix Numeric Parameters in Advance (mechanism now, numbers from operational measurement) | accepted | 2026-07-11 |
| [0013](0013-external-watchdog-supervisor.md) | External Watchdog Supervisor Process | proposed | 2026-07-15 |
| [0014](0014-failure-requeue-and-quarantine.md) | Transient-Failure Requeue and Quarantine | proposed | 2026-07-15 |
| [0015](0015-posix-portability-and-scheduler-abstraction.md) | POSIX Portability Target and Scheduler Backend Abstraction | proposed | 2026-07-16 |
| [0016](0016-local-commit-sink-and-completion.md) | Local Commit Sink and Generalized Completion Reference | proposed | 2026-07-16 |
