# D9: Reliability Design — Watchdog, Status Aggregation, Failure Requeue, Shutdown

Related: ADR-0013 (external watchdog supervisor), ADR-0014 (requeue and quarantine), ADR-0022 (graceful shutdown on signal), ADR-0023 (watchdog scheduling and heartbeat), D2 (core design), D3 (CLI spec), D5 (plugin dev guide), D7 (ops runbook).

**Document version**: 1.1 (2026-07-28: §2.3 default action corrected to `report`; §2.6 scheduling and §2.7 heartbeat added per ADR-0023; §5 graceful shutdown added per ADR-0022; former §5/§6 renumbered to §6/§7).

## 1. Scope and goals

Five features that harden unattended overnight operation:

| # | Feature | Mechanism | Footprint | Section |
|---|---------|-----------|-----------|---------|
| 1 | Hang detection + recovery | `halo watchdog` supervisor process | core module + CLI command | §2.1-2.5 |
| 2 | Run result summary | `halo status` aggregation over `iter_N.json` | CLI only | §3 |
| 3 | Transient-failure requeue | `on-fail-requeue` plugin | plugin dir only | §4 |
| 4 | Supervisor scheduling + liveness | `halo watchdog install` + heartbeat + `doctor` check | CLI only | §2.6-2.7 |
| 5 | Graceful shutdown | SIGINT/SIGTERM → cooperative abort of the run | core loop + `runPort` + CLI | §5 |

Feature 4 is documented inside §2 rather than in a chapter of its own: it adds no new detection logic, only the scheduling and observability that feature 1 assumed and never got.

Features 1-3 shipped in v0.2.0. Features 4-5 close two gaps found by the 2026-07-28 review: the supervisor of feature 1 was never scheduled by anything (ADR-0023), and no signal handler existed, so every signal — including the supervisor's own `kill` — bypassed the cleanup `finally` blocks (ADR-0022).

Non-goals: GitHub task-source requeue, in-process supervision, changes to the loop hot path, new port kinds, fixing the schtasks profile-keyed namespace for the general two-triggers-one-profile case (ADR-0023 §Risks).

## 2. Feature 1 — Watchdog

### 2.1 Observable state (existing)

- `.halo/logs/current.json` (`PhaseState {iter, task_id, phase, updated_at}`) — rewritten at every phase boundary by `markPhase` (`packages/core/src/phase.ts`).
- Run lock file (`defaultLockPath(tmpdir, profile)`) — contains the run process pid (`packages/cli/src/core-ext/run-wiring.ts`).

### 2.2 Detection (core, pure)

New `packages/core/src/watchdog.ts`:

```ts
export interface WatchdogTimeouts { defaultSec: number; perPhase?: Partial<Record<LoopPhase, number>>; }
export interface StaleVerdict { stale: boolean; phase: LoopPhase; ageSec: number; limitSec: number; }
export function isPhaseStale(state: PhaseState, now: Date, timeouts: WatchdogTimeouts): StaleVerdict;
```

Rules:
- `phase === "idle"` is never stale (loop is waiting by design).
- Missing/unparseable `current.json` → not stale (no run in progress or log unavailable; the lock check below decides).
- `ageSec = now - updated_at`; stale when `ageSec > (perPhase[phase] ?? defaultSec)`.

No fs/clock access inside the function — callers inject both (same style as `phase.ts` / `logger.ts`).

### 2.3 Supervisor command (CLI)

New `packages/cli/src/commands/watchdog.ts`, registered in the `index.ts` dispatch switch, HELP text, and `VALUE_FLAGS`.

Flow per invocation (one-shot; scheduling is external — see §2.6):
1. Read lock file. No lock, pid not alive, or a different host → exit 0 (nothing to supervise).
2. Read `current.json`, evaluate `isPhaseStale`.
3. Not stale → write the heartbeat (§2.7) and exit 0. Stale → act per `--action`:
   - `report` (**default**): detect and log only (dry-run for tuning timeouts).
   - `kill`: `killTree(pid)` — SIGTERM to the process group, grace period, then SIGKILL. `killTree` is extracted/exported from `packages/core/src/runPort.ts` (no duplicate implementation).
   - `skip`: `kill` + move the task file matching `current.json.task_id` from `.halo/tasks/queue/` to `.halo/tasks/quarantine/`.
4. Append a JSON line to `.halo/logs/watchdog.jsonl`: `{ts, action, pid, task_id, phase, age_sec, limit_sec}`.
5. Write the heartbeat (§2.7) on every path, including the early exits of step 1.

> **Default corrected (2026-07-28).** v1.0 of this document named `kill` as the default; the implementation has always defaulted to `report` (`packages/cli/src/commands/watchdog.ts:115`). The implementation is correct and this text now matches it: §7 mandates a report-first rollout, and the module's governing principle is 誤殺より見逃し — prefer missing a hang over killing a healthy run. Recovery actions are opted into explicitly, and `halo watchdog install` requires `--action` for exactly that reason (ADR-0023).

Retry semantics: the watchdog never restarts the run itself; the next scheduled trigger starts a fresh run, and the task source re-supplies the task (kill) or skips it (quarantined).

Interaction with graceful shutdown (§5): the SIGTERM of `kill` is now caught by the run, which unwinds cooperatively and records the iteration as `aborted_signal` — neutrally, without incrementing `retry_count`. The wedge itself remains recorded in `watchdog.jsonl`, which is the durable evidence; escalation of a genuinely bad task continues to come from the task-source's own failure accounting, not from the kill.

### 2.4 Configuration

Profile env keys, resolved in `packages/cli/src/commands/watchdog.ts` (M4, 2026-08-02): **process env > `--profile`'s `.halo/profiles/<name>.env` > defaults**. `resolveWatchdogEnv` reads the profile file with the same `parseEnvFile` used by `status.ts`'s `resolveProfileLimits`, merges it under the process environment, and passes the result to `envInt`. A missing `--profile` or a missing/unreadable profile file both fall back to defaults without failing the run — the watchdog must never abort on a profile-resolution error.

| Key | Default | Meaning |
|-----|---------|---------|
| `WATCHDOG_TIMEOUT_SEC` | 1800 | default per-phase staleness limit |
| `WATCHDOG_EXECUTE_TIMEOUT_SEC` | 3600 | override for the `execute` phase (longest legitimate phase) |
| `WATCHDOG_KILL_GRACE_SEC` | 10 | SIGTERM→SIGKILL grace |

### 2.5 Failure-safety

- Verify pid liveness (`process.kill(pid, 0)`) before acting; a stale `current.json` left by a finished run must not kill an unrelated pid. Lock-file pid and hostname must match.
- Watchdog writes only `.halo/logs/` and `.halo/tasks/` — ADR-0004 surfaces untouched.

### 2.6 Scheduling the supervisor (ADR-0023)

The supervisor is inert unless something invokes it periodically, and until 2026-07-28 nothing did. `halo watchdog` gains two subcommands that drive the existing scheduler abstraction (`packages/plugins/src/lib/scheduler.ts`, ADR-0015) — the same one `halo trigger install` uses, so schtasks / systemd / cron / launchd are all covered without new backend code.

```
halo watchdog install --action <report|kill|skip> [--profile <name>] [--every <N>m]
halo watchdog uninstall [--profile <name>]
```

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| Scheduler identity | `trigger = "watchdog"`, profile key = `<profile>-watchdog` | The schtasks backend names tasks `HALO_${profile}` from the profile alone and deletes an existing task of that name before creating one (`scheduler.ts:176-178`). Registering under the bare profile would silently unregister the run trigger on Windows. |
| Real profile | passed inside the registered command as `--profile <profile>` | The supervisor resolves the lock path with `defaultLockPath(tmpdir, profile)`; it must see the true profile, not the suffixed scheduler key. |
| `--action` | **required, no default** | The failure being fixed is a supervisor that exists and does nothing. A registration defaulting to `report` reproduces it one level up. |
| `--every` | default `5m` → `interval:5` | One invocation is a handful of filesystem reads. Detection latency is `interval + phase timeout`, and phase timeouts are 1800 s / 3600 s, so a 5-minute poll is negligible against them. Adjustable per ADR-0012. |

`halo trigger list` does **not** show the result: it enumerates `.halo/ports/trigger.d/` plugin directories (`packages/core/src/triggers.ts:138-150`), not scheduler-backend entries. Visibility comes from the heartbeat below instead.

> **Argv validation (fixed 2026-07-28).** `schedulerInstall` validates every `fireArgv` element against `SAFE_ARGV_RE` before quoting it into the backend command. That class excluded `@`, so any path under `node_modules/@tsurupong/...` was rejected — which meant `halo trigger install` never worked on an npm-installed HALO, only from the monorepo where paths contain no `@`. `@` is now allowed; `$`, `` ` ``, `\`, `%`, `&`, `<`, `>`, `"` stay rejected, and a regression test pins both halves.

### 2.7 Heartbeat and liveness check (ADR-0023)

A healthy supervisor is silent — `watchdog.jsonl` is only appended on the stale branch — so "never scheduled" and "scheduled, nothing wrong" are indistinguishable from the logs. Every invocation therefore overwrites a single-object heartbeat, in the same style as `current.json`:

`.halo/logs/watchdog-last.json`

```ts
interface WatchdogHeartbeat {
  ts: string;          // ISO-8601, invocation time
  stale: boolean;      // isPhaseStale verdict (false when there was nothing to supervise)
  phase: LoopPhase | null;   // null when no lock / no current.json
  age_sec: number | null;
  limit_sec: number | null;
  action: WatchdogAction;    // the --action this invocation was configured with
  acted: boolean;      // whether a kill/quarantine actually ran
}
```

`watchdog.jsonl` keeps its append-only detection semantics unchanged; the heartbeat is bounded (one file, overwritten) so a 5-minute cadence costs nothing.

`halo doctor` gains a check: the heartbeat exists and `now - ts` is within twice the registered interval. This proves the schedule *fires*, which querying a scheduler registry would not — and it needs no per-backend query implementation. The check **reports only**: a suspended WSL2 VM produces a stale heartbeat for benign reasons (D7 §troubleshooting), so acting on it would be a false positive.

## 3. Feature 2 — Status aggregation

`iter_N.json` (written by `packages/core/src/logger.ts`) is the single source: `outcome ∈ passed|failed|escalated|no_task|stopped|aborted_env|aborted_signal`, `gates[].reason`, `executor.status`, `retry_count`.

> `aborted_signal` is added by ADR-0022 (§5). `aggregateRuns` must count it under `byOutcome` and must **not** fold it into a failure category — an operator-initiated stop is not a task failure, and letting it land in `other` would inflate the failure signal of any profile that is routinely stopped by its scheduler.

New pure function in `packages/cli/src/commands/status.ts` (beside `loadLastRun`):

```ts
interface RunAggregate {
  total: number;
  byOutcome: Record<string, number>;
  failureCategories: Record<string, number>; // rate_limit | flaky_test | network | timeout | gate:<name> | other
  windowDays: number;
}
function aggregateRuns(entries: IterationLog[]): RunAggregate;
```

- Categorization: `executor.status` (`timeout`/`stuck`) first, then first matching transient regex on `gates[].reason`, else `gate:<gate name>`, else `other`. The regex list is shared conceptually with `on-fail-requeue` but duplicated intentionally (shell plugin vs TS CLI; contracts stay independent).
- CLI surface: `halo status` gains a summary block; `--json` includes the `RunAggregate` object; new optional `--days <n>` (default 7) filters by iter timestamp.
- File loading reuses `isIterationLogName` from core; directory scan stays in the command (fs injected for tests, same as `loadLastRun`).

## 4. Feature 3 — on-fail-requeue plugin

Directory `plugins/on-fail-requeue/` following the standard layout (`plugin.json` + `contract.fixtures.json`), mirroring `on-fail-record`. The implementation is TypeScript in `packages/plugins/src/on-fail-requeue/` with a co-located Vitest file (ADR-0017/0018 — the original `requeue.sh` + `test.contract.sh` layout is superseded).

- `plugin.json`: `port: "on-fail"`, ordered **after** `on-fail-record` (record first so the catalog entry always exists even if requeue fails).
- Input (stdin JSON, existing `OnFailIn`): `{task_id, reason, retry_count, gate?, workdir?}`.
- Logic (`main.ts`):
  1. Classify `reason` against transient patterns: `rate.?limit|429|flaky|ECONNRESET|ETIMEDOUT|ENETUNREACH|timed?.?out|temporar`. Non-transient → exit 0 (record-only path).
  2. Counter: `count=$(cat .halo/requeue/<task_id>.count 2>/dev/null || echo 0)`; increment and write back.
  3. `count < REQUEUE_MAX_ATTEMPTS` (default 3) → `mv` the task file from wherever the loop moved it after failure back to `.halo/tasks/queue/`; else `mv` to `.halo/tasks/quarantine/` and remove the counter.
  4. Missing task file → exit 0 (already handled elsewhere; on-fail is best-effort).
  5. stdout empty, always exit 0 on handled paths (loop treats on-fail as fire-and-forget).
- Env: `HALO_TASKS_DIR` (default `.halo/tasks`), `HALO_REQUEUE_DIR` (default `.halo/requeue`), `REQUEUE_MAX_ATTEMPTS` (default 3) — resolved by the shell with defaults, overridable via profile env.
- Contract fixtures: transient-below-limit (task returns to queue, counter=1), transient-at-limit (task in quarantine, counter removed), non-transient (no fs change), missing task file (exit 0).

**Resolved during implementation**: `task-source-local` leaves a failed task in `queue/` (it only moves it to `needs-human/` on reaching its own threshold), so the file is normally already at the destination and step 3 is a no-op move. The plugin therefore searches every `$HALO_TASKS_DIR/*/` subdirectory before giving up. Note that the escalation threshold is now evaluated by `task-source-local` against a **persisted** count (`.halo/tasks/retry/<id>.count`), not the per-run `retry_count`; `on-fail-requeue`'s own counter under `.halo/requeue/` is independent and bounds only the transient-requeue path.

## 5. Feature 5 — Graceful shutdown (ADR-0022)

### 5.1 The gap

Every cleanup in a run is a JavaScript `finally` — lock release (`run-wiring.ts:553-555`), worktree removal (`loop.ts:696-698`), phase reset to `idle` (`loop.ts:424-427`). No signal handler exists anywhere under `packages/`, so Node's default disposition terminates the process and skips all three. A signal-terminated run leaks a worktree, holds its lock until stale-reclaim (owner-dead, or six hours — `lock.ts:80-86`), and freezes `current.json` at a non-`idle` phase, which is precisely the input a later `halo watchdog` reads.

The signal sources are routine, not exotic: the watchdog's own `kill` action (§2.3), `systemctl stop` / `schtasks /End`, a host reboot, and an operator's Ctrl-C.

### 5.2 Mechanism

An `AbortSignal` is threaded from the CLI down two levels; nothing polls and no timer is added.

| Layer | Change |
|-------|--------|
| `packages/cli` (`run.ts` / dispatch) | Install SIGINT + SIGTERM handlers. First signal: `controller.abort()` and one stderr line. Second signal: `process.exit(128 + signum)` immediately, no cleanup. |
| `packages/core/src/loop.ts` | `LoopDeps.abort?: AbortSignal`. Checked at the iteration boundary (alongside `isStopPresent`) and immediately after the executor returns. On abort → `finish('ABORTED_SIGNAL')`, unwinding through the existing `finally` that removes the worktree. |
| `packages/core/src/runPort.ts` | `RunPortInput.signal?: AbortSignal`. On abort, reuse `killTree` (SIGTERM → `killGraceMs` → SIGKILL on the process group) and mark the result aborted. |

Stop latency is bounded by `RUN_PORT_DEFAULTS.killGraceMs` (5 s), not by `executorTimeoutSec` (900 s + 30 s grace).

### 5.3 Recording semantics

The interrupted task is recorded **neutrally**:

- iteration `outcome: "aborted_signal"`, new terminal reason `ABORTED_SIGNAL`;
- **no** `retry_count` increment and **no** `op=fail` to the task-source;
- the task stays where the task-source left it and is re-supplied on the next run.

The reason is failure-budget hygiene: a nightly window closing or a `systemctl stop` must not consume a healthy task's retries and escalate it to `needs-human` after three routine stops. The wedge case that motivates the watchdog remains recorded in `watchdog.jsonl`.

### 5.4 Exit code

`ABORTED_SIGNAL` maps to exit **0** — a legitimate non-execution, joining `STOP` / `NO_TASK` / `TIMEOUT` / `BUDGET_EXCEEDED` rather than the `ABNORMAL_END_REASONS` set (`packages/cli/src/commands/run.ts:87-96`). This keeps `systemctl stop` a success from the service manager's point of view. The trade-off is stated in ADR-0022 §Negative: exit code alone no longer distinguishes "stopped" from "finished", and the iteration log carries that distinction instead.

### 5.5 Failure-safety

- The handler does no filesystem work — it flips the controller and prints. All cleanup runs on the normal unwind path, where the existing error handling already applies.
- A cleanup that itself wedges is escapable by the second signal.
- Abort during `sink` can leave a commit created but `op=complete` unsent; the task stays in-progress and the next run re-supplies it. This is the pre-existing crash window (`loop.ts:636-637`), not a new one.

## 6. Test strategy

- `packages/core`: `watchdog.test.ts` — staleness boundaries (exact limit, idle phase, missing file), per-phase overrides, verdict fields. No processes involved.
- `packages/cli`: `watchdog.command.test.ts` — injected fake fs/pid-check/kill; asserts kill called only when lock pid alive AND stale; `skip` moves the right file. `status.test.ts` — `aggregateRuns` over fixture `iter_N.json` sets (counts, categories, `--days` filter).
- `on-fail-requeue`: a Vitest file over the four fixtures, spawning the built entry exactly as `runPort` does; runs under `pnpm test:contract`.
- E2E (manual): `report` mode against a live selfhost run to tune timeouts before enabling `kill`.

Features 4-5:

- Feature 4 (`packages/cli`): `install` rejects a missing `--action` (exit 3); the scheduler seam receives `trigger="watchdog"`, profile key `<profile>-watchdog`, `interval:<N>`, and a command carrying the **unsuffixed** `--profile` — the regression that a Windows install would otherwise unregister the run trigger. Heartbeat written on all four exit paths (no lock / dead pid / not stale / stale+acted). `doctor.test.ts` — missing heartbeat and an over-age heartbeat both report without failing the run.
- Feature 5 (`packages/core`): `runPort` aborts an in-flight child through `killTree` and resolves with the abort flag set (fake spawn, no real processes). `loop.test.ts` — an abort signalled at the iteration boundary and one signalled during `execute` both end `ABORTED_SIGNAL`, call `removeWorktree`, mark the phase `idle`, and leave `retry_count` unchanged with no `op=fail` runner call. `packages/cli`: `ABORTED_SIGNAL` maps to exit 0; second-signal path exits `128+signum` (handler unit-tested through an injected exit seam, not by signalling the test runner).
- E2E (manual): `halo run` under a real SIGTERM — assert the worktree is gone, the lock file is released, and `current.json` reads `idle`.

## 7. Rollout and rollback

- Order: Feature 2 (read-only) → Feature 3 (plugin, removable by dir deletion) → Feature 1 in `report` mode → Feature 5 (shutdown; must precede any scheduled `kill`, so that a kill lands on a run that can clean up after itself) → Feature 4 `install --action report` → Feature 1/4 `kill` mode after timeout tuning.
- Rollback: each feature is an independent commit; `git revert` suffices. Deleting `plugins/on-fail-requeue/` fully removes Feature 3 (discovery scans existing dirs only). `halo watchdog uninstall` fully removes Feature 4's host-side state; watchdog unscheduled = inert. Feature 5 reverts to the previous behaviour by removing the handler registration alone — the `abort` parameters are optional at every layer.
