# ADR-0021: Cost-Based Stop Condition (max budget USD)

**Date**: 2026-07-18
**Status**: proposed
**Deciders**: Owner

## Context

HALO's runaway/cost control is currently count- and time-based only: `max_turns` (40) and `timeout_sec` (900) per iteration, `MAX_ITER` per launch, and a **daily budget counted in iterations** (06 §5). The monthly dollar ceiling ($200 switch point) is a purely human, out-of-band judgment via ccusage. `executor.out.cost.usd` already exists in the contract but is observability-only — no document connects a measured dollar amount to a stop decision. The Agent SDK provides `maxBudgetUsd` as a built-in stop condition, confirming that per-run dollar ceilings are a first-class pattern for unattended agents. For nightly unattended operation, iteration counts are a poor proxy for spend: cost per iteration varies by an order of magnitude with task size and model pricing.

## Decision

Add a dollar-based stop mechanism on two levels: (1) extend `executor.in.budget` with an **optional** `max_budget_usd` field that the executor passes through to the underlying runtime's budget stop (contract change = MINOR per D1 §7); (2) have the core accumulate `executor.out.cost.usd` across iterations and treat "accumulated cost ≥ the profile's dollar budget" as an over-budget condition in PreflightLight, terminating the launch as normal non-execution (exit 0), exactly like the existing iteration-count daily budget. Per ADR-0012, this ADR fixes the **mechanism only**; no default dollar values are set — profiles supply the numbers after operational measurement.

## Alternatives Considered

### Alternative 1: Keep iteration-count budgets only
- **Pros**: No contract change; already implemented.
- **Cons**: Iterations are not costs; one pathological task can spend more than a whole normal night while staying within counts.
- **Why not**: The measurement (`cost.usd`) already flows through the contract; refusing to act on it leaves the primary risk (unattended dollar runaway) uncontrolled.

### Alternative 2: External monitor (ccusage cron) kills the loop on overspend
- **Pros**: No contract change; independent of executor cooperation.
- **Cons**: Reactive and coarse (minutes of lag); kill-based termination loses the clean per-iteration completion path; duplicates watchdog machinery for a non-hang concern (D9 scopes watchdog to time-based staleness only).
- **Why not**: The in-loop check is cheaper, deterministic, and terminates between iterations without violence; ccusage remains the out-of-band audit layer.

## Consequences

### Positive
- Nightly runs get a hard dollar ceiling that no single task can blow through unnoticed.
- Uses only existing data flow (`executor.out.cost.usd`) plus one optional input field — backward compatible; executors that ignore `max_budget_usd` still stop at the core's accumulation check.

### Negative
- Cost accounting depends on the executor reporting `cost.usd`; a non-reporting executor degrades to count/time budgets only (accepted: field stays optional in the contract).
- One more knob per profile.

### Risks
- Client-side cost estimates may undercount actual billing → treat the ceiling as a soft safety net, keep ccusage/monthly review as the authoritative audit (06 §5 unchanged on that row).
- Mid-iteration budget stop by the runtime may surface as `stuck`/`timeout` → the on-fail classification (ADR-0014) must treat budget-stop as non-transient (do not requeue into the same exhausted budget).

## Links

- Contract change: [D1 §1.3 executor / §7 semver](../design/d1-contract-spec.md) — optional field addition = MINOR.
- Parameter table: [06 Security, Cost & Observability §5](../design/06-security-cost-observability.md).
- CLI surface: [D3 CLI Spec](../design/d3-cli-spec.md) — `--max-budget-usd` override flag.
- Mechanism-not-numbers premise: **ADR-0012**.
