# HALO — Harness for Autonomous Loop Orchestration

HALO is a general-purpose autonomous development harness that lets an AI agent (Claude Code headless) repeatedly run the **implement → verify → output** loop without human intervention, starting from tasks fetched from a task source. Both task sources and output destinations (sinks) are swappable ports; a GitHub Issue task source (`task-source-github`) and a progress-log sink (`sink-progress-log`) are bundled as reference implementations, and commit / PR-creation sinks are designed to be added the same way. The name reflects the essence of a harness: a ring that surrounds and protects the loop (Guides = pre-control + Sensors = post-control).

The goal is to continuously produce PRs that pass quality gates during unattended overnight runs. Requirements definition, acceptance decisions, PR merges, and production deployment are deliberately not automated — they remain fixed human gates.

## Features

- **Plugin architecture**: Task sources, executors, quality gates, sinks, and triggers are all separated as ports (process boundary + JSON Schema contracts). They can be added or swapped through file operations alone, with no core changes.
- **Product-agnostic**: Any repository with a `.harness.yml` can be a target.
- **Safety invariant**: Agent self-modification of `CLAUDE.md` / `PROMPT.md` / `.harness.yml` / test files is blocked as a failure by `gate-loop-audit` (ADR-0004).
- **Autonomy profiles**: L1–L3 autonomy levels progressively unlock side effects such as commits and PR creation.
- **Zero-billing CI**: E2E tests that call an LLM are isolated as a manual smoke test; CI consists only of deterministic tests (unit / loop regression / contract).

## Requirements

- Node.js >= 22
- pnpm 10.14.0 (pinned via `packageManager`)

## Install

```sh
npm i -D @tsurupong/halo   # provides the `halo` CLI (run via npx halo <command>)
```

Published packages: [`@tsurupong/halo`](https://www.npmjs.com/package/@tsurupong/halo) (CLI), [`@tsurupong/halo-core`](https://www.npmjs.com/package/@tsurupong/halo-core), [`@tsurupong/halo-contracts`](https://www.npmjs.com/package/@tsurupong/halo-contracts).

## Development setup

```sh
pnpm install
pnpm build   # tsc -b
pnpm test    # vitest run (all tests)
```

## CLI

The `halo` CLI provides six commands.

| Command | Role |
|---|---|
| `halo init` | Scaffold `.harness.yml` and related files into the target repository |
| `halo run` | Run the autonomous loop (fetch task → execute → gates → sinks) |
| `halo status` | Show loop / queue status |
| `halo stop` | Place or remove the kill switch (STOP file) |
| `halo doctor` | Self-diagnose the environment (9 probes); `--fix` repairs the scaffold |
| `halo trigger` | Install / uninstall / list triggers (polling / schedule) |

## Repository layout

```
packages/
  contracts/   # TS types + JSON Schemas for port contracts (generated with ts-json-schema-generator)
  core/        # Loop state machine, port resolution, preflight, autonomy checks
  cli/         # halo CLI (argument parsing and delegation to core)
plugins/       # Port implementations (<port-kind>-<impl-name>)
  task-source-github/   executor-claude/      runtime-node-pnpm/
  gate-loop-audit/      gate-runtime-check/   sink-progress-log/
  on-fail-record/       trigger-polling/      trigger-schedule/
docs/
  adr/         # Architecture decision records (ADR-0001–0012)
  design/      # Design docs D1–D9 (contract spec, core design, CLI spec, test strategy, etc.)
scripts/       # e2e-dry-run.mjs (manual E2E smoke test, incurs LLM billing)
```

Each plugin consists of `plugin.json` (name / version / port / exec), shell scripts, `test.contract.sh`, and `contract.fixtures.json`; contract tests verify that its I/O conforms to the JSON Schemas.

## Testing

```sh
pnpm test           # all tests
pnpm test:contract  # plugin contract tests only
pnpm coverage       # coverage (warn-only in Phase 1, never blocks)
pnpm lint           # eslint
pnpm format         # prettier --check
```

CI (`.github/workflows/ci.yml`) runs three jobs — unit, loop-regression, and contract — none of which call an LLM: zero billing, fully deterministic. The loop regression tests replace the executor with a fixture that returns fixed JSON. The E2E smoke test that actually calls Claude is run manually via `scripts/e2e-dry-run.mjs`.

## Design documents

The primary sources for design decisions are `docs/adr/` (ADR-0001–0012) and `docs/design/` (D1–D9). Recommended reading order: D1 (contract spec) → D2 (core design) → D5 (plugin development guide).

## Status

Phase 1 (monorepo scaffold, contracts, core, CLI, reference plugins, test setup) is complete, with 303 tests green. Phase 2 will cover E2E smoke testing against real GitHub, autonomy profile tuning, and more.

## License

[MIT](./LICENSE)
