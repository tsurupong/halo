# ADR-0004: Prohibition of Self-Modification (Safety Invariant)

**Date**: 2026-07-09
**Status**: accepted
**Deciders**: Owner (recorded from HALO Requirements Specification v1.8 §11.1)

## Context

If the autonomous loop can rewrite the harness's own rules (prompts, gates, configuration), the meaning of the quality gates disappears. In particular, when introducing dogfooding (developing HALO with HALO), there is a structural danger that "the subject that rewrites the rules" and "the subject bound by the rules" become one and the same.

## Decision

In the loop-audit gate, treat agent modifications to CLAUDE.md / PROMPT.md / .harness.yml / test files as fail. Even after introducing dogfooding, changes to the harness itself are permanently capped at autonomy level L2 (human approval required). These must exist **before** the first unattended run.

## Alternatives Considered

### Alternative 1: Permit self-modification and catch changes in review
- **Pros**: Self-improvement of the harness is automated.
- **Cons**: We end up relying on after-the-fact detection to catch "faked passes" via test tampering or gate loosening.
- **Why not**: Safety invariants should be definitively blocked by ex-ante control (Guides). With ex-post control, a single breach can be fatal.

### Alternative 2: Detection only (warn and continue)
- **Pros**: The loop does not stop on false positives.
- **Cons**: Warnings are read by no one during unattended operation.
- **Why not**: Because unattended operation is the premise, it is meaningless unless it fails + rejects.

## Consequences

### Positive
- Structurally blocks "apparent passes" via test deletion, coverage-threshold tampering, or added lint suppressions.
- Adopting a sign (appending to PROMPT.md) is fixed to human judgment, preventing prompt contamination.

### Negative
- Harness-improvement tasks always require human review and are excluded from full automation (an intentional constraint).

### Risks
- Inspection gaps in loop-audit itself → the git-diff-based static checks are documented **enumeratively**, keeping the inspection targets under definitive management. **The authoritative list of checks is [D4 Security Design §4](../design/d4-security-design.md)** (this ADR is a summary of it). As of v1.8, the authoritative set is **7 items**:
  1. **spec_refs exist** — query whether the task's `spec_refs` (`kg://` node IDs) actually exist in the knowledge graph (read-only). Note: the v1.5 `test -f specs/*.md` is abolished.
  2. **Test files unchanged** (deletion/modification fails; new additions permitted).
  3. **Zero new escape hatches** (new additions of `eslint-disable` / `as any` / `@ts-ignore` prohibited).
  4. **Coverage threshold unchanged** (downward changes prohibited).
  5. **No self-modification** (writes to `CLAUDE.md` / `PROMPT.md` / `.harness.yml` / test files fail).
  6. **diff within 1500 lines**.
  7. **Graph file hash verification** (compare against the hash at loop start to detect direct modification during execution).
- The change of check ① from `test -f` on `specs/` files to a graph-node-existence query, and the addition of ⑦, accompany the consolidation of `specs/` into the knowledge graph (see ADR-0011; the v1.5 line had 6 items and presupposed `specs/`).
