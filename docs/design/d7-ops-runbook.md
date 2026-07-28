# D7. Operations Runbook

| Item | Content |
|---|---|
| Document version | 0.1 (skeleton) |
| Premise | [HALO Requirements Specification](../../../docs/HALO要件定義書.md) v1.8 is the top-level document (this document translates the operational aspects of §6.2 / §7 / §9 / §11.2 into practical procedures) |
| Positioning | Public (high value as an operations example) |
| Constraint | **Measured values are to be filled in after actual operation in Phase 1-2**. This document is a skeleton; only the structure of procedures and the record templates are fixed first. Numeric values such as thresholds, rates, and durations remain as "fill in after measurement" placeholders (placing numbers first would create false precision. Requirements Specification §11.2) |
| Related documents | [D2 Core Detailed Design] / [D3 CLI Specification] / [D4 Security Design](./d4-security-design.md) / [D8 Test Strategy] / [ADR-006 Autonomy L1-L3] / [ADR-0012 Do not fix numeric parameters in advance] |
| Runtime environment | Assumes WSL2 / Arch Linux. The CLI is `packages/cli` (the `halo` command), the core is `packages/core` (TypeScript) |

Following the philosophy of Requirements Specification §11.2 (**a threshold without measurement is false precision**), this document takes the stance of "extracting" procedures and numbers from actual Phase 1-2 operation. Accordingly, this skeleton **fixes the record templates first**, and later confirms promotion thresholds, monitoring rates, and troubleshooting procedures from the measured data accumulated there.

> **Fill-in convention**: `〔fill in after measurement〕` in this document is a placeholder left blank until the Phase 1-2 operational data is available. Numbers, thresholds, durations, and frequencies should only be filled in here after measurement. The structure (order of procedures, fields of record templates) may be fixed at the skeleton stage.

---

## 1. Operating Autonomy Promotion and Demotion

The autonomy level `AUTONOMY` (L1 = report only / L2 = commit + draft PR / L3 = unattended PR creation) is a runtime parameter of the sink filter (ADR-006), and promotion/demotion is completed **solely by changing an environment variable (the profile's `AUTONOMY`)**. The judgment is made by a human, and logs serve strictly as the primary data (Requirements Specification §11.2).

### 1.1 L1 Scoring Procedure

Immediately after introducing a new loop or new plugin, always run in observation mode at L1 (e.g., the `daytime-l1` profile). Every business day, a human scores the previous day's L1 execution results.

| Step | Operation | Reference |
|---|---|---|
| 1 | Check the previous day's L1 execution summary (number of iterations, outcome breakdown) with `halo status` | D3 status |
| 2 | Read each `iter_N.json` (`outcome` / `gates` / plan report) in `logs/` for that day, one at a time | D6/06 Observability |
| 3 | Record the "validity of the plan" for each iteration using the scoring template in §1.2 below | §1.2 |
| 4 | Append the validity rate and findings to `logs/scoring/<date>.md` (template below) | §1.2 |

- The scoring target is "whether the plan/execution result produced by the AI is of a quality a human can approve." Because L1 leaves only plan reports rather than code changes as artifacts, scoring is an **evaluation of judgment quality**.
- **Do not hardcode the promotion threshold on the log side** (Requirements Specification §11.2). The threshold is set only after the measured columns of §1.3 are filled in.

### 1.2 L1 Scoring Record Template

One file per day at `logs/scoring/<YYYY-MM-DD>.md`. Record one line per iteration.

```markdown
# L1 scoring — <YYYY-MM-DD> (scorer: <name>)

| iter | task_id | kind | plan validity | correction needed | notes |
|------|---------|------|:-----------:|:---------:|------|
| 1    | #123    | code | valid / needs fix / rejected | none / minor / major | <one line> |

## Daily summary
- scored count: <n>
- valid rate: <valid / scored count> (%)
- major errors: <n> (details: ...)
- impressions: <qualitative notes relevant to the promotion decision>
```

| Field | Meaning | Possible values |
|---|---|---|
| Plan validity | Whether the AI's plan/result meets the approval bar | `valid` / `needs fix` / `rejected` |
| Correction needed | How much human intervention was required | `none` / `minor` / `major` |
| Validity rate | The primary (provisional) metric for the promotion decision | Aggregate value |

### 1.3 Promotion Decision

Promotion from L1 → L2 → L3 is decided by a human once a certain amount of scoring data has accumulated. The staging follows the measurement-based principle of Requirements Specification §11.2.

| Decision item | Handling in the skeleton | Value confirmed after measurement |
|---|---|---|
| Number of scored nights required for promotion | At Phase 2 completion (10 nights of measurement is the target) | 〔fill in after measurement〕 |
| Validity-rate promotion threshold | Planned to be set as "validity rate N% or higher for M consecutive nights" | N = 〔fill in after measurement〕 / M = 〔fill in after measurement〕 |
| Tolerance for major errors | 0 in principle (a major error resets promotion) | 〔confirm after measurement〕 |
| Additional condition for L2→L3 | Decided by the review approval rate of draft PRs | 〔fill in after measurement〕 |

- Promotion is not irreversible. If quality drops after promotion, a human may demote at their discretion.
- Changes to the harness itself (dogfooding) are **permanently capped at L2** (human approval required, Requirements Specification §11.1). This cap is outside the scope of the promotion decision, and loop-audit ⑤ definitively blocks it at the gate layer (D4 §4).

### 1.4 Immediate Demotion to L1 on a Serious Incident

**A single serious incident (detection of self-modification or an attempt to access secrets) demotes immediately to L1** (Requirements Specification §11.2, confirmed). Demotion thresholds based on gate pass rate are set after measurement.

| Step | Operation |
|---|---|
| 1 | Confirm incident detection (loop-audit ⑤/⑦ fail, PreToolUse hook #4/#5/#8 firing, logs with `needs-human` applied) |
| 2 | Change the running profile's `AUTONOMY` to `L1` (environment variable only). If necessary, place `.halo/STOP` for an immediate stop |
| 3 | Check for and remove remnants of the relevant worktree (§5.4). If leakage is suspected, immediately revoke and rotate the PAT (D4 §3, security rules) |
| 4 | Record the incident in the §3 failure-catalog and in `logs/incidents/<date>.md` (template below) |
| 5 | Keep L1 pinned until root-cause correction (review of PROMPT / hook / deny). Recovery again follows the promotion procedure of §1.3 |

**Incident record template** `logs/incidents/<YYYY-MM-DD>.md`:

```markdown
# Incident — <ISO8601>
- type: self-modification detected / secret access attempt / other
- detection path: loop-audit⑤ / PreToolUse#N / ...
- task_id: #<n> (worktree: <path>)
- impact scope: <where it touched / whether leaked>
- immediate response: status of L1 demotion / STOP / PAT rotation
- permanent fix: <changes to PROMPT/hook/deny> (adoption is a human gate)
```

---

## 2. needs-human Handling Flow

The `needs-human` label is applied by on-fail `20-escalate` (three fails on the same Issue, tentative) or by a kind-resolution failure (e.g., missing `.harness.yml`), and is the **exit** from the loop to a human (Requirements Specification §7-6). Subsequent processing is handled by a human.

### 2.1 Handling Flow

```
needs-human applied
  ├─ cause classification (table below)
  │    ├─ spec ambiguous/wrong     → fix spec → return to ready (§2.2)
  │    ├─ task too large           → split task (§2.3)
  │    ├─ environment/config issue → fix .harness.yml etc. → return to ready
  │    └─ high implementation difficulty → human implements or defers
  └─ after handling: remove needs-human / close
```

### 2.2 Specification Fix → Return to ready

- Review the Issue body and spec_refs (frozen requirements on the graph) and correct any ambiguity or errors. Since requirements are centrally managed on the graph, specification fixes go through the two graph-write paths (manual human work / sink 35, D4 §5).
- After correction, remove `needs-human`, reapply `ready`, and return it to the queue. If `in-progress` remains, clear it.
- Check the gate reason history (`gate_failure.json` / failure-catalog) and make explicit on the specification side the points where the AI repeatedly got stuck.

### 2.3 Criteria for Deciding to Split a Task

| Decision material | Guideline for considering a split | Handling in the skeleton |
|---|---|---|
| loop-audit ⑥ diff line-count fail | Repeatedly hitting the 1500-line cap (§11.1, confirmed) | Confirmed threshold. Split if overruns become the norm |
| Reason trend of 3 fails | Multiple independent correction points are demanded simultaneously | Split into separate Issues per independent point |
| Scope covered by spec_refs | One task spans multiple aggregates | Split by aggregate unit |
| Average iterations per task | Exceeds 〔fill in after measurement〕 | Standardize after measurement |

- After splitting, apply `ready` to each child Issue; whether the parent Issue is kept for tracking or closed is decided operationally.

---

## 3. Reading the failure-catalog and Operating sign Promotion

The failure-learning loop is a closed loop of "failure → record in `failure-catalog.md` → sign candidate in `signs-proposed.md` → **reflected into PROMPT by human judgment**" (03/06). Because directly appending to PROMPT would violate the ban on self-modification (ADR-0004), sign adoption must always pass through a human gate (Requirements Specification §7).

### 3.1 How to Read failure-catalog.md

`harness/failure-catalog.md` is an incident ledger appended to by on-fail `10-record-failure`.

| Focus point | What to read |
|---|---|
| Distribution of failing gates (`gate`) | Which gate (30-test / 40-ai-review / 50-loop-audit, etc.) gets stuck. A bias suggests insufficient runtime configuration or PROMPT |
| Repetition of reasons | If the same kind of reason recurs, it is a candidate for turning into a sign |
| Correlation with task kind | Whether failure tendencies differ between code / docs (material for tuning per-kind PROMPT) |
| Blanks in the handling column | Unaddressed incidents. Filled in by a human or by suggest-sign |

### 3.2 signs-proposed.md → Human Judgment for Reflecting into PROMPT

A human reviews the candidates generated by on-fail `30-suggest-sign` (`signs-proposed.md`) and reflects only the adopted ones into `PROMPT.md` / `prompts/<kind>.md`.

| Step | Operation |
|---|---|
| 1 | Read each candidate in `signs-proposed.md` and verify its validity by tracing back to the actual incident in failure-catalog it corresponds to |
| 2 | Decide whether to adopt (criteria in the table below). Only adopted items are manually appended to PROMPT by a human (graph/file writes go through the human path) |
| 3 | Track in the subsequent failure-catalog whether the reflected sign suppressed recurrence of the same kind of failure |
| 4 | Remove reflected candidates from `signs-proposed.md` (or clearly mark them adopted/rejected) |

**Criteria for adopting a sign (skeleton)**:

| Criterion | Leans toward adoption | Leans toward rejection |
|---|---|---|
| Generality | A permanent instruction effective across multiple tasks | Circumstances specific to a single task |
| Specificity | "Do this next time" is clear | Vague, with much room for interpretation |
| Side effects | Does not contradict existing PROMPT | Could suppress other correct behaviors |
| Recurrence frequency | Repeated 〔fill in after measurement〕 times or more | A one-off failure |

- Full-scale operation of sign reflection begins in Phase 2 (Requirements Specification §9). Quantitative evaluation of the reflection effect (reduced recurrence) is filled in once measured data is available.

---

## 4. Budget Monitoring

The daily budget is computed each time from that day's actuals in `logs/`, and on overrun the process terminates immediately even if launched (04/06, Requirements Specification §6.2). It holds no fixed counter; the logs are the single source of truth.

### 4.1 How to Read status

| Check item | What to look at in `halo status` | Judgment |
|---|---|---|
| Today's iteration actuals | `USED` (count of completed records for the day) and `DAILY_MAX_ITERATIONS` | `USED` approaching the cap = the day is near its limit |
| Activity per profile | Whether continuous / daytime-l1 / nightly ran | Check for activity from unexpected profiles |
| Cost estimate | `executor.cost` in `iter_N.json` (ccusage-equivalent, optional field) | Grasp the trend of the consumption rate |
| Monthly projection | Extrapolation of daily actuals × operating days | If projected to exceed $200, consider switching to API key + spend limit (Requirements Specification §6.2) |

### 4.2 Handling Overruns

| Event | Handling |
|---|---|
| Daily budget overrun (`USED >= DAILY_MAX_ITERATIONS`) | For that day, launch is automatically suppressed in preflight. If additional consumption is needed, a human temporarily raises `DAILY_MAX_ITERATIONS` (profile env). Permanent adjustment is measurement-based |
| Consumption rate exceeds expectations | Tighten the profile's `MAX_ITER` / `TIMEOUT`. Immediate stop with `.halo/STOP` is also possible |
| Approaching $200 monthly | A human decides whether to switch to a direct API key + spend limit (Requirements Specification §6.2, §10) |
| Credit pool exhaustion | Detected before launch by the heavy-preflight credit probe. On exhaustion, stop until recharge |

**Measured columns for budget tuning**:

| Parameter | Initial value | Adjusted value after measurement |
|---|---|---|
| `DAILY_MAX_ITERATIONS` (continuous / daytime-l1 / nightly) | 60 / 12 / 50 (tentative) | 〔fill in after measurement〕 |
| Average cost per iteration | — | 〔fill in after measurement〕 |
| Monthly consumption projection | — | 〔fill in after measurement〕 |

---

## 5. Troubleshooting

### 5.1 Using doctor

`halo doctor` is a one-shot health check of the environment (D3). It inspects trigger liveness (detecting a moved path) and the existence/permissions of `gh` / `claude` / `git`.

| Symptom | What doctor indicates | Primary handling |
|---|---|---|
| Trigger not firing | Liveness of the trigger registration and path consistency | Go to §5.2 |
| PR creation failure | `gh` authentication / PAT permissions | Check PAT scope (D4 §3) |
| executor cannot launch | Existence of `claude` / PATH | Re-check the PATH (WSL2), reinstall `claude` |
| worktree creation failure | `git` version / free disk space | §5.4 / secure disk space |

### 5.2 Trigger Misfire

The main causes are the WSL2 VM's automatic shutdown and Windows path inheritance (04, ADR-008).

| Order | Item | Handling |
|---|---|---|
| 1 | Whether a `HALO_<profile>` task exists in the scheduler backend (schtasks / systemd / cron / launchd) | Re-run `halo trigger install <name> <profile>` to register |
| 2 | Whether the distro name in `wsl.exe -d <distro>` is correct | Fix the distro name in the install script |
| 3 | Whether the VM is running late at night / during the day (task launch = VM startup is assumed) | Verify the launch path with an initial dry-run (`MAX_ITER=1`) (04 §4.3) |
| 4 | Whether `fire.sh`'s PATH re-cleaning is effective (contamination by `/mnt/c/`) | Confirm the PATH reconstruction in fire.sh |
| 5 | Whether a ready task actually exists (if 0, immediate termination via lightweight preflight = normal) | Check the ready count with `halo status` |

- The actual firing success rate against the expected firing frequency is measured in the Phase 1 launch test (measured column: 〔fill in after measurement〕).

### 5.3 flock Remnants

`flock` (`$TMPDIR/halo.lock` or `$TMPDIR/halo.<profile>.lock`) prevents concurrent launches (04 §4.7). If the lock remains after an abnormal process termination, subsequent launches will not start.

| Step | Operation |
|---|---|
| 1 | Confirm liveness of the process holding the lock (whether a run corresponding to the lock name exists via `ps`) |
| 2 | If no such actual process exists, the OS releases the lock at process termination (since `flock(2)` is tied to an fd, it usually does not remain). Confirm that even a leftover file causes no real harm |
| 3 | If launches are still rejected, check (via `halo status`) whether another running iteration legitimately holds the lock |
| 4 | If there is an explicit lock file created by mistake, remove it after confirming the absence of the actual process |

- Principle: because the lock is tied to fd liveness, a "remnant" is rare. Rather than deleting hastily, **first confirm the actual existence of the holding process** (deleting during operation invites a double launch).
- The HALO lock is a file with an O_EXCL create, not `flock(2)`, so a killed process *does* leave the file. `acquireLock` reclaims it automatically when the recorded pid is dead or the lock is older than six hours, so no manual deletion is normally required. Since ADR-0022, a signal-stopped run releases it on the way out and the remnant does not appear at all (§6.3).

### 5.4 worktree Remnants

The disposable worktree (`$TMPDIR/halo-wt-issue-<N>/`, D2) is deleted with `git worktree remove --force` on confirmed fail, needs-human, or completion (02). Abnormal termination can leave remnants.

| Step | Operation |
|---|---|
| 1 | List registered worktrees with `git worktree list` |
| 2 | If the corresponding Issue is already closed/needs-human, it is a remnant candidate |
| 3 | Delete with `git worktree remove --force <path>`. If the registration is broken, use `git worktree prune` |
| 4 | If the directory itself remains, remove it manually (worktrees are under ext4 `/home`; `/mnt/c/` is prohibited, 02 §2.5) |
| 5 | If remnants appear regularly, investigate whether there is a bug in the lifecycle's remove path (failure path) (01 failure-path table) |

- For remnants caused by an incident, first audit the "places touched" per the procedure in §1.4 before removal (the sandbox boundary is the worktree, so remnants are audit targets, D4 §1).
- The dominant historical cause was a signal killing the run before its `finally` ran (Ctrl-C, `systemctl stop`, a watchdog `kill`). ADR-0022 removes that cause; remnants appearing *after* that change are genuine lifecycle bugs and step 5 applies.

---

## 6. Hang Detection Operation (watchdog)

Hang detection does not run unless it is registered with the host scheduler. Until 2026-07-28 nothing registered it and nothing reported its absence, so the feature shipped inert (ADR-0023). This chapter is the procedure that closes that gap.

### 6.1 Registration

```sh
# Register the supervisor for the profile you actually run unattended.
# --action is mandatory: a registration that silently defaults to "report" is the failure being fixed.
halo watchdog install --profile nightly --action report --every 5m

# After tuning the timeouts (§6.2), promote it to recovery:
halo watchdog install --profile nightly --action kill --every 5m   # re-running is idempotent

# Removal
halo watchdog uninstall --profile nightly
```

| Point | Note |
|---|---|
| One registration per profile | The lock is profile-scoped, so a supervisor watches exactly one profile |
| Scheduler entry name | `trigger = watchdog`, profile key `<profile>-watchdog` — **not** `HALO_<profile>`. On Windows the run trigger and the supervisor would otherwise share one schtasks task name and the second install would delete the first (D9 §2.6) |
| `halo trigger list` does not show it | That command lists plugin directories, not scheduler entries. Verify with §6.2 instead |
| Timeouts | `WATCHDOG_TIMEOUT_SEC` (1800) / `WATCHDOG_EXECUTE_TIMEOUT_SEC` (3600) / `WATCHDOG_KILL_GRACE_SEC` (10) are read from the **process environment**, not the profile file (D9 §2.4). Export them in the registered command's environment |

### 6.2 Verifying it actually fires

A healthy supervisor writes nothing to `watchdog.jsonl` — that file only gets a line when a wedge is detected. Liveness is therefore read from the heartbeat:

| Step | Operation | Expected |
|---|---|---|
| 1 | `halo doctor` | Check 14 (watchdog heartbeat) is OK |
| 2 | `cat .halo/logs/watchdog-last.json` | `ts` is within twice `--every`; `stale: false` on a healthy system |
| 3 | `cat .halo/logs/watchdog.jsonl` | Empty or historical only. Every line here is a detected wedge worth reading |

Check 14 is **WARN, never FAIL** — a suspended WSL2 VM produces a stale heartbeat for benign reasons (§5.2 item 3), so it reports and does not block.

### 6.3 Report → kill promotion

Follow D9 §7's rollout order. Run in `report` for at least one full unattended cycle and read every line `watchdog.jsonl` produced:

| Observation | Reading | Action |
|---|---|---|
| No lines at all | No wedges occurred, or the phase timeouts are too generous to ever trip | Promote to `kill` |
| Lines whose `age_sec` barely exceeds `limit_sec` | The timeout is too tight for a legitimately slow phase | Raise `WATCHDOG_*_TIMEOUT_SEC` before promoting; a `kill` here would be a false positive |
| Lines with a very large `age_sec` | Genuine wedges | Promote to `kill` (or `skip` if the same `task_id` recurs — that task wedges the loop repeatedly) |

Since ADR-0022, the SIGTERM a `kill` sends is caught by the run, which removes its worktree, releases its lock, and sets the phase to `idle` before exiting. The killed iteration is recorded `aborted_signal` and **does not** count against the task's retries, so a kill never escalates a task on its own — escalation stays with the task-source's own failure accounting.

### 6.4 Stopping a run by hand

`halo stop` (kill switch) and a signal are different tools:

| Want | Use | Latency |
|---|---|---|
| Stop after the current task finishes cleanly | `halo stop` — checked at the next iteration boundary | Up to one full iteration |
| Stop now, cleanly | Ctrl-C / `systemctl stop` / SIGTERM | Bounded by the port kill grace (5 s) |
| Stop now, cleanup be damned | Signal a second time → exits `128 + signum` | Immediate; may leave a worktree and lock |

Prefer `halo stop` for routine pauses — it never interrupts an executor mid-task. Reserve signals for when you need the process gone promptly.

---

## Chapter Summary

1. Autonomy promotion/demotion (L1 scoring procedure and record template, promotion decided after measurement, immediate demotion to L1 on a serious incident)
2. needs-human handling flow (specification fix → return to ready, criteria for splitting a task)
3. Reading the failure-catalog and sign promotion (signs-proposed.md → human judgment for reflecting into PROMPT)
4. Budget monitoring (how to read status, handling overruns)
5. Troubleshooting (doctor, trigger misfire, flock remnants, worktree remnants)
6. Hang detection operation (registering the watchdog, verifying it fires via the heartbeat, report→kill promotion, stopping a run by hand)

## List of Items to Fill In After Measurement (Undetermined Points of the Skeleton)

| Item | Section | Confirmation timing |
|---|---|---|
| L1 promotion threshold (validity rate N% / M consecutive nights), required scored nights | §1.3 | At Phase 2 completion (after 10 nights of measurement) |
| L2→L3 additional condition (review approval rate) | §1.3 | Phase 3 |
| Average-iterations criterion for task splitting | §2.3 | Phase 2 |
| Recurrence-frequency criterion for sign adoption, reflection effect | §3.2 | Phase 2 |
| Adjusted budget parameters, monthly projection | §4.2 | Phase 2 |
| Trigger firing success rate | §5.2 | Phase 1 launch test |
| Watchdog phase timeouts (`WATCHDOG_*_TIMEOUT_SEC`) tuned from `report`-mode observations | §6.3 | After one full unattended cycle in `report` mode |
| Watchdog polling interval (`--every`) against observed detection latency | §6.1 | Same as above |
