# D2. Core Detailed Design (HALO Core Design)

| Item | Content |
|---|---|
| Document version | 1.0 |
| Prerequisites | HALO Requirements Specification v1.8 / D1 Contract Specification |
| Positioning | Implementation spec for `packages/core` (public docs/architecture) |
| Public/Private | Public (OSS) |
| Status | Runs in parallel with Phase 1 implementation (may be extracted from the implementation) |

> This document builds on Requirements Specification §3 (Overall Architecture), §4.3 (Core Loop), §4.4 (Launch Layer), §8 (Directory Structure), §11 (Classification of Design Decisions), and the D1 Contract Specification (I/O types and execution conventions at process boundaries), reducing the internal design of `packages/core` to an implementable granularity. Whereas D1 defines "the contracts at process boundaries (stdin JSON / stdout JSON / exit codes)," this document defines **the module structure and algorithms inside the core (TypeScript)**. Where the two conflict, D1 and the Requirements Specification take precedence.
>
> **Restructuring from v1.5 → v1.8**: The v1.5-era materials (Design Documents 01 / 02) described the core in bash (`core/loop.sh` + `core/helpers.sh`). In v1.8 the core is implemented in **TypeScript (npm-distributed, `npx halo` / triggers invoke the absolute path `node_modules/.bin/halo` directly)**. This document removes the bash assumptions (the `helpers.sh` function set, `source`, `jq` merges, etc.) and restructures them as the responsibilities of TypeScript modules. The implementation language of plugins remains arbitrary (D1 §0), and the core communicates with plugins only across process boundaries.
>
> **Treatment of initial values**: Numeric parameters (retry limit 3 / max-turns 40 / timeout 900 sec / MAX_ITER 20 / diff 1500 lines, etc.) are treated as **adjustable initial values** per Requirements §11.2. They are not hard-coded into the core but injected from the configuration paths described in §9 below (profiles, `plugin.json`, environment variables). Values explicitly labeled "initial value" in this document are not fixed values.

---

## 1. Module Decomposition

`packages/core` is divided into 9 internal modules. Each module is high-cohesion and low-coupling, and side effects (process launch, file I/O, time retrieval) are confined to a limited set of modules. Logic that can be written as pure functions (prompt assembly, fragment merging, order sorting, budget aggregation) is separated from side effects to make it unit-testable (the testing policy is D8).

### 1.1 Module List and Responsibilities

| # | Module | Responsibility | Main side effects | Dependencies |
|---|---|---|---|---|
| 1 | `config` | Loading and normalizing profiles, environment variables, `.harness.yml`, and `plugin.json`. Resolves runtime settings (AUTONOMY / MAX_ITER / budget limits / task filters / various initial values) into a single configuration object | File reads | logger |
| 2 | `discovery` | Scanning plugins under `ports/<port>.d/`, `order` sorting, enablement determination, and upward search/resolution of `.harness.yml` | File scanning | config, logger |
| 3 | `runPort` | Launching (spawning) a single plugin, feeding JSON to stdin, receiving JSON from stdout, enforcing `timeoutSec`, forwarding stderr to logs, propagating the exit code | Process launch | logger |
| 4 | `loop` | The state machine of the core loop (§2). Drives next → context → execute → gate → sink/onFail, retry determination, and the 5 termination conditions | None (delegates to other modules) | All modules |
| 5 | `preflight` | Two-stage preflight (light / heavy, §4). STOP / lock / ready presence / remaining budget / clean working tree / graph freshness sync | File reads, git | config, budget, lock, discovery |
| 6 | `budget` | Just-in-time measurement of the daily budget (§5). Aggregates the day's actuals from `logs/` and determines the remaining amount | File reads, time | config, logger |
| 7 | `autonomy` | Matches the current AUTONOMY against each sink's `minAutonomy` and filters the sinks to execute (§2.5 / D1 §1.5) | None | config |
| 8 | `lock` | Exclusive lock to prevent concurrent launches (`$TMPDIR/halo.lock`). Acquire, release, stale detection | File lock | logger |
| 9 | `logger` | Writing to structured logs (`logs/iter_N.json`), providing the stderr forwarding destination, recording the gate pass rate | File writes | config |

> **Relationship to the CLI**: The CLI (`packages/cli`) follows the "holds no logic" principle (D3) and is a thin delegation layer that merely calls the public functions of these core modules. Triggers (`fire`) are the sole entry point that invokes the CLI, and the core knows nothing about trigger types (Requirements §4.4).

### 1.2 Enforcing Zero Global State

The requirement in §8.2 that the harness "holds no machine-global state" is guaranteed in the implementation. The core holds no persistent state in static variables or singletons; runtime state is entrusted to the following external locations.

| State | Source of truth | Handling within the core |
|---|---|---|
| Task progress (ready / in-progress / retry) | GitHub (Issue labels and comments) | Read/written via the task-source plugin. The core does not retain it |
| Exclusion | OS flock (`$TMPDIR/halo.lock`) | The `lock` module acquires it at launch and releases it at termination |
| Budget | The day's actuals in `logs/` (no ledger) | `budget` aggregates just-in-time (§5) |
| worktree | OS tmpdir (`$TMPDIR/halo-wt-issue-N/`) | Complete within create → destroy (§8) |
| Graph freshness | main's HEAD and the point of the last index | Checked in the preflight heavy stage (§4) |

---

## 2. The loop State Machine

The `loop` module implements the pseudocode of Requirements §4.3 as a TypeScript state machine. It strictly enforces one task per iteration (the fresh-context principle, Requirements §3.2), and inter-iteration state is persisted not in the core's memory but in **files / git / GitHub**.

### 2.1 State Transitions

```
                ┌─────────────────────────────────────────────┐
                │  iteration start (iter = 1..MAX_ITER)        │
                └───────────────┬─────────────────────────────┘
                                ▼
                   [PreflightLight]  STOP / lock / ready presence / remaining budget
                    │ termination condition met → terminate (§2.4)
                    ▼
                   [Next]  task-source op=next
                    │ task_id == null → terminate (TASK_EMPTY)
                    ▼
                   [PreflightHeavy]  clean working tree / graph freshness sync
                    ▼
                   [Context]  run all of context.d → merge fragments
                    ▼
                   [BuildPrompt]  task + ctx + last_gate_failure
                    ▼
                   [Execute]  executor (single, first only)
                    │ status != done (stuck/timeout)─────┐
                    ▼ status == done                       │
                   [Gate]  run all of gate.d (logical AND) │
                    │ fail (any exit 2)──────────────────┤
                    ▼ pass (all exit 0)                    │
                   [Sink]  side effects after autonomy filter│
                    ▼                                       ▼
                   [Complete]  task-source op=complete    [OnFail]  run all on-fail
                    │  last_gate_failure = empty            │  retain last_gate_failure
                    │                                       │  increment retry_count
                    └───────────────┬───────────────────────┘
                                    ▼
                          to next iteration (fresh context)
```

### 2.2 Processing of Each State

| State | Processing | Delegated to | Determination |
|---|---|---|---|
| PreflightLight | STOP file / lock / ready presence / remaining daily budget (§4.1) | preflight, lock, budget | Immediate termination if a termination condition is met |
| Next | Send `{"op":"next"}` to the task-source (first single one) | runPort | `task_id == null` → terminate |
| PreflightHeavy | Clean working tree / disk space / graph freshness sync (§4.2) | preflight | On anomaly, do not execute the task and record it |
| Context | Run all of context.d, concatenate `fragments` in descending priority order, truncate at the token limit (§2.6) | runPort (each), discovery | Always treated as success (individual failures are skipped) |
| BuildPrompt | Combine task info, concatenated context, and the reason/hint of the previous gate fail to generate a prompt | (pure function) | — |
| Execute | Feed prompt/workdir/budget to the executor (first single one) | runPort | The `status` in stdout (§2.3) |
| Gate | Run all of gate.d; if even one exits 2, the whole fails (logical AND) | runPort (each) | Exit code (0/2) |
| Sink | After the autonomy filter, execute side effects only on pass (best effort) | runPort (each), autonomy | Individual failures do not propagate to others |
| Complete | Send `{"op":"complete", task_id, pr_url}` to the task-source | runPort | Side effects only |
| OnFail | Run all on-fail (record, escalate, sign candidate) | runPort (each) | Best effort |

### 2.3 Branching by executor status

The executor's pass/fail is determined not by the exit code but by **the `status` in stdout** (D1 §1.3 / §3.1).

| status | Meaning | loop transition |
|---|---|---|
| `done` | Normal completion | Proceed to Gate |
| `stuck` | Logical dead end (STUCK marker detected) | OnFail path. Increment retry_count |
| `timeout` | `budget.timeout_sec` exceeded | OnFail path. Increment retry_count |
| (abnormal process exit) | Error | Fall to the safe side and take the failure path (OnFail) |

> Converting a STUCK marker (agent self-report) into `status: "stuck"` is the responsibility of the executor adapter (D1 §5.2); the core looks only at the `status` value. The details of marker detection are to be extracted from the Phase 1 implementation (D1 §5.2 pending).

### 2.4 Re-injection of gate fail (retry determination)

A gate fail is re-injected into the next iteration via two paths (the core of the learning path, Requirements §3.2).

1. **Immediate re-injection of the most recent reason**: The loop retains the output (`reason` / `hint` / `gate`) of the first gate that failed and passes it as input to BuildPrompt (the "previous failure" section) in the next iteration of the same task. Changing the injection strategy based on retry_count (e.g., "use a different approach than last time") is left as an extension point on the context.d plugin side (Requirements §11.2; the core merely passes the reason).
2. **Medium-term re-injection via the failure catalog**: on-fail `10-record-failure` appends to `failure-catalog.md`, and context.d (`30-recent-failures`) reads it in subsequent iterations.

**Determination of retry_count**: Management of retry_count (incrementing, threshold-reached determination, granting `needs-human`) is the responsibility of the task-source / on-fail plugins, and the source of truth is GitHub (Issue comments and labels). The core merely passes `retry_count` to the on-fail input and does not itself hold the threshold (**initial value 3**, Requirements §11.2). When the threshold is reached, on-fail `20-escalate` grants `needs-human`, and the task is no longer dispensed at the next `op=next`, which cuts off the re-injection loop (infinite-loop interruption).

### 2.5 The sink autonomy filter

In the Sink state, the `autonomy` module matches each sink's `plugin.json` `minAutonomy` (D1 §2) against the current AUTONOMY and skips sinks below the current value. A sink that has not declared `minAutonomy` is treated on the safest side (regarded as L3, i.e., skipped at L1/L2, D1 §2).

| AUTONOMY | Enabled sinks (initial configuration) |
|---|---|
| L1 | `20-progress-log` only |
| L2 | `20-progress-log` / `10-git-commit` / `15-create-pr` (**draft PR**) |
| L3 | All L2 sinks + `15-create-pr` (**normal PR**, body `Closes #number`) |

`15-create-pr` is enabled at `minAutonomy: "L2"` and reads the `AUTONOMY` env to differentiate between a draft PR at L2 and a normal PR at L3 (branching within a single sink, D1 §1.5). Autonomy is cumulative (L3 ⊇ L2 ⊇ L1).

> The v1.5 materials used the meta-comment `# min-autonomy: L3` as the declaration, but v1.8 unifies this into the `minAutonomy` field of `plugin.json` (D1 §2). The core reads `plugin.json` and filters.

### 2.6 Merging context (pure function)

Combine the `fragments` of all context.d plugins, stably sort them in descending `priority` order, truncate at the token limit (Requirements §3.2 Principle 4, initial value **under 100k**), and produce a single `{ fragments: [...] }`. **Per D1 §1.2, `priority` means "larger is higher priority," so they are concatenated in descending order (largest priority first)** (this is the opposite of some descriptions in the v1.5 materials; this document takes D1 as authoritative). A failure or malformed JSON from an individual plugin causes that plugin to be treated as empty fragments and skipped while the others continue (on the premise that missing context is detected by the gate, D1 §1.2). This combine/truncate logic is implemented as a pure function without side effects.

### 2.7 Termination Conditions (5 kinds)

The loop terminates on any one of the following 5 conditions. All follow the principle of **falling to the safe side (producing no side effects)** and terminate normally with exit 0.

| # | Termination condition | Detection point | Exit code | Notes |
|---|---|---|---|---|
| 1 | **STOP kill switch** | Check `.halo/STOP` at the start of each iteration (PreflightLight) | 0 | A kill switch placed by a human (Requirements §4.4). A separate mechanism from STUCK |
| 2 | **Daily budget exceeded** | In PreflightLight, `budget` determines there is no remaining amount | 0 | Launch but do not run (§5) |
| 3 | **Zero ready tasks** | In Next, the task-source returns `{"task_id": null}` + exit 0 | 0 | The core that makes polling-type "task-existence-driven" operation hold |
| 4 | **MAX_ITER reached** | The loop counter reaches the limit (**initial value 20**) | 0 | Total-volume control combined with the profile's TIMEOUT |
| 5 | **Execution time limit (TIMEOUT)** | At an iteration boundary, elapsed time exceeds the profile TIMEOUT | 0 | Consistency with the polling interval and prevention of resource occupation (Requirements §4.4) |

> **Configuration defects are handled separately**: Zero plugins for a single port (task-source / executor), or the absence of the required configuration (`.harness.yml`), is not a "termination condition" but an **error**. The former stops the core (no silent continuation), and the latter does not execute the task and applies `needs-human` (Requirements §4.2③ / D1 §1.8).

---

## 3. runPort Specification

`runPort` is the sole module that launches a single plugin as a process and enforces D1's execution conventions (stdin JSON / stdout JSON / exit code / stderr). The execution strategy per port type (single / run-all / merge / logical AND / best-effort) is assembled on the loop side, and runPort limits its responsibility to "launching one process and enforcing the contract."

### 3.1 Process Launch (spawn)

| Item | Specification |
|---|---|
| Launch method | Spawn the plugin's `exec` (`plugin.json`) as a child process. Launch with an argument array without going through a shell (avoiding injection) |
| Execution language | Arbitrary (bash / Python / Node). The core merely invokes the executable and does not know the plugin's language (D1 §0) |
| Working directory | The plugin's location directory, or the workdir of the target task (specified by the loop depending on the port) |
| Environment variables | Inject `plugin.json`'s `env` (`${...}` references are resolved by the core). In unattended execution, PATH is scrubbed to the Linux side only before being passed (Requirements §6.1, avoiding the Windows path inheritance problem) |

### 3.2 stdin / stdout

| Direction | Specification |
|---|---|
| stdin | Serialize one input JSON object and write it to the child process's stdin, then close with EOF |
| stdout | For ports that require output (task-source next / context / executor / gate on fail), buffer the entire stdout and parse it as one JSON. **stdout is a JSON-only channel**, and parse failures are handled per the relevant port convention (context: skip, gate: fail on the safe side, etc., D1 §6.2 core-side boundary validation) |
| Boundary validation | Validate the received stdout against the JSON Schema distributed with D1, and handle schema violations per the port convention (D1 §6.2) |

### 3.3 Enforcing timeoutSec

Each plugin's execution timeout is determined by `plugin.json`'s `timeoutSec` (when unspecified, the port's default initial value), and runPort **enforces it on the process side**.

- When the timeout is reached, a termination signal is sent to the child process (with a forced kill after a grace period), and that execution is treated as a failure.
- The executor's `budget.timeout_sec` (**initial value 900**) is the timeout for the prompt execution itself, and the path where the executor adapter returns `{"status":"timeout"}` (D1 §1.3) and runPort's process timeout form double protection. runPort's timeout is the last line of defense for the abnormal case where the adapter does not respond.

### 3.4 Forwarding stderr to Logs

stderr is for diagnostics and logs only and has no contractual meaning (D1 §3.3).

- runPort captures the child process's stderr and, via `logger`, saves it to the structured log of that iteration (`logs/iter_N.json`).
- Pass/fail is not determined by the content of stderr (determination is by exit code / status). Plugins may freely write human-readable progress and warnings to stderr.

### 3.5 Handling of Exit Codes

runPort propagates the child process's exit code to the caller (loop). The interpretation (pass/fail/error) is done on the loop side per D1 §3.1.

| Exit code | Meaning | Typical processing in loop |
|---|---|---|
| 0 | pass / normal | Continue as success |
| 2 | fail | gate: send back, runtime check/test: fail |
| Other (including 1) | Error (abnormal termination) | Fall to the safe side and treat as fail. The absence of a single-port plugin stops the core |

### 3.6 Execution Strategy per Port Type (assembled by the loop)

The 4 strategies the loop realizes by combining runPort (single-shot). These correspond to the v1.5 materials' `run_port` / `run_ports_merge` / `run_ports_all` / `run_ports_each`, but v1.8 turns them into TypeScript as functions within the loop module.

| Strategy | Target ports | Behavior | Determination |
|---|---|---|---|
| Single | task-source / executor | Run only the first one by `order` | The loop interprets the returned JSON / status |
| Merge | context | Run all; concatenate fragments in descending priority order and truncate (§2.6) | Always success (individual failures are skipped) |
| Logical AND | gate | Run all; if even one exits 2, the whole fails. Retain the reason of the first fail and re-inject | Exit code (0/2) |
| Best effort | sink / on-fail | Run all; individual failures do not propagate to others. sink runs after the autonomy filter | Side effects only |

---

## 4. Two-Stage Preflight Determination Order

To be compatible with high-frequency polling launches, preflight is split into a light stage (every time, a few seconds) and a heavy stage (only when a task actually exists) (Requirements §4.4). In the loop state machine, the light stage runs before Next (at the start of each iteration), and the heavy stage runs after Next obtains a task_id.

### 4.1 Light Stage (every time, a few seconds)

Since it runs every time even when there are zero ready tasks, it places only low-cost checks and terminates immediately (no side effects) if even one applies. The **determination order** is "cheapest and highest priority to stop first."

| Order | Check | Behavior when applicable | Delegated to |
|---|---|---|---|
| 1 | STOP file exists (`.halo/STOP`) | Immediate exit 0 (kill switch) | preflight |
| 2 | lock acquisition (`$TMPDIR/halo.lock`, flock) | Acquisition failure (concurrent launch) → immediate exit 0 | lock |
| 3 | Remaining daily budget (`logs/` day's actuals, §5) | No remaining amount → immediate exit 0 | budget |
| 4 | ready task presence (task-source `op=next`) | `task_id == null` → immediate exit 0 | runPort |

> Rationale for the order: STOP is a human's explicit intent to stop and has top priority. lock is the lowest-cost interruption of concurrent launches. The budget can be determined more cheaply than launching the task-source (process spawn), so it is placed before the ready check. The ready check launches the task-source process, so it is last.
>
> Implementation note: The lock is acquired once at launch and held (the launch-time acquisition / termination-time release of §1.2). What the light stage of each iteration actually rechecks is the two items STOP and remaining budget (`runLoop` repeatedly calls `isStopPresent` / `isBudgetOk`), and the lock is not re-acquired. #2 in the table above refers to the one-time acquisition at launch.

### 4.2 Heavy Stage (only when a task actually exists, once)

Runs only after passing the light stage and obtaining a task_id. It pays the cost only when there is an actual task.

| Order | Check | Behavior when applicable | Delegated to |
|---|---|---|---|
| 1 | git working tree clean | If there are uncommitted changes, abort this launch (record) | preflight |
| 2 | Disk space | Below the threshold, abort (worktree cannot be created) | preflight |
| 3 | Credit probe | Measure the headless consumption rate (Requirements §6.2). Abort on anomaly | preflight |
| 4 | Graph freshness sync | If main has advanced from the last index, re-index → detect staleness → auto-file a `kind:docs` issue (Plan A, Requirements §5.1 / §10) | preflight (the graph is under the jurisdiction of a private plugin) |

> **Timing of mcp.json generation**: The `.halo/mcp.json` passed to the executor is generated by merging `ports/mcp.d/*.json` (D1 §1.10). Generation is done once in the heavy stage (unnecessary in the light stage), and `--strict-mcp-config` makes it the sole MCP source. The v1.5 materials' `jq` merge is implemented in v1.8 as a deep-merge by the config/discovery module (last-wins, numeric order).

---

## 5. The budget Just-in-Time Measurement Algorithm

Per Requirements §4.4 / §8.2, the daily budget is **measured just-in-time at runtime without a ledger**. The source of truth is the day's actuals under `logs/`, and the core compares the aggregation result with the limit (specified in the profile; the initial value is left as-is) to determine the remaining amount.

### 5.1 Algorithm

```
budgetRemaining(now, profile):
  today        = local date(now)                        # the day boundary is the local timezone
  logs         = those in logs/iter_*.json whose mtime/recorded time is today
  usedIters    = count(logs)                             # number of iterations run today
  usedCost     = sum(logs[].cost.usd)                    # add if recorded (for observability, optional)
  limitIters   = profile.DAILY_MAX_ITERATIONS            # initial value (profile-defined)
  limitCost    = profile.DAILY_MAX_COST_USD              # initial value (optional, may be unset)
  ok = usedIters < limitIters AND (limitCost unset OR usedCost < limitCost)
  return ok
```

### 5.2 Design Notes

| Item | Policy |
|---|---|
| Aggregation target | `logs/iter_N.json` (the structured logs of Requirements §6.3). One file = one iteration is the basic unit |
| Day boundary | Calendar day in the local timezone. The handling when a nightly batch crosses the date boundary is, as an initial value, "the calendar day of the execution time," adjustable after measurement |
| Cost measurement | Add the executor output's `cost.usd` (ccusage-equivalent, optional). When unrecorded, determine by iteration count only (the cost limit is auxiliary) |
| Double protection | The budget is total-volume control of "launch but terminate immediately," combined with `--max-turns` / iteration timeout / MAX_ITER (Requirements §6.2) to prevent runaway in multiple layers |
| Zero global state | By not holding a ledger (cumulative counter file, etc.), we guarantee multi-project support and ease of removal (complete by deleting `.halo/`) |

> `DAILY_MAX_ITERATIONS` / `DAILY_MAX_COST_USD` are **adjustable initial values** in line with the philosophy of Requirements §11.2 and are given by the profile (§9). No fixed value is embedded in the core.

---

## 6. discovery Scanning, Sorting, and Enablement Determination

The `discovery` module scans `ports/<port>.d/` and enumerates enabled plugins in ascending `order`. It implements the "activation by directory convention (conf.d style)" of Requirements §3.2.

### 6.1 Scan Targets

Plugins are placed under `.halo/ports/<port>.d/` of Requirements §8.2 (public samples are `node_modules/@halo/plugin-*`, private ones are placed in `.halo/ports/` with an enablement link). discovery scans each port directory and treats entries that have a `plugin.json` as candidates.

| Port | Unit | Entry |
|---|---|---|
| task-source / context / executor / gate / sink / on-fail | Single file (executable + `plugin.json`) | The `exec` of `plugin.json` |
| runtime / trigger | Subdirectory bundle | runtime: `setup`/`check`/`test`, trigger: `install`/`uninstall`/`fire` (fixed names) |
| mcp.d | Configuration fragment (`*.json`) | Not a port (merged and supplied to the executor) |

### 6.2 order Sorting

- Execution order is ascending by `plugin.json`'s `order` (integer). When `order` is omitted, it follows the numeric prefix of the filename (`NN-name`).
- When numbers are identical, resolve **deterministically** by name (no non-determinism is created). Use a stable sort.
- Numbers are basically in **increments of 10**, an operation that leaves room for insertion in between.
- runtime / trigger do not have a numeric prefix. Selection is by runtime = the `.harness.yml` declaration and trigger = install (not order, D1 §1.7 / §1.9).

### 6.3 Enablement Determination

| Determination | Enabled | Disabled (kept but OFF) |
|---|---|---|
| Existence | Placed in `ports/<port>.d/` | Deleted from the directory |
| Executability | Has an executable executable + valid `plugin.json` | Evacuated with `.disabled` etc., or the executable removed |

ON/OFF for measuring effect is done by directory operations only (Requirements §3.2 Principle 2 "measure one variable at a time"), and the core / discovery is unchanged. If there are zero enabled candidates for a single port (task-source / executor), the core stops (configuration defect, §2.7).

---

## 7. Resolution Rules for Upward Search (.harness.yml)

`.harness.yml` is a **required** declaration at the root of the target repository (D1 §1.8) and determines the runtime group and prompt template from the kind. discovery resolves it by upward search.

### 7.1 Search Rules

| Item | Rule |
|---|---|
| Start point | The current directory at core execution time (any directory within the target repository is allowed) |
| Search direction | Ascend from the start point toward the parent until `.harness.yml` is found (assuming one exists at the repository root) |
| Stop | Terminate at the repository root (`.git` detected) or the filesystem root |
| When absent | If it cannot be found, do not execute the task and apply `needs-human` (no implicit auto-detection of the runtime, D1 §1.8 / Requirements §4.2③) |

### 7.2 kind Resolution

1. Obtain the Issue's `kind:<name>` label (when unspecified, `code`).
2. Look up `.harness.yml`'s `kinds.<name>` and obtain `runtimes` (one or more) and `prompt` (template path).
3. If the corresponding kind is undefined, or if any element of `runtimes` does not actually exist in `runtime.d/<name>/`, apply `needs-human` (reproducibility first).
4. When `runtimes` are multiple, the gate execution order and the handling of partial failures are pending in Requirements §11.3. This design assumes a single runtime, and for multiple specifications it stays with a naive implementation that runs setup/check/test in array order.

---

## 8. worktree Lifecycle

One Issue = one branch = one worktree. All of the AI's work is done inside an ephemeral worktree, physically separated from the human's working directory (Requirements §8.2). It applies the fresh-context principle to the filesystem as well, simplifying cleanup to "a single delete" (structurally eliminating cleanup bugs).

### 8.1 Naming Convention and Placement

| Item | Rule |
|---|---|
| Placement | `$TMPDIR/halo-wt-issue-N/` (directly under the OS tmpdir). Avoids nesting within the repository, structurally avoiding false positives in lint/glob (Requirements §8.2 volatile artifacts) |
| Naming | `halo-wt-issue-<N>` (`<N>` is the Issue number). The branch is `feature/issue-<N>` |
| Branch | Since git prohibits double-checkout of the same branch, we get collision prevention during parallelism for free |

> **Placement change from v1.5 → v1.8**: The v1.5 materials placed the worktree at `~/halo/wt/issue-N` (fixed under `/home`), but v1.8 Requirements §8.2 defines the **OS tmpdir (`$TMPDIR/halo-wt-issue-N/`)** as the location for volatile artifacts. However, since link-based dependency sharing (pnpm store / uv cache / CARGO_TARGET_DIR) is effective only within the same filesystem (Requirements §4.2⑦ / D1 §1.7 WSL2 placement constraint), `$TMPDIR` and each store/cache must be on the same FS (the ext4 side of WSL2). Placement under `/mnt/c/` is prohibited.

### 8.2 State Transitions (create → destroy)

| State | Processing | Corresponding loop state |
|---|---|---|
| Created | `git worktree add $TMPDIR/halo-wt-issue-<N> -b feature/issue-<N>` | After Next / PreflightHeavy |
| KindResolved | kind resolution of `.harness.yml` (§7). Absent/undefined → NeedsHuman | Before Context |
| SetUp | `setup` of the adopted runtime group (env injection, dependency materialization, cache externalization) | Before Context |
| Running | executor execution. Match the sandbox write boundary to the worktree (Requirements §6.1, under D4's jurisdiction) | Execute |
| GateEval | Pass the working tree's uncommitted diff to the gate | Gate |
| Failing→Running | Re-inject the gate reason and re-run (retry_count < threshold) | Gate fail → next iter |
| Passed→Sink | Passed. commit / PR creation (after the autonomy filter) | Sink |
| Removed | On pass (after PR creation) / confirmed fail / needs-human, all deleted along with traces via `git worktree remove --force` | Iteration end |

> Implementation note: The order guarantee of KindResolved / SetUp (kind resolution and runtime setup) is handled by the `createWorktree` seam (materialized on the CLI side together with worktree creation), and the `runLoop` body itself does not hold these as states. What the core receives is only the absolute path of the already-materialized worktree, and completing kind resolution / runtime selection before Context execution is the responsibility of the CLI / `createWorktree` (§1.2 delegation).

### 8.3 Centralization of Destruction

- Since the sink (commit / PR) does not run unless it passes, the conduit by which defective artifacts leak outside is centralized with **gate passage as the sole gateway**.
- Whether confirmed fail, needs-human, or stuck/timeout, changes are confined to the disposable worktree and deleted with `git worktree remove --force`. The core does not carry the worktree's contents out to the human's working directory.
- The worktree is a volatile artifact with no global state (Requirements §8.2), and cleanup when debris arises is under the jurisdiction of doctor (D3) and the runbook (D7).

---

## Appendix A. Module Dependency Diagram

```
                     ┌──────────┐
                     │   loop   │  state machine (§2)
                     └────┬─────┘
        ┌──────────┬──────┼───────┬──────────┬─────────┐
        ▼          ▼      ▼       ▼          ▼         ▼
   ┌─────────┐ ┌───────┐ ┌──────┐ ┌────────┐ ┌───────┐ ┌────────┐
   │preflight│ │runPort│ │budget│ │autonomy│ │discov.│ │ config │
   └────┬────┘ └───┬───┘ └──┬───┘ └───┬────┘ └───┬───┘ └───┬────┘
        │  ┌───────┴────────┐ │         │         │         │
        ▼  ▼                ▼ ▼         ▼         ▼         ▼
    ┌──────┐            ┌────────┐   (config is referenced by discovery /
    │ lock │            │ logger │     budget / preflight)
    └──────┘            └────────┘
```

## Appendix B. Main Changes from the v1.5 Materials

| Item | v1.5 materials (bash) | v1.8 (this document, TypeScript) |
|---|---|---|
| Core implementation | `core/loop.sh` + `core/helpers.sh` (bash, ~20 lines + 30 lines) | The 9 modules of `packages/core` (TS) |
| Port execution functions | `run_port` / `run_ports_merge` / `run_ports_all` / `run_ports_each` (helpers.sh) | runPort (single-shot) + the 4 strategy functions within loop (§3.6) |
| Autonomy declaration | Sink-leading meta-comment `# min-autonomy: L3` | `plugin.json`'s `minAutonomy` (§2.5 / D1 §2) |
| worktree placement | `~/halo/wt/issue-N` (fixed to /home) | `$TMPDIR/halo-wt-issue-N` (Requirements §8.2, same-FS constraint retained) |
| mcp.json generation | `jq -s` merge | deep-merge by config/discovery (§4.2) |
| Distribution | Local scripts | npm distribution (`npx halo` / direct invocation of the `.bin/halo` absolute path) |
| lock | `flock /tmp/harness.lock` | The `lock` module (`$TMPDIR/halo.lock`) |

## Appendix C. References

- HALO Requirements Specification v1.8 §3 (Overall Architecture), §4.3 (Core Loop), §4.4 (Launch Layer, two-stage preflight, safety mechanisms), §6 (Non-functional), §8 (Directory Structure), §11 (Classification of Design Decisions)
- D1 Contract Specification (9-port I/O types, `plugin.json`, execution conventions, kg:// URI, STUCK marker, JSON Schema generation)
- D3 CLI Specification (delegation to core functions, doctor, profile format) / D4 Security Design (sandbox, self-modification prevention) / D8 Test Strategy (unit testing of pure functions, loop regression)
