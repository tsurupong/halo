# D9: Reliability Design — Watchdog, Status Aggregation, Failure Requeue

Related: ADR-0013 (external watchdog supervisor), ADR-0014 (requeue and quarantine), D2 (core design), D3 (CLI spec), D5 (plugin dev guide), D7 (ops runbook).

## 1. Scope and goals

Three features that harden unattended overnight operation:

| # | Feature | Mechanism | Footprint |
|---|---------|-----------|-----------|
| 1 | Hang detection + recovery | `halo watchdog` supervisor process | core module + CLI command |
| 2 | Run result summary | `halo status` aggregation over `iter_N.json` | CLI only |
| 3 | Transient-failure requeue | `on-fail-requeue` plugin | plugin dir only |

Non-goals: GitHub task-source requeue, in-process supervision, changes to the loop hot path, new port kinds.

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

Flow per invocation (one-shot; scheduling is external, same model as `trigger-polling`):
1. Read lock file. No lock or pid not alive → exit 0 (nothing to supervise).
2. Read `current.json`, evaluate `isPhaseStale`.
3. Not stale → exit 0. Stale → act per `--action`:
   - `kill` (default): `killTree(pid)` — SIGTERM to the process group, grace period, then SIGKILL. `killTree` is extracted/exported from `packages/core/src/runPort.ts` (no duplicate implementation).
   - `skip`: `kill` + move the task file matching `current.json.task_id` from `.halo/tasks/queue/` to `.halo/tasks/quarantine/`.
   - `report`: detect and log only (dry-run for tuning timeouts).
4. Append a JSON line to `.halo/logs/watchdog.jsonl`: `{ts, action, pid, task_id, phase, age_sec, limit_sec}`.

Retry semantics: the watchdog never restarts the run itself; the next scheduled trigger starts a fresh run, and the task source re-supplies the task (kill) or skips it (quarantined).

### 2.4 Configuration

Profile env keys, resolved in `packages/core/src/config.ts` alongside existing keys (CLI > profile env > defaults):

| Key | Default | Meaning |
|-----|---------|---------|
| `WATCHDOG_TIMEOUT_SEC` | 1800 | default per-phase staleness limit |
| `WATCHDOG_EXECUTE_TIMEOUT_SEC` | 3600 | override for the `execute` phase (longest legitimate phase) |
| `WATCHDOG_KILL_GRACE_SEC` | 10 | SIGTERM→SIGKILL grace |

### 2.5 Failure-safety

- Verify pid liveness (`process.kill(pid, 0)`) before acting; a stale `current.json` left by a finished run must not kill an unrelated pid. Lock-file pid and hostname must match.
- Watchdog writes only `.halo/logs/` and `.halo/tasks/` — ADR-0004 surfaces untouched.

## 3. Feature 2 — Status aggregation

`iter_N.json` (written by `packages/core/src/logger.ts`) is the single source: `outcome ∈ passed|failed|escalated|no_task|stopped|aborted_env`, `gates[].reason`, `executor.status`, `retry_count`.

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

Directory `plugins/on-fail-requeue/` following the standard layout (`plugin.json` + `requeue.sh` + `test.contract.sh` + `contract.fixtures.json`), mirroring `on-fail-record`.

- `plugin.json`: `port: "on-fail"`, ordered **after** `on-fail-record` (record first so the catalog entry always exists even if requeue fails).
- Input (stdin JSON, existing `OnFailIn`): `{task_id, reason, retry_count, gate?, workdir?}`.
- Logic (`requeue.sh`):
  1. Classify `reason` against transient patterns: `rate.?limit|429|flaky|ECONNRESET|ETIMEDOUT|ENETUNREACH|timed?.?out|temporar`. Non-transient → exit 0 (record-only path).
  2. Counter: `count=$(cat .halo/requeue/<task_id>.count 2>/dev/null || echo 0)`; increment and write back.
  3. `count < REQUEUE_MAX_ATTEMPTS` (default 3) → `mv` the task file from wherever the loop moved it after failure back to `.halo/tasks/queue/`; else `mv` to `.halo/tasks/quarantine/` and remove the counter.
  4. Missing task file → exit 0 (already handled elsewhere; on-fail is best-effort).
  5. stdout empty, always exit 0 on handled paths (loop treats on-fail as fire-and-forget).
- Env: `HALO_TASKS_DIR` (default `.halo/tasks`), `HALO_REQUEUE_DIR` (default `.halo/requeue`), `REQUEUE_MAX_ATTEMPTS` (default 3) — resolved by the shell with defaults, overridable via profile env.
- Contract fixtures: transient-below-limit (task returns to queue, counter=1), transient-at-limit (task in quarantine, counter removed), non-transient (no fs change), missing task file (exit 0).

Open dependency to verify during implementation: where the local task source moves a failed task file (queue → in-progress → failed?). The `mv` source path in step 3 must match `task-source-local`'s actual layout; the contract test pins this.

## 5. Test strategy

- `packages/core`: `watchdog.test.ts` — staleness boundaries (exact limit, idle phase, missing file), per-phase overrides, verdict fields. No processes involved.
- `packages/cli`: `watchdog.command.test.ts` — injected fake fs/pid-check/kill; asserts kill called only when lock pid alive AND stale; `skip` moves the right file. `status.test.ts` — `aggregateRuns` over fixture `iter_N.json` sets (counts, categories, `--days` filter).
- `plugins/on-fail-requeue`: `test.contract.sh` over the four fixtures; runs under `pnpm test:contract`.
- E2E (manual): `report` mode against a live selfhost run to tune timeouts before enabling `kill`.

## 6. Rollout and rollback

- Order: Feature 2 (read-only) → Feature 3 (plugin, removable by dir deletion) → Feature 1 in `report` mode → Feature 1 `kill` mode after timeout tuning.
- Rollback: each feature is an independent commit; `git revert` suffices. Deleting `plugins/on-fail-requeue/` fully removes Feature 3 (discovery scans existing dirs only). Watchdog unscheduled = inert.
