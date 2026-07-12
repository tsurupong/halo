# ADR-0007: Runtime Absorbs "Artifact Kind," Not "Language"

**Date**: 2026-07-09
**Status**: accepted
**Deciders**: Owner (recorded from HALO Requirements Specification v1.5 §4.2⑦⑧)

## Context

HALO's use cases are not limited to app development; they also include creating and revising design docs and ADRs. Treating document tasks specially would proliferate document-specific branches across the core, executor, and gates.

## Decision

Make the runtime plugin's abstraction "kind of artifact" rather than "language," and treat code (node-pnpm / python-uv / rust) and documents (docs-md) as peer runtimes. docs-md's check is markdownlint + broken-link check + ADR-template conformance; its test is a glossary-consistency check (matching against the knowledge graph). Tasks switch runtime and prompt via the Issue label `kind:<name>` and the kinds definition in `.harness.yml`.

## Alternatives Considered

### Alternative 1: A separate loop for documents (a docs-only pipeline)
- **Pros**: The code loop can be kept simple.
- **Cons**: Double loop management. Safety devices, logs, and triggers all get duplicated.
- **Why not**: The structure of "gating via static inspection + dynamic verification" is isomorphic for documents and code. Raising the abstraction one level lets a single loop suffice.

### Alternative 2: Implicit runtime auto-detection (detect.sh)
- **Pros**: Easy to introduce without `.harness.yml`.
- **Cons**: Detection errors lead to running the wrong gates, making root-cause isolation difficult.
- **Why not**: Adopt the explicit declaration approach with `.harness.yml` required (needs-human if absent). We prioritize reproducibility.

## Consequences

### Positive
- Supporting a new kind (go / java / slides, etc.) is completed by adding a directory.
- The glossary-consistency check auto-gates the ubiquitous language.
- The bidirectional docs ⇔ code reflection (docs merge → reindex, code change → staleness detection → file a docs Issue) rides on the same mechanism.

### Negative
- The "test" concept for documents (glossary consistency) is coarse initially; its strictness is tuned after a track record of 10 docs tasks.

### Risks
- Excessive blocking by the glossary check → mitigated by an initial policy where only banned-term violations block, and unregistered terms remain suggestions.
