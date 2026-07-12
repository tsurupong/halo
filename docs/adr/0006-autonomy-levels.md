# ADR-0006: Sink-Filter Implementation of Autonomy Levels (L1→L3)

**Date**: 2026-07-09
**Status**: accepted
**Deciders**: Owner (recorded from HALO Requirements Specification v1.5 §3.2 Principle 6 / §4.2⑤)

## Context

Opening the autonomous loop's permissions wide all at once causes real harm (bad PRs, wasted cost) before we can observe the judgment quality when introducing new plugins or launching a new loop. A mechanism to raise permissions gradually is needed, and it must be able to go up and down independently of the feature-addition Phases.

## Decision

Hold a runtime parameter `AUTONOMY` (L1 = report only / L2 = commit + draft PR / L3 = unattended through PR creation). Each sink declares the metadata `# min-autonomy:`, and the core implements a filter that skips sinks below the current value. A new loop and any newly introduced plugin always start at L1, and are promoted based on thresholds derived from measured data (scoring over 10 nights). Keep Phase (the feature axis) and autonomy (the permission axis) orthogonal.

## Alternatives Considered

### Alternative 1: Permission control via conditionals inside the core loop
- **Pros**: Intuitive to implement.
- **Cons**: Adding or changing an autonomy level requires modifying the core. Contradicts the ports & adapters principle (ADR-0001).
- **Why not**: With sink-side declarations + a generic core filter, autonomy support for a newly added sink is a single line.

### Alternative 2: Swapping the contents of sink.d per profile
- **Pros**: Zero added mechanism.
- **Cons**: Duplicate management of the sink file sets arises, and their contents diverge between L2/L3.
- **Why not**: A single sink set + a filter is more DRY.

## Consequences

### Positive
- Promotion and demotion are completed by changing a single environment variable (can be bundled via profiles).
- A single critical incident (self-modification detection, an attempt to access secrets) can operationally trigger an immediate demotion to L1.

### Negative
- Promotion thresholds cannot be set until Phase 2 measurements (over 10 nights) exist (a threshold without measurement is false precision — an intentional judgment).

### Risks
- Scoring L1 observations burdens the human → minimized by structured storage under logs/.
