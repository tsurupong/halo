# D3. CLI Specification (HALO CLI Specification)

| Item | Content |
|---|---|
| Document version | 1.0 |
| Prerequisites | HALO Requirements Specification v1.8 / D1 Contract Specification / D2 Core Detailed Design |
| Positioning | **Public**. The command definitions of `packages/cli`. The entry point of unattended execution, and the implementation spec of Requirements §4.4 (Launch Layer, CLI-standard safety mechanisms) and §8.2 (zero global state) |
| Implementation | TypeScript (`packages/cli`, npm-distributed). Installation is `npm i -D halo`, execution is `npx halo <command>` or direct invocation of `node_modules/.bin/halo` from a trigger |
| Status | Runs in parallel with Phase 1 implementation (may be extracted from the implementation) |

> This document defines "the external form of the CLI (commands, arguments, exit codes, artifacts)." The internal algorithms of determination logic, the loop, and preflight are under the jurisdiction of the D2 Core Detailed Design, and this document defines only **which core functions the CLI delegates to** (§6). Numeric parameters (the default of `--max-iter`, etc.) are treated as "initial values" per Requirements §11.2.

---

## 0. Design Principle: "The CLI holds no logic"

The CLI is a thin layer that handles only **parsing arguments, resolving the environment, calling core functions, and mapping to exit codes**. The actual processing of preflight determination, loop control, budget calculation, and trigger registration all resides in `packages/core` (and the trigger adapters), and the CLI merely calls them.

This principle guarantees the following.

1. **Testability**: Since the core is a group of pure functions (the 9 modules of Requirements D2), it can be unit-tested without going through the CLI. Testing the CLI itself is limited to "the mapping of arguments → core calls."
2. **Reusability**: The same core functions can be called in common from the CLI, triggers, and future programmatic embedding.
3. **Single source of truth**: "What to do" is centralized in the core, and behavior is not doubly defined in CLI branches.

> Concrete delegation targets are listed in §6 "Delegation Map to core Functions."

---

## 1. The 6-Command System

It takes the form `halo <command> [subcommand] [args] [flags]`. The first level is 6 commands, and `project` and `trigger` have subcommands.

| # | Command | Subcommand | Role | Main delegation target (§6) |
|---|---|---|---|---|
| 1 | `run <profile>` | — | Specify a profile and run one launch (preflight → loop). The actual processing that triggers invoke | `core.preflight` / `core.loop` |
| 2 | `project init` | — | Place the target repository under HALO management (generate the `.harness.yml` template, `.halo/` skeleton, `.gitignore` append) | `core.scaffold` |
| 3 | `trigger` | `install` / `uninstall` / `list` | Register, unregister, and list trigger adapters. The actual processing is delegated to `trigger.d/<name>/{install,uninstall}.sh` | `core.discovery` + trigger adapter |
| 4 | `stop` / `resume` | — | Place/remove the kill switch (`.halo/STOP`). Stop/resume unattended execution without entering a terminal | `core.killswitch` |
| 5 | `status` | — | Display the current operation state, remaining daily budget, latest loop actuals, and trigger registration status | `core.budget` / `core.logger` |
| 6 | `doctor` | — | Self-diagnosis of environment health (trigger liveness, presence of external commands, permissions) | `core.doctor` |

> `stop` / `resume` are syntactic sugar for operating the "kill switch" safety mechanism of Requirements §4.4 from the CLI; internally they are two sides of one command (touch / rm of the STOP file). They correspond to the "stop|resume" notation of D3 in the design document list.

---

## 2. Arguments and Flags of Each Command

### 2.0 Global Flags (common to all commands)

| Flag | Type | Default | Description |
|---|---|---|---|
| `--cwd <path>` | path | current | The root of the target repository. The start point of the upward search (`.harness.yml`) |
| `--json` | bool | false | Make the output machine-readable JSON (effective for `status` / `doctor` / `trigger list`) |
| `--quiet` / `-q` | bool | false | Suppress progress and warnings (stderr). Errors are not suppressed |
| `--verbose` / `-v` | bool | false | Increase diagnostic output to stderr |
| `--version` | bool | — | Display the version of the CLI (= core / contracts) and exit 0 |
| `--help` / `-h` | bool | — | Display the help for that command and exit 0 |

> stdout is dedicated to the command's primary output (JSON when `--json`), and progress and warnings are sent to stderr (applying to the CLI as well the "stdout is for structured output only" principle of D1 §3.2/§3.3).

### 2.1 Arguments and Override Rules of `run <profile>`

`run` loads `.halo/profiles/<profile>.env` and passes to the core the execution settings bundled as environment variables (`AUTONOMY` / `MAX_ITER` / `TIMEOUT` / `DAILY_MAX_ITERATIONS` / `TASK_FILTER` / `KIND_FILTER`, etc.). CLI flags can **temporarily override** these profile values.

| Argument/flag | Type | Default | Description |
|---|---|---|---|
| `<profile>` (positional arg) | string | Required | The profile name (without extension) under `.halo/profiles/`. If it does not exist, a configuration error (exit 3) |
| `--max-iter <n>` | integer | The profile's `MAX_ITER` | Override the maximum number of iterations to run in one launch |
| `--autonomy <L1\|L2\|L3>` | enum | The profile's `AUTONOMY` | Override the autonomy (reflected in the sink filter, D1 §1.5) |
| `--timeout <duration>` | duration | The profile's `TIMEOUT` | Override the execution time limit of one launch (e.g., `3h` / `90m`) |
| `--daily-budget <n>` | integer | The profile's `DAILY_MAX_ITERATIONS` | Override the daily iteration budget |
| `--dry-run` | bool | false | A verification run equivalent to `--max-iter 1`. For checking connectivity of the launch path (the dry-run of Requirements §9 Phase 1). The sink follows autonomy, but for the initial launch test a low autonomy is also specified as an operation |
| `--profiles-dir <path>` | path | `.halo/profiles` | Override the profile search directory (for testing) |

#### Override Rules (priority)

Values are resolved in the following priority order (higher is stronger). The CLI merely passes the resolved final value to the core, and the application of the priority itself is also delegated to `core.config.resolve` (§6).

```
1. CLI flags (--max-iter, etc.)          ← highest priority (only for that one launch)
2. Profile env (<profile>.env)            ← regular value
3. core default (initial value, Requirements §11.2)  ← fallback
```

- **Overrides are non-persistent**: An override by a flag is only for that launch process and does not rewrite the `<profile>.env` file (the zero-global-state invariant of Requirements §8.2).
- **Safe-side lower bounds cannot be overridden**: STOP checking, flock, and self-modification prevention (loop-audit) are safety invariants (Requirements §11.1) and cannot be disabled by flags. Even if `--max-iter` is increased, the daily budget (`--daily-budget`) and TIMEOUT take effect independently.
- **Promotion restriction of `--autonomy`**: Raising to an autonomy higher than the profile is possible, but Phase 1 is fixed at `AUTONOMY=L1` (Requirements §9), so `--autonomy L3` against an L1 profile issues a warning (accident prevention in operation; it does not block).

### 2.2 Arguments of `project init`

| Flag | Type | Default | Description |
|---|---|---|---|
| `--kind <name>` | string (repeatable) | `code` | The kind to include in the initial `.harness.yml`. E.g., `--kind code --kind docs` |
| `--runtime <name>` | string | `node-pnpm` | The runtime assigned to the default kind (`.harness.yml`'s `runtimes`) |
| `--force` | bool | false | Regenerate the template even if an existing `.harness.yml` / `.halo/` is present (existing files are not overwritten; only missing parts are supplemented. See §3) |
| `--no-gitignore` | bool | false | Do not append to `.gitignore` |

### 2.3 Arguments of `trigger <install\|uninstall\|list>`

| Subcommand | Argument/flag | Description |
|---|---|---|
| `install <name> <profile>` | `<name>`: the adapter name under `trigger.d` (`schedule` / `polling`, etc.), `<profile>`: the launch profile name | Call the adapter's `install.sh <profile>` to register with the OS scheduler. Idempotent (a same name is deleted → re-registered) |
| `uninstall <name> [<profile>]` | Same as above. When `<profile>` is omitted, unregister all registrations of that adapter | Call `uninstall.sh`. exit 0 even with no registration (idempotent) |
| `list` | `--json` for machine-readable output | List registered triggers (adapter name / profile / registered task name / absolute path of `fire` / liveness state) |

- `install` embeds the **absolute path of `node_modules/.bin/halo`** into `fire` (unattended execution does not go through npx, version-fixed, Requirements §4.4). The CLI delegates this absolute-path resolution to `core.discovery.resolveBin`.
- The "liveness state" of `list` uses the same determination as doctor's trigger liveness check (§4) (whether the absolute path of the registered `fire` matches the current `.bin/halo`).

### 2.4 Arguments of `stop` / `resume`

| Command | Flag | Description |
|---|---|---|
| `stop` | `--reason <text>` (optional) | Create `.halo/STOP` (record the reason and datetime in the content). If it already exists, update the reason and exit 0 (idempotent) |
| `resume` | — | Delete `.halo/STOP`. If it does not exist, do nothing and exit 0 (idempotent) |

- STOP is checked by the core at the start of each iteration and at launch (D1 §5.2, Requirements §4.4). `stop` is a means of stopping without entering a terminal, equivalent to placing a file from Windows Explorer (the CLI is its syntactic sugar).
- Immediate reflection into a running loop happens "at the start of the next iteration." A running process is not forcibly killed (termination at a safe stopping point).

### 2.5 Arguments of `status`

| Flag | Description |
|---|---|
| `--json` | Output the state as JSON (for monitoring scripts) |
| `--profile <name>` | Narrow to the budget and actuals of a specific profile |

Output items (human-readable mode): presence of STOP, flock hold state (whether running), the day's iteration actuals / daily budget / remaining, the termination reason of the latest loop (normal completion / limit / budget / TIMEOUT / STOP), and a summary of the registered trigger list. The remaining budget is delegated to `core.budget.remaining` (just-in-time measurement from the day's actuals in logs/).

### 2.6 Arguments of `doctor`

| Flag | Description |
|---|---|
| `--json` | Output the check results as JSON |
| `--fix` | Attempt to repair only auto-repairable items (supplementing missing `.halo/` skeleton, etc.). Does not re-register triggers (limited to explicit operations) |

---

## 3. Artifacts of `project init`

`project init` initializes the "project structure at usage time" of Requirements §8.2. Existing files are **not overwritten; only missing parts are supplemented** (even with `--force`, existing content is preserved, and only missing skeleton is generated).

### 3.1 `.harness.yml` Template (project root, commit target)

Conforms to the Schema of D1 §1.8. Generated according to `--kind` / `--runtime`.

```yaml
# .harness.yml — HALO management declaration (commit target). Assigns a runtime and prompt per kind
kinds:
  code:
    runtimes: [node-pnpm]
    prompt: .halo/prompts/code.md
  docs:                      # only when --kind docs is specified
    runtimes: [docs-md]
    prompt: .halo/prompts/docs.md
```

### 3.2 `.halo/` Skeleton (gitignore target, local persistent state)

Generates the `.halo/` structure of Requirements §8.2 as an empty skeleton.

```
.halo/
├── ports/
│   ├── task-source.d/  context.d/  executor.d/  gate.d/
│   ├── runtime.d/  sink.d/  on-fail.d/  trigger.d/  mcp.d/   # each .d is empty (where enablement links are placed)
├── profiles/
│   ├── continuous.env      # template of frequency × autonomy × budget (Requirements §4.4 / D2)
│   ├── daytime-l1.env
│   └── nightly.env
├── prompts/
│   ├── code.md             # per-kind prompt template
│   └── docs.md             # when --kind docs is specified
├── env-templates/          # template of git-unmanaged files injected into the worktree (empty)
├── logs/                   # only .gitkeep
└── (graphs/ is generated by a private plugin in Phase 4. init only prepares an empty directory)
```

- `profiles/*.env` outputs templates with initial values for the 3 profiles of Requirements §4.4 (continuous / daytime-l1 / nightly) (concrete values are subject to operational tuning, Requirements §11.2).
- `STOP` / `mcp.json` are volatile/derived artifacts generated at runtime, so init does not create them.
- The `prompts/` templates are made consistent with the `prompt` path of `.harness.yml`.

### 3.3 `.gitignore` Append

Since `.halo/` is not committed, the following is appended (not appended if it already exists, idempotent).

```gitignore
# HALO local state (all persistent state is under .halo/, Requirements §8.2)
.halo/
```

- When `--no-gitignore` is specified, the append is skipped (for when the user manages it independently).
- If `.gitignore` does not exist, it is newly created.

### 3.4 What is Not Generated (explicit)

`node_modules/.bin/halo` (the artifact of `npm i`), `.claude/settings.json` (under the jurisdiction of the D4 Security Design), and the graph body (Phase 4) are outside the generation targets of `project init`. init only prepares "the local skeleton and declarations that HALO reads."

---

## 4. Check Items of `doctor`

`doctor` is a self-diagnosis before unattended execution and during troubleshooting, reporting each item as **OK / WARN / FAIL**. The determination logic is delegated to `core.doctor`, and the CLI maps the results to exit codes (§5.2).

| # | Check item | Determination content | On failure |
|---|---|---|---|
| 1 | **Trigger liveness (path-move detection)** | Whether the absolute path of the `fire` registered with the OS scheduler matches the current `node_modules/.bin/halo`. If the actual path of `.bin` changes due to a repository move or reinstall, the registration misfires | FAIL: prompt re-registration with `trigger install` |
| 2 | **`.halo/` skeleton consistency** | The presence of the required directories of Requirements §8.2 (`ports/*.d`, `profiles`, `logs`, etc.) and `.harness.yml` | FAIL (supplement missing with `--fix`) |
| 3 | **`.harness.yml` validity** | Conformance to the D1 §1.8 Schema, whether `runtimes` actually exist in `runtime.d` | FAIL |
| 4 | **Presence, authentication, and permissions of `gh`** | Presence of the `gh` binary + `gh auth status` + whether it is a fine-grained PAT sufficient for PR creation/label operations (Requirements §6.1; full `repo` scope is WARN) | FAIL (unauthenticated) / WARN (excessive permissions) |
| 5 | **Presence and executability of `claude`** | The presence of the `claude` binary that the executor adapter invokes and its `--version` response | FAIL |
| 6 | **Presence of `git` and working tree** | Presence of the `git` binary, whether the target is a repository, `user.name`/`user.email` settings | FAIL |
| 7 | **flock / STOP residue** | Residue of `$TMPDIR/halo.lock` (an orphan lock after a crash), the unintended persistence of `.halo/STOP` | WARN |
| 8 | **Placement constraint (WSL2)** | Whether `.halo/` and the worktree destination (`$TMPDIR`) are on the ext4 side (not under `/mnt/c/`) (the placement constraint of D1 §1.7) | WARN |
| 9 | **Disk space** | Free space sufficient for worktree expansion (a prior check of the heavy preflight) | WARN |

- Checks 4/5/6 report "presence, permissions, response" separately (e.g., the binary exists but is unauthenticated = FAIL, authenticated but over-permissioned = WARN).
- `doctor` does not perform an external-API credit probe (to avoid billing and rate consumption; that stays with the responsibility of the heavy preflight).

---

## 5. Exit Code and Error Message Conventions

### 5.1 Exit Codes

The CLI's exit code represents "whether execution is possible and the kind of failure." **It is a separate layer from the plugin exit code convention (D1 §3.1: 0=pass / 2=fail)**, and the CLI maps the core's execution result to the following.

| Exit code | Meaning | Applicable example |
|---|---|---|
| `0` | Normal completion | Loop normal completion, `--help`/`--version`, `stop`/`resume` success, doctor all OK, a legitimate immediate termination by preflight (STOP detection / flock concurrent-launch avoidance / zero ready / budget exceeded are "normal non-execution" as exit 0) |
| `1` | Runtime error | An unrecoverable error within the loop, heavy preflight failure (git contamination / disk shortage / credit exhaustion), trigger install registration failure, doctor has a FAIL item |
| `2` | Reserved (equivalent to plugin fail) | Normally not returned by the CLI itself. Not used for CLI anomalies to avoid collision with D1's plugin fail convention |
| `3` | Configuration/usage error | Invalid arguments, unknown profile/trigger name, `.harness.yml` absent/invalid, unknown command |

> **Design decision**: In polling operation, "most fires terminate immediately with zero ready" (Requirements §4.4). To not treat these as anomalies, **immediate termination by preflight is exit 0**. Only true anomalies (heavy preflight failure, error within the loop) are exit 1, so the monitoring side can make only non-zero its alert target.

### 5.2 doctor Exit Codes

| State | Exit code |
|---|---|
| All items OK (no WARN) | 0 |
| WARN present, no FAIL | 0 (monitoring judges by the `warn` count in `--json`) |
| FAIL present | 1 |

### 5.3 Error Message Conventions

Following the coding conventions of the Requirements (error handling / input validation), the following are satisfied.

1. **stderr output**: Errors and warnings to stderr, primary output to stdout (even with `--json`, the structured result to stdout, errors to stderr).
2. **1-line summary + remedy**: The first line shows "what failed," and the following lines show "what to do." E.g.:
   ```
   error: profile 'continous' not found in .halo/profiles/
   hint: did you mean 'continuous'? run `halo status` to list available profiles.
   ```
3. **Do not leak secrets**: Do not output token values or credentials within absolute paths (Requirements §6.1). `gh` authentication errors report only the status and hide the PAT value.
4. **Error shape when `--json`**: Even on exception, output `{"ok": false, "code": <exit>, "error": "<message>", "hint": "<...>"}` to stdout as much as possible, enabling machine processing for monitoring.
5. **Usage error (exit 3)**: Include the short usage of that command.

---

## 6. The "CLI holds no logic" Principle: Delegation Map to core Functions

The correspondence of the core (the 9 modules of D2) functions each command calls. The CLI side does only "resolve arguments → call the functions in the table below → map the result to exit code/output."

| Command | Main delegation target (core module.function) | CLI-side responsibility (not logic) |
|---|---|---|
| `run <profile>` | `config.resolveProfile` + flag merge → `preflight.light` → `preflight.heavy` → `loop.run` | Parse the profile name and flags, map STOP/budget to exit 0 and anomalies to exit 1 |
| `project init` | `scaffold.harnessYml` / `scaffold.haloSkeleton` / `scaffold.gitignore` | Interpret `--kind`/`--runtime`/`--force`/`--no-gitignore`, display a summary of the generation result |
| `trigger install` | `discovery.resolveTrigger` + `discovery.resolveBin` → spawn the adapter `install.sh` | Validate the adapter name/profile name, map the spawn exit code |
| `trigger uninstall` | `discovery.resolveTrigger` → spawn the adapter `uninstall.sh` | Same as above (idempotent, exit 0 even when unregistered) |
| `trigger list` | `discovery.listTriggers` + `doctor.checkTriggerLiveness` | Format the list (human-readable / `--json`) |
| `stop` / `resume` | `killswitch.set` / `killswitch.clear` | Pass `--reason`, idempotent exit 0 |
| `status` | `budget.remaining` + `logger.lastRun` + `discovery.listTriggers` | Format the display, `--json` serialization |
| `doctor` | `doctor.runAll` (each check of §4) + `scaffold.repair` when `--fix` | Aggregate the check results as OK/WARN/FAIL → map to exit code |

- The CLI receives the **return values (structured results)** of the above functions and does not make determinations. For example, "whether the budget is exceeded" is returned by the core as `budget.remaining <= 0`, and the CLI merely maps it to exit 0 (normal non-execution).
- The actual processing of the trigger adapters (`install.sh` of `schedule`/`polling`, etc.) is bash, and the CLI only handles the spawn and the collection of the exit code (D1 §1.9).
- This delegation map is also the dividing line of the D8 Test Strategy's "CLI test = mapping test, logic test = core unit test."

---

## Appendix A. Command Quick Reference

| Command | Purpose | Representative flags | Main exit codes |
|---|---|---|---|
| `halo run <profile>` | One launch (the actual processing triggers invoke) | `--max-iter` `--autonomy` `--timeout` `--daily-budget` `--dry-run` | 0 (normal/immediate termination) / 1 (anomaly) / 3 (configuration) |
| `halo project init` | Place the repository under HALO management | `--kind` `--runtime` `--force` `--no-gitignore` | 0 / 3 |
| `halo trigger install <name> <profile>` | Register a trigger | — | 0 / 1 / 3 |
| `halo trigger uninstall <name> [<profile>]` | Unregister a trigger (idempotent) | — | 0 / 3 |
| `halo trigger list` | List registrations | `--json` | 0 |
| `halo stop` / `halo resume` | Place/remove the kill switch | `--reason` | 0 |
| `halo status` | Operation state, budget, actuals | `--json` `--profile` | 0 |
| `halo doctor` | Environment self-diagnosis | `--json` `--fix` | 0 (OK/WARN) / 1 (FAIL) |

## Appendix B. Glossary

| Term | Definition |
|---|---|
| Profile | `.halo/profiles/<name>.env`. A group of environment variables bundling frequency × autonomy × budget (Requirements §4.4) |
| Kill switch | The `.halo/STOP` file. Its presence causes immediate termination at launch / at the start of each iteration (Requirements §4.4, D1 §5.2) |
| Trigger liveness | The absolute path of the registered `fire` matching the current `.bin/halo` (a state that does not misfire on a path move) |
| Override rule | The priority of CLI flags > profile env > core default (§2.1, non-persistent) |
| Delegation map | The correspondence table of the core functions each command calls (§6). The embodiment of the principle that the CLI holds no logic |
