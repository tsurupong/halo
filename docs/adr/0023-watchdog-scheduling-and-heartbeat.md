# ADR-0023: Watchdog Scheduling and Heartbeat

**Date**: 2026-07-28
**Status**: accepted (implemented 2026-07-29)
**Deciders**: Owner
**Amends**: [ADR-0013](0013-external-watchdog-supervisor.md) (decision unchanged; the unscheduled-supervisor risk it deferred to documentation is closed here)

## Context

ADR-0013 deliberately made `halo watchdog` a one-shot command with external scheduling, and listed the obvious consequence under Negative: *"One more process to schedule; if the watchdog itself is not scheduled, no protection (mitigated by documenting it in the ops runbook and trigger setup)."* That mitigation never landed. As of v0.4.0:

- `docs/design/d7-ops-runbook.md` contains no watchdog procedure — the only scheduler row is the `halo trigger install` re-registration hint (line 225).
- Nothing registers the command. Every reference to `watchdog` outside its own two source files is the CLI dispatch switch, the HELP text, and completed task files under `.halo/tasks/done/`.
- `halo trigger list` cannot reveal the gap either: it enumerates `.halo/ports/trigger.d/` plugin directories (`packages/core/src/triggers.ts:138-150`), not scheduler-backend entries.

So the hang-detection feature ships inert, and nothing in the product surfaces that fact. Separately, the supervisor is silent by design when healthy — `appendJournal` is only reached on the stale branch (`packages/cli/src/commands/watchdog.ts:162`) — so even an operator who *did* schedule it has no evidence the schedule fires.

The scheduler abstraction needed to fix this already exists: `schedulerInstall(trigger, profile, spec, fireArgv)` maps `interval:<minutes>` / `daily:<HH:MM>` onto schtasks / systemd / cron / launchd (`packages/plugins/src/lib/scheduler.ts:113-145`), and the CLI already depends on `@tsurupong/halo-plugins`.

## Decision

1. **Add `halo watchdog install` / `halo watchdog uninstall`** as subcommands of the existing command. They call `schedulerInstall` / `schedulerUninstall` directly; the bare `halo watchdog` one-shot detection keeps its current behaviour and its `report` default.
2. **Scheduler identity is `trigger = "watchdog"`, profile key = `<profile>-watchdog`.** The schtasks backend names tasks `HALO_${profile}` from the profile alone and deletes any existing task of that name before creating one (`scheduler.ts:176-178`), so registering under the bare profile would silently unregister the run trigger on Windows. The suffixed key sidesteps that namespace on every backend. The real profile is passed explicitly inside the registered command as `--profile <profile>`, so the supervisor still resolves the correct lock path.
3. **`install` requires an explicit `--action`.** There is no default. The whole failure this ADR closes is a supervisor that exists but does nothing; a registration that silently defaults to `report` would reproduce it one level up. `--every <N>m` defaults to 5 minutes (the invocation is a few filesystem reads; detection latency is `interval + phase timeout`, and phase timeouts are 1800 s / 3600 s).
4. **Every invocation writes a heartbeat** to `.halo/logs/watchdog-last.json` — `{ts, stale, phase, age_sec, limit_sec, action, acted}` — overwritten in place, exactly like `current.json`. `watchdog.jsonl` stays append-only and detection-only. A healthy supervisor is therefore observable without becoming noisy.
5. **`halo doctor` gains a watchdog check** that reads the heartbeat and fails when it is missing or older than twice the registered interval. This proves the schedule *fires*, which querying a scheduler registry would not.

## Alternatives Considered

### Alternative 1: A `trigger-watchdog` plugin registered via `halo trigger install`
- **Pros**: Reuses the trigger plugin family verbatim — install/uninstall/fire aux entries, existing dispatch, no new CLI surface. `halo trigger list` would show it.
- **Cons**: A trigger port's contract is "start the loop" (D1 §1.9); the supervisor observes and kills a loop instead. Every trigger `fire` funnels through `trigger/common.ts:27-48`, which hardcodes `halo run <profile>`, so the shared helper would have to grow a branch for a non-run subcommand.
- **Why not**: Wrong lifecycle for the port contract — the same reason ADR-0013 rejected a `watchdog` port kind. Reusing the plugin shape would buy list visibility at the cost of muddying what a trigger means.

### Alternative 2: Documentation only (a cron/systemd recipe in D7) plus a doctor check
- **Pros**: Smallest, fully reversible; no new code beyond `doctor`.
- **Cons**: ADR-0013 already chose this mitigation and it did not happen. A hand-written crontab line must re-derive the CLI path, `--cwd`, PATH scrubbing for WSL (design 04 §4.2) and the profile-scoped lock — the same knowledge `schedulerInstall` already encodes, now duplicated in prose and drifting.
- **Why not**: Repeating a mitigation that demonstrably failed once, in the form most likely to be transcribed wrongly, is not a fix.

### Alternative 3: Supervise from inside `halo run` (a second process forked by the run)
- **Pros**: Nothing extra to schedule; lifetime matches the run exactly.
- **Cons**: A run that never starts — because a previous wedge holds the lock, or the trigger itself failed — is precisely when supervision matters, and no run means no supervisor.
- **Why not**: Same structural objection ADR-0013 raised against in-process supervision; forking merely moves it.

## Consequences

### Positive
- The supervisor stops shipping inert: one command registers it on all four backends, and `doctor` reports when it is absent or not firing.
- Requiring `--action` at registration makes the report→kill rollout of D9 §7 an explicit, auditable operator decision rather than an accidental default.
- The heartbeat gives the first positive signal that hang detection is alive; today an operator cannot distinguish "healthy, nothing to report" from "never ran".
- The Windows schtasks collision between the run trigger and the supervisor is avoided by construction, and is now written down.
- **A pre-existing blocker was found and fixed while wiring this**: `SAFE_ARGV_RE` in `packages/plugins/src/lib/scheduler.ts` did not allow `@`, so every path under `node_modules/@tsurupong/...` was rejected as an unsafe argv element. `halo trigger install` was therefore broken on any npm-installed HALO and only worked from the monorepo, where paths contain no `@`. The character class now allows `@`. The injection surface does not widen: the generated command is embedded in bash double quotes, a schtasks single-quoted string, a cron line, or a launchd plist, and `@` is non-special in all four, while `$`, `` ` ``, `\`, `%`, `&`, `<`, `>`, `"` remain rejected (regression-tested).

### Negative
- A second scheduler entry per profile to manage; uninstalling a profile now means two commands (`halo trigger uninstall` and `halo watchdog uninstall`).
- The heartbeat adds one small file write per invocation (every 5 minutes by default) to `.halo/logs/`.
- `halo watchdog install` is a write to the host's scheduler — the first CLI command outside `halo trigger` to mutate state beyond the repository, which slightly widens ADR-0009's "zero global state" boundary in the same way `trigger install` already does.

### Risks
- **The schtasks namespace is keyed by profile for every trigger, not just this one.** Two run triggers on one profile (schedule + polling) still collide on Windows. This ADR sidesteps the collision for the supervisor but does not fix the general case; that remains open and is out of scope here.
- **A stale heartbeat is not proof of a dead schedule** — a host that slept (WSL2 VM suspension, D7 §troubleshooting) produces the same symptom. The doctor check therefore reports, and does not act.
- **ADR-0004 alignment**: `install`/`uninstall` touch the host scheduler and `.halo/logs/` only; the protected surfaces (`CLAUDE.md`, `PROMPT.md`, `.harness.yml`, tests) are untouched.
