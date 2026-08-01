# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The four packages (`@tsurupong/halo`, `halo-core`, `halo-contracts`, `halo-plugins`) are
versioned and released together.

## [Unreleased]

## [0.5.0] - 2026-08-02

### Upgrading from 0.4.0 — read this first

- **`halo doctor` now really validates `.harness.yml`** (contract validation via
  `validateHarnessYml` + existence check of every `kinds[].runtimes` entry under
  `.halo/ports/runtime.d/`). A repository whose `.harness.yml` was silently broken up to
  0.4.0 will newly FAIL. Fix the file (or regenerate with `halo project init`) before
  relying on unattended runs.
- **The executor no longer reads the operator's `~/.claude/settings.json`** — the spawned
  Claude Code now gets `--setting-sources ''` by default, so effective permissions come
  only from the injected settings file (ADR-0019) and `--allowedTools` (ADR-0020). If your
  setup intentionally relied on user-level settings, set `HALO_CLAUDE_SETTING_SOURCES=user`
  in the executor environment to restore the old behaviour.

### Added

- Graceful shutdown and watchdog scheduling (ADR-0022 / ADR-0023): signal-aware loop
  abort, `schedulerInstall`-backed watchdog registration, and a heartbeat doctor check
  (#20).
- Task-source claim/release semantics (ADR-0025): tasks are claimed before execution and
  released on failure, closing the double-pickup window (#29).
- Failure-learning pair enabled by default (ADR-0027): `on-fail-record` +
  `context-recent-failures` are scaffolded by `project init`, with a `doctor` c16 check
  (#31).
- `watchdog` resolves `WATCHDOG_*` limits via `--profile` env files (process env >
  profile env > defaults), as D9 §2.4 specified (#34).

### Security

- Executor egress prohibition (ADR-0026): `git push`, `gh`, and remote-mutating commands
  are always denied inside the unattended loop, independent of profile (#28).
- Executor permission hardening: the deny set covers all of D4 §2.2 (28 rules) from a
  single authoritative list shared with `doctor` drift detection, `.harness.yml`
  `protectedPaths` are merged into the deny set, and operator-level settings are excluded
  from the effective permissions (#19, #34).

### Fixed

- `task-source-github` treats `gh` failures as fatal instead of reporting an empty queue,
  so an expired token no longer turns into a "successful" idle night (#19).
- Failures below the retry threshold return tasks to `ready`, letting `needs-human`
  escalation actually trigger; retry counts survive requeues (#19).
- `--max-budget-usd` is parsed as a value flag and enforced per launch (#19).
- Runtime setup failures keep their reason in `diagnostics` instead of vanishing (#30).
- `gate-loop-audit` coverage-threshold check compares thresholds key-by-key with
  word-boundary extraction, removing both false alarms and a threshold-lowering blind
  spot; wholesale threshold-line deletion is surfaced as a warning (#34).
- `on-fail-requeue` no longer creates orphan retry counters for missing task files (#34).
- `doctor` placement check generalises to any `/mnt/<drive>` (drvfs) mount and reports
  the actually detected path (#34).
- Vitest no longer picks up stray working-tree copies under `.claude/`, stabilising the
  test baseline (#34).

### Documentation

- ADR-0024 records dropping the OS-level sandbox (bubblewrap) from the design (#22).
- Design docs D1/D3/D4/D9 realigned with the implementation (setting sources, watchdog
  profile resolution, placement constraint, coverage-check semantics) (#34).
- Per-directory `CLAUDE.md` context files across the repository (#33); ADRs scrubbed of
  machine-specific paths (#35).

## [0.4.0] - 2026-07-25

### Upgrading from 0.3.0 — read this first

`.harness.yml` is now actually read, and that changes behaviour for an existing
repository. Up to 0.3.0 the `kinds.<kind>.prompt` field was validated but never loaded, so
a declaration pointing at a file that did not exist was harmless. From 0.4.0 a task whose
kind cannot be resolved — undeclared kind, or a prompt template that cannot be read — is
escalated to a human instead of running.

Because `halo project init` writes the prompt under `.halo/`, and `.halo/` is gitignored, a
freshly cloned repository typically has the declaration but not the template. **Before
upgrading, confirm the file every kind points at exists:**

```sh
grep -h 'prompt:' .harness.yml    # then check each path resolves
```

If a template is missing, regenerate it with one `--kind` per kind your `.harness.yml`
declares — existing files, including `.harness.yml` itself, are preserved:

```sh
npx halo project init --kind code --kind docs
```

`halo project init` does not read your existing declaration, so a kind you omit gets no
template. Everything else in this release is additive.

### Added

- `context-recent-failures`: the first bundled context plugin. Re-injects the most recent
  failures for the same task (from the JSONL catalogue `on-fail-record` now writes) so the
  agent stops repeating an identical mistake.
- `on-fail-notify`: best-effort webhook POST once `retry_count` reaches a threshold, so an
  overnight escalation is not silent.
- `halo history`: inspect past iterations from the logs.
- ADR-0019 / ADR-0020 / ADR-0021 implemented: the executor now spawns with an
  `--allowedTools` allowlist under `--permission-mode dontAsk`, a HALO-managed deny
  settings file, and a per-run `max_budget_usd` ceiling.
- `.harness.yml` now supports `maxAutonomy`: a committed, reviewable ceiling on the
  autonomy level. It is applied after the profile and `--autonomy`, so a run cannot be
  raised past it from the command line (ADR-0004). `halo project init` writes `L2` by
  default.
- `.harness.yml` now supports `protectedPaths`: extra glob patterns the audit gate treats
  as protected from self-modification, on top of the built-in set. Passed to gates as
  `gate.in.protected_paths`, read by the core at the repository root so the list cannot be
  weakened by editing the copy inside the worktree.
- `static` CI job running `pnpm lint` and `pnpm format`; neither was checked in CI before.

### Fixed

- **The loop never reported failures to the task source.** `op=fail` was never sent, so
  the three-strikes escalation to `needs-human` was dead code and a poison task could be
  retried on every run forever.
- **A committing executor bypassed the audit gate.** `gate-loop-audit` only inspected
  `git diff HEAD`, so an agent that committed its own work escaped all seven checks. Gates
  now receive the worktree's base commit and diff against it.
- Runtime `setup` was never invoked, so repositories with dependencies failed their
  typecheck and test gates on every iteration.
- The executor inherited the full environment, exposing `GH_TOKEN` and friends to the
  agent; those are now stripped, and `.claude/settings*.json` in the target repository is
  both ignored at spawn and protected by the audit gate.
- Daily cost budgeting silently counted zero because the executor never reported cost.
- **`halo project init --kind <name>` was silently ignored.** `kind` was registered as a
  repeatable flag but not as a value-taking one, so `--kind docs` parsed as a boolean and
  `docs` fell through to the positional arguments — `init` always scaffolded `code` alone.
  Found while verifying this release's upgrade instructions.
- **`.harness.yml` is now actually read.** `kinds.<kind>.prompt` was validated but never
  loaded — the declared prompt template never reached the executor, and `resolveKind` had
  no callers outside tests. Each task's `kind` now resolves to its template, whose body is
  injected into the prompt as an `## Instructions` section. A kind that is undeclared, or
  whose template cannot be read, escalates that task to a human instead of running it
  silently without instructions.

### Changed

- `pnpm lint` covers `scripts/` and the ESLint config in addition to `packages/`.
- The repository is now Prettier-formatted throughout (47 files were previously unchecked).

## [0.3.0] - 2026-07-18

### Changed

- **Entry contract (ADR-0018)**: `plugin.json` drops `exec` in favour of `entry` / `aux`
  plus a `HALO_PLUGIN_DIR` injection. All POSIX sh launchers are gone, and `halo enable`
  no longer generates one — it emits a `plugin.json` with absolute paths.
- `task-source-local` migrated to TypeScript.

### Added

- ADR-0019 / ADR-0020 / ADR-0021 proposed, aligning the design with the Agent SDK
  permission and cost model: settings-based deny injection, `allowedTools` + `dontAsk` as
  the executor default, and a `max_budget_usd` run ceiling.

## [0.2.0] - 2026-07-16

### Changed

- **All bundled plugins migrated from shell to TypeScript** (ADR-0017, D11). Implementations
  live in `packages/plugins/src`, with `plugins/*` holding the discovery manifests.

### Added

- `halo enable <name>`: install a bundled plugin outside the monorepo.
- Reliability layer: an external watchdog that detects and recovers a stalled loop
  (ADR-0013), and requeue/quarantine handling for failed tasks (ADR-0014).
- `sink-git-commit` (ADR-0016) and phase-boundary tracking via `.halo/logs/current.json`
  for hang detection.

### Fixed

- `MAX_TURNS` was resolved but never reached the executor, and executor failure reasons
  were not propagated into the next iteration's prompt.

## [0.1.2] - 2026-07-13

Initial public release line. Core loop, contracts, and CLI.

### Added

- Ports-and-adapters architecture with eight ports and JSON Schema contracts generated from
  TypeScript types (ADR-0001, D1).
- Core state machine: two-stage preflight, disposable worktree per task (ADR-0002), gate
  logical-AND, autonomy-filtered sinks, and budget/timeout termination.
- CLI: `run`, `project init`, `trigger`, `stop` / `resume`, `status`, `doctor`.
- Bundled plugins for task sources (GitHub Issues, local markdown queue), executor,
  quality gates, sinks, triggers, and runtime.
- Zero-billing CI: unit, loop-regression, and contract layers, all deterministic.

[Unreleased]: https://github.com/tsurupong/halo/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/tsurupong/halo/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tsurupong/halo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tsurupong/halo/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/tsurupong/halo/releases/tag/v0.1.2
