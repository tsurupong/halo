# ADR-0011: Abolishing specs/ and Consolidating Requirements into the Knowledge Graph

**Date**: 2026-07-11
**Status**: accepted
**Deciders**: Owner (recorded from HALO Requirements Specification v1.8 §5.3)

## Context

We need to settle where requirements, specifications, and acceptance criteria are stored. Initially there was a plan to place them as files in a dedicated directory (specs/) and guarantee their frozenness ("the AI cannot rewrite the goal") via git management of the directory. However, requirements are also ingested into the knowledge graph (ADR-0003 / ADR-0005), causing double management and inconsistency between files and the graph. The essence of frozenness is "that the goal is not modified during loop execution," not the existence of the directory itself.

## Decision

Manage requirements and specifications centrally in the knowledge graph, with no dedicated directory (specs/). Guarantee frozenness not by directory freezing but by write control to the graph plus hash verification: (1) during loop execution, the knowledge MCP opens the graph read-only; (2) writes are limited to two paths — "human manual work" and "sink 35 (reindex after a docs merge that has passed PR review)"; (3) loop-audit ⑦ verifies the graph file's hash against the value at loop start and fails on direct modification during execution. Where a human manages the requirement originals (md, etc.) is outside HALO's concern (it suffices that they are ingested into the graph).

## Alternatives Considered

### Alternative 1: Keep the specs/ directory and guarantee frozenness via git management
- **Pros**: Requirements can be read directly as files, familiar to existing spec-driven workflows.
- **Cons**: Double management and inconsistency between the graph and specs/. Files remain rewritable by the agent even during execution, and git alone cannot guarantee "freezing during execution."
- **Why not**: The essence of frozenness is write control during execution, and read-only opening + hash verification is more reliable. It also avoids double management.

### Alternative 2: Hold requirements only in the Issue body, not ingested into the graph
- **Pros**: A simple mechanism; no initial cost of building the graph.
- **Cons**: Node references via spec_refs and traceability (trace_spec_to_code) do not hold.
- **Why not**: As a transitional measure, Phases 1–3 operate with empty spec_refs and descriptions in the Issue body (§9), but the policy is to enable centralized management and frozenness guarantees upon graph introduction in Phase 4. As a permanent measure it is insufficient.

## Consequences

### Positive
- Requirements have a single storage location — the knowledge graph — eliminating double management and inconsistency with specs/.
- Frozenness is structurally guaranteed by "read-only during execution + limited write paths + hash verification," and goal modification during execution can be detected as fail (reusing a mechanism isomorphic to the self-modification prohibition of ADR-0004).

### Negative
- The path to grep requirements directly as files officially disappears; reference is fundamentally via MCP tools (search_docs / trace_spec_to_code).

### Risks
- Frozenness does not operate in Phases 1–3 before the graph is introduced → as a transitional measure, document operating with empty spec_refs and requirements in the Issue body. Enable spec_refs and the frozenness guarantee upon Phase 4 introduction.
- An accident where write path (b), sink 35, lets through a change that has not passed PR review → limit writes to "reindex after a review-passed docs merge," and any other write during execution fails via hash verification.
