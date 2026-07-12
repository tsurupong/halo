# D8. Test Strategy (HALO Test Strategy)

| Item | Content |
|---|---|
| Document version | 1.0 |
| Premise | HALO Requirements Specification v1.8 is the top-level document, and D1 Contract Specification is the authority for contract definitions |
| Positioning | **Public** (quality assurance policy as OSS; reflected in the CI of `packages/core` and the sample plugins) |
| Quality basis | The coverage targets, counts, and thresholds in this document are treated as **initial values** (following the philosophy of requirements §11.2, they are not fixed in advance; they are adjusted from measurements) |
| Status | Runs in parallel with Phase 1 implementation (confirmed by extracting from the implementation) |

> This document translates Requirements Specification §11 (safety invariants, numeric parameter policy) and D1 §6 (automatic JSON Schema generation and validation in non-TS plugins) into an implementable test policy. It takes the contract defined by D1 (stdin JSON / stdout JSON / exit code) as the basis for verification, and introduces no decision rules that contradict D1.

---

## 0. Overall Picture of the Test Strategy

HALO has the structure "core in TypeScript, plugins in any language, communication via a JSON contract at process boundaries" (D1 §0). Corresponding to this structure, tests are divided into 4 layers. **Only the E2E layer incurs API charges (real executor calls)**; the design constraint is that the other 3 layers can be run fast with zero cost.

| Layer | Target | Purpose | API charge | Timing |
|---|---|---|---|---|
| ① core unit test | The 9 core modules made into pure functions | Correctness of the logic | None | Per PR |
| ② loop regression test | loop state machine (executor mock) | Prevent regression of loop control and termination conditions | None (fixed JSON returned) | Per PR |
| ③ contract test | I/O of all sample plugins | Conformance to the contract (D1) | None | Per PR |
| ④ E2E | Smoke against real GitHub | Confirm integration and real wiring | Yes (minimized by dry-run) | Before release |

**Design principle**: ① to ③ are guaranteed to be deterministic, fast, and zero-cost, and are always run per PR. Because ④ involves non-determinism and charges, its frequency is limited (before release) and its impact and cost are minimized with a `MAX_ITER=1` dry-run.

---

## 1. core Unit Tests (the 9 modules made into pure functions)

### 1.1 Policy

The 9 core modules defined by the D2 Core Detailed Design are implemented as **pure functions**, pushing side effects (process spawn / file I/O / network) out to the boundary. The pure-function portions are exhaustively verified with `vitest`. The thin boundary layer that carries side effects is wrapped with mocks.

- **Test runner**: `vitest` (since core is TypeScript / distributed via npm).
- **Placement**: `packages/core/**/*.test.ts` (same directory as the implementation, co-located).
- **Structure**: Arrange-Act-Assert. Test names are descriptive of the behavior (e.g., `returns exit 0 immediately when task_id is null`).
- **Coverage measurement**: `vitest --coverage` (initial targets in the table below, treated as initial values).

### 1.2 Test Perspectives per Module

| # | Module | Target of pure-function extraction | Main test perspectives | Coverage target (initial value) |
|---|---|---|---|---|
| 1 | config | Resolution of launch profile and environment variables | Merge order of defaults, error on missing required values, override rules (CLI > profile > default) | 90% |
| 2 | discovery | `*.d` scanning / order sort / activation decision | Ascending sort by numeric prefix, reflection of deactivation (deletion), priority of `plugin.json`'s `order`, stable sort of duplicate orders | 90% |
| 3 | runPort | Assembly of spawn arguments / stdout parsing / decision | stdin JSON serialization, mapping exit code → decision (0/2/other), handling of stdout JSON parse failure, adding the timeout argument | 85% |
| 4 | loop | State transition function (deciding the next state) | Transitions next→context→execute→gate→sink/onFail, retry decision, the 5 termination conditions (§2.3) | 90% |
| 5 | preflight | Decision order of the 2 preflight stages | Order of stages, short-circuit stopping at either one, `needs-human` decision when `.harness.yml` is absent | 90% |
| 6 | budget | Aggregation algorithm for the day's actuals | Aggregation of `logs/` for the day, boolean decision of cap overrun, boundary values (exactly at the cap, empty logs) | 90% |
| 7 | autonomy | The sink's `minAutonomy` filter | Mapping of L1/L2/L3 to sink enabled/skipped, safest-side decision when undeclared (= treated as L3) | 95% |
| 8 | lock | State decision of lock acquisition/release | Rejection of double acquisition, detection logic for a leftover lock (the pure portion equivalent to flock) | 85% |
| 9 | logger | Formatting of structured logs (`iter_N.json`) | Formatting of stderr capture, defaults on missing fields, non-inclusion of sensitive information | 85% |

> **Guideline for pure-function extraction**: extract into pure functions every decision, mapping, and formatting that can be expressed as "input → output." Enclose process launches and file writes in boundary functions, and mock the boundary in unit tests (do not launch real processes). The real behavior of the boundary is confirmed in ② loop regression tests and ④ E2E.

### 1.3 Example (autonomy filter)

```typescript
// packages/core/autonomy.test.ts
test('skips L3 sink when current autonomy is L1', () => {
  // Arrange
  const sinks = [
    { name: '15-create-pr', minAutonomy: 'L3' },
    { name: '20-progress-log', minAutonomy: 'L1' },
  ];
  // Act
  const enabled = filterSinksByAutonomy(sinks, 'L1');
  // Assert
  expect(enabled.map((s) => s.name)).toEqual(['20-progress-log']);
});

test('treats undeclared minAutonomy as most restrictive (L3)', () => {
  const sinks = [{ name: '10-git-commit', minAutonomy: undefined }];
  expect(filterSinksByAutonomy(sinks, 'L2')).toEqual([]);
});
```

---

## 2. Loop Regression Tests (executor mock = fixed JSON returned)

### 2.1 Policy

The loop state machine (module 4 of §1.2) is run in a near end-to-end form by **replacing the real executor with a mock that returns fixed JSON**. The executor is a process that returns `{ "status": ..., "summary": ... }` (D1 §1.3) on stdout; by replacing it with a script (bash / node that echoes fixed JSON), the entire loop control can be verified with **zero API charge**.

- **Guarantee of zero charge**: the mock executor never calls `claude -p` and only returns the fixed JSON the test specifies. Even when run on CI, no charges or network access occur.
- **Determinism**: because the mock returns fixed output for a given input, loop behavior is fully reproducible. Suitable for detecting regressions.
- **Targets**: loop branches and termination conditions, re-injection on retry, on-fail invocation, the logical AND of gates, and coordination with the sink autonomy filter.

### 2.2 Structure of the Mock executor

| Mock response | executor output (fixed JSON) | Path verified |
|---|---|---|
| Success | `{"status":"done","summary":"ok"}` | all gates pass → sink runs → complete |
| gate fail | `{"status":"done","summary":"ok"}` + gate mock exits 2 | re-injection of fail reason, increment of retry_count |
| stuck | `{"status":"stuck","summary":"..."}` | on-fail invocation, failure path |
| timeout | `{"status":"timeout","summary":"..."}` | on-fail invocation, failure path |
| no task | task-source mock returns `{"task_id":null}` | immediate exit 0 |

> gate / task-source are mocked in the same way (scripts with fixed behavior conforming to the exit code rules of D1 §3). This reproduces all loop branches without charge.

### 2.3 Regression of the 5 Termination Conditions (consistent with D2)

All of loop's termination conditions are fixed by regression tests (each condition correctly falls to exit 0).

| # | Termination condition | Mock setup | Expected behavior |
|---|---|---|---|
| 1 | no task | task-source returns `{"task_id":null}` | immediate exit 0 |
| 2 | STOP kill switch | place `.halo/STOP` | exit 0 at the start of the iteration |
| 3 | MAX_ITER reached | set `MAX_ITER=N` | stop after N iterations |
| 4 | budget overrun | budget mock returns overrun | stop before that iteration |
| 5 | escalation | the same task fails the threshold number (initial value 3) of times | apply `needs-human`, cut off re-injection |

### 2.4 Example (retry and re-injection)

```typescript
test('re-injects gate fail reason into next iteration prompt', async () => {
  // Arrange: executor returns done, but the gate mock fails on the 1st and passes on the 2nd
  const executor = mockExecutor({ status: 'done', summary: 'ok' });
  const gate = mockGateSequence([
    { exit: 2, out: { reason: 'coverage 87% < 90%', gate: '30-test' } },
    { exit: 0 },
  ]);
  // Act
  const result = await runLoop({ executor, gate, maxIter: 3 });
  // Assert
  expect(result.iterations[1].prompt).toContain('coverage 87% < 90%');
  expect(result.status).toBe('completed');
});
```

---

## 3. contract test (verify the I/O of all sample plugins with JSON Schema)

### 3.1 Policy

Following D1 §6, the single source of truth for the contract is the TypeScript type definitions in `packages/contracts`, and the JSON Schema (Draft 2020-12) generated from them is distributed. The contract test **verifies the input/output of all sample plugins by running them through the distributed Schema**. It is the layer that machine-verifies the language-independent contract across languages.

- **Targets**: all sample plugin types (including the 4 types explained in D5).
  - `task-source-github` / `runtime-node-pnpm` / `gate-loop-audit` / `trigger-polling` (the initial 4 sample types).
  - All sample plugins added thereafter are included as targets.
- **Validator**: any JSON Schema validator (`ajv` (TS), Python `jsonschema` / `check-jsonschema`, etc.). CI adopts `ajv` as standard.
- **Verification content**: run each plugin's input example and expected output example through the Schema of the relevant port (the list in D1 Appendix A) and confirm pass/fail.

### 3.2 Verification Items per Plugin Type

| Plugin (example) | Port | Input verification | Output verification | Exit code rule |
|---|---|---|---|---|
| task-source-github | ① task-source | `task-source.in.json` (oneOf: next/complete/fail) | `task-source.out.json` (op=next, `task_id` required, null allowed) | next: 0 / complete/fail: 0 |
| (context sample) | ② context | task-source `op=next` output (no dedicated Schema) | `context.out.json` (`fragments[]`, priority integer) | always treated as success |
| (executor sample) | ③ executor | `executor.in.json` (prompt/workdir/budget) | `executor.out.json` (status enum / summary required) | decided by status |
| gate-loop-audit | ④ gate | `gate.in.json` (task_id/workdir/changed_files) | `gate.out.json` (only on fail, reason required) | 0=pass / 2=fail |
| (sink sample) | ⑤ sink | `sink.in.json` (task_id/workdir/summary) | no output | best-effort |
| (on-fail sample) | ⑥ on-fail | `on-fail.in.json` (reason/retry_count, etc.) | no output | best-effort |
| runtime-node-pnpm | ⑦ runtime | `runtime.in.json` (workdir, common to setup/check/test) | no output | check/test: 0=pass / 2=fail |
| trigger-polling | ⑨ trigger | no stdin JSON contract (arguments only) | no output | exit codes of install/uninstall/fire |

> trigger / mcp.d have no stdin JSON contract (D1 §1.9/§1.10). The contract test for trigger targets only "`fire` launches `halo run <profile>` by absolute path" and the exit codes of install/uninstall, and performs no JSON Schema validation.

### 3.3 Schema Divergence Detection (TS type ↔ generated artifact)

This document specifies the "generation command and divergence detection in CI" that D1 §6.1 defers.

- **Generation**: fix the TS type → JSON Schema conversion (equivalent to `ts-json-schema-generator`) as the generation command.
- **Detection in CI**: in CI, regenerate the Schema and verify that it is **zero-diff** against the `*.json` already committed in `packages/contracts` (a diff means fail = divergence between the type and the distributed Schema). This guarantees that the two paths, "TS at compile time, non-TS via the distributed Schema," protect the same contract.

### 3.4 Example (Schema verification of gate output)

```typescript
test('gate-loop-audit fail output conforms to gate.out.json', () => {
  // Arrange
  const output = { reason: 'spec_ref not found', gate: '50-loop-audit' };
  const validate = ajv.compile(gateOutSchema); // bundled with packages/contracts
  // Act
  const valid = validate(output);
  // Assert
  expect(valid).toBe(true);
});

test('rejects gate output missing required reason', () => {
  const validate = ajv.compile(gateOutSchema);
  expect(validate({ gate: '30-test' })).toBe(false); // reason required
});
```

---

## 4. E2E (dry-run: MAX_ITER=1, smoke against real GitHub)

### 4.1 Policy

Having solidified the individual parts and contracts in ① to ③, E2E is performed as a **smoke test of the real wiring**. Because it involves non-determinism and API charges, only 1 iteration is run with a **`MAX_ITER=1` dry-run** to minimize impact scope and cost.

- **Purpose**: confirm that the wiring of real GitHub (Issue fetch, label operations, PR creation), the real executor, worktree, and runtime is connected. Not exhaustive logic coverage, but confirmation that it "actually completes one lap."
- **Scope limitation**: only 1 task and 1 lap with `MAX_ITER=1`. Run with a configuration where side effects (sink) are suppressed via dry-run (autonomy L1: `20-progress-log` only, or a draft PR), and do not perform a production-equivalent merge.
- **Tolerance of charges**: only this layer calls the real executor (`claude -p`), so charges occur. Total cost is kept down by limiting frequency (before release).

### 4.2 Smoke Inspection Items

| # | Inspection | Expected |
|---|---|---|
| 1 | task-source: fetch `ready` Issue | fetch the first Issue and relabel it to `in-progress` |
| 2 | worktree lifecycle | creation → execution → disposal of `$TMPDIR/halo-wt-issue-N` |
| 3 | runtime setup/check/test | setup materialized, exit codes (0/2) of check/test propagate |
| 4 | executor execution | `claude -p` launches and returns `status` (1 lap) |
| 5 | gate decision | gate.d runs in numeric order, pass/fail by logical AND |
| 6 | sink (dry-run config) | only sinks matching the autonomy run (L1: progress log / draft PR) |
| 7 | log / budget | `iter_1.json` generated, budget aggregation works |
| 8 | doctor | inspects existence/permissions of `gh` / `claude` / `git` and trigger liveness (precondition check) |

### 4.3 Runtime Environment

- **Target repository**: a sandbox GitHub repository dedicated to E2E (with `.harness.yml` committed). Do not target the production repository.
- **Placement (WSL2)**: place the worktree, each store, and cache on the ext4 side (under `/home`). Under `/mnt/c/` is prohibited (the placement constraint of D1 §1.7).
- **PAT**: supply a fine-grained, least-privilege PAT (PR creation + label operations only, per D4) via CI secrets.
- **Precondition**: before running, pass `halo doctor` to confirm the existence and permissions of `gh`/`claude`/`git`.

---

## 5. CI Configuration (① to ③ per PR, ④ before release)

### 5.1 Pipeline

| Job | Trigger | Content | Charge | On failure |
|---|---|---|---|---|
| unit | Per PR (required) | ① core unit tests (`vitest --coverage`) | None | Block |
| loop-regression | Per PR (required) | ② loop regression (executor mock, fixed JSON) | None | Block |
| contract | Per PR (required) | ③ contract test + Schema divergence detection (§3.3) | None | Block |
| e2e-smoke | Before release (tag / release branch) | ④ E2E dry-run (`MAX_ITER=1`, real GitHub) | Yes | Block release |

### 5.2 Gating

- **PR merge condition**: all 3 jobs unit / loop-regression / contract must be green (since ① to ③ are zero-cost, they may be required for all PRs).
- **Release condition**: in addition to the above, e2e-smoke must be green. Because E2E involves charges and non-determinism, it is not run per PR but only before release.
- **Coverage**: if the unit job falls below the §1.2 target (initial value), warn (initially warn rather than block; the threshold is confirmed according to measurement. Requirements §11.2).

### 5.3 Design Constraints for Cost and Reproducibility

| Constraint | Reason |
|---|---|
| ① to ③ are zero-cost and deterministic | Because they run on all PRs. The executor mock and Schema verification are network-independent |
| Only ④ incurs real charges, with limited frequency | Real executor calls are limited to a `MAX_ITER=1` dry-run to minimize cost |
| Schema must match the committed generated artifact | Structurally prevent divergence between the TS type and the distributed Schema in CI (D1 §6.1) |
| WSL2 placed on the ext4 side | Premise for link-based dependency sharing and the worktree (D1 §1.7) |

---

## Appendix A. Correspondence of Test Layers to D1 Contracts

| Test layer | Contract verified (D1) | Charge |
|---|---|---|
| ① core unit | decision mappings (exit code §3.1, autonomy filter §1.5, budget) | None |
| ② loop regression | loop state machine, termination conditions, retry re-injection, on-fail path (§3/§5) | None |
| ③ contract | I/O Schema of all ports (Appendix A), plugin.json, execution rules (§3) | None |
| ④ E2E | real wiring at process boundaries, worktree, runtime, real GitHub | Yes |

## Appendix B. Glossary

| Term | Definition |
|---|---|
| executor mock | A substitute process that returns fixed JSON without calling `claude -p`. Used to make loop regression zero-cost |
| contract test | A test that verifies the I/O of sample plugins against the distributed JSON Schema (D1 §6.2) |
| Schema divergence detection | A CI check for whether the Schema regenerated from the TS types matches the committed generated artifact |
| dry-run (E2E) | A smoke run of only 1 lap with `MAX_ITER=1`, suppressing side effects |
| pure-function extraction | A design that pushes side effects to the boundary and makes the input→output portion unit-testable |
