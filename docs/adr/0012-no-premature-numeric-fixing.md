# ADR-0012: Do Not Fix Numeric Parameters in Advance (mechanism now, numbers from operational measurement)

**Date**: 2026-07-11
**Status**: accepted
**Deciders**: Owner (recorded from HALO Requirements Specification v1.8 §11.2)

## Context

Judgments repeatedly arise over whether to settle at design time the numbers and details that govern operational behavior — the decision thresholds for autonomy promotion, the retry cap, the evaluator's skepticism level, the strictness of the glossary-consistency check, and so on. Setting a threshold (validity rate of N%, M consecutive nights, etc.) without measured data becomes "false precision," and by the time you change it later, operation already depends on that value. Meanwhile, the mechanisms that handle these (recording of scoring, sign re-injection, severity filtering) must be built now, or we cannot even obtain the measured data.

## Decision

Make the criterion for "should it be decided in advance" the rework cost (is it a one-way door?), and do not fix numbers or details in advance. Build the mechanisms now (the machinery to store scoring structurally under logs/, a 3-level severity filter, extension points for context injection according to retry_count), but treat all their thresholds and counts as initial (provisional) values, parameters to be tuned by operational measurement. In particular, for autonomy-promotion decisions, "do not set a number at this point" (a threshold without measurement is false precision), and first build only the mechanism to record L1 plan scoring. Explicitly state a review time (e.g., after 10 nights of measurement at Phase 2 completion) for each parameter.

## Alternatives Considered

### Alternative 1: Settle numeric values for all parameters at design time
- **Pros**: Behavior is uniquely determined from the start, and implementation is simple.
- **Cons**: A threshold without measurement is false precision. Even if found inappropriate after operation begins, operation and data already depending on that value have accumulated, making the change costly.
- **Why not**: The harness's philosophy is not "decide everything in advance" but "build in advance a structure that makes change cheap and safe, and decide the contents while running." Numbers are low-rework-cost (two-way-door) parameters and need not be fixed in advance.

### Alternative 2: Defer both numbers and mechanisms
- **Pros**: Minimal initial implementation.
- **Cons**: Without the scoring and failure-recording mechanisms, no measured data to base tuning on can be obtained at all.
- **Why not**: What numeric tuning needs is measured data, and the mechanisms that produce it (logs recording, sign re-injection, severity filtering) must be built first. Treat mechanisms and numbers as separate layers.

## Consequences

### Positive
- Measurement-based tuning becomes possible, avoiding erroneous operational lock-in from false precision.
- Parameter extension points (per-retry injection strategies via context.d, etc.) remain as plugins, making change cheap and safe.

### Negative
- Because thresholds are "provisional" initially, there is a period where humans intervene in promotion/demotion/retry-cutoff decisions (autonomy-promotion decisions are made by humans for the time being).

### Risks
- "Provisional values" becoming permanent without being tuned → state a review time for each parameter (e.g., after 10 nights of measurement at Phase 2 completion), and institutionalize a starting point for tuning by accumulating per-retry-count success rates and L1 scoring data under logs/.
