# HALO — Harness for Autonomous Loop Orchestration

HALO is a general-purpose autonomous development harness that lets an AI agent (Claude Code headless) repeatedly run the **implement → verify → output** loop without human intervention, starting from tasks fetched from a task source. Task sources, executors, quality gates, sinks, and triggers are all swappable ports, and reference implementations for each port are bundled (e.g. task sources backed by GitHub Issues or a local markdown queue, sinks that commit results or append progress logs). The name reflects the essence of a harness: a ring that surrounds and protects the loop (Guides = pre-control + Sensors = post-control).

The goal is to continuously produce deliverables that pass quality gates during unattended overnight runs. Requirements definition, acceptance decisions, PR merges, and production deployment are deliberately not automated — they remain fixed human gates.

## Features

- **Plugin architecture**: Task sources, executors, quality gates, sinks, and triggers are all separated as ports (process boundary + JSON Schema contracts). They can be added or swapped through file operations alone, with no core changes.
- **TypeScript plugins with the entry contract**: All bundled plugins are TypeScript (ADR-0017). Each `plugin.json` declares `entry`/`aux` pointing directly at built JS; there are no shell launchers (ADR-0018).
- **Product-agnostic**: Any repository with a `.harness.yml` can be a target.
- **Safety invariant**: Agent self-modification of `CLAUDE.md` / `PROMPT.md` / `.harness.yml` / test files is blocked as a failure by the audit gate (ADR-0004).
- **Reliability**: An external watchdog detects and recovers stalled loops (ADR-0013), and failed tasks are requeued or quarantined (ADR-0014).
- **Autonomy profiles**: L1–L3 autonomy levels progressively unlock side effects such as commits and PR creation.
- **Zero-billing CI**: E2E tests that call an LLM are isolated as a manual smoke test; CI consists only of deterministic tests (unit / loop regression / contract).

## Requirements

- Node.js >= 22
- pnpm 10.14.0 (pinned via `packageManager`)

## Install

```sh
npm i -D @tsurupong/halo   # provides the `halo` CLI (run via npx halo <command>)
```

Published packages: [`@tsurupong/halo`](https://www.npmjs.com/package/@tsurupong/halo) (CLI), [`@tsurupong/halo-core`](https://www.npmjs.com/package/@tsurupong/halo-core), [`@tsurupong/halo-contracts`](https://www.npmjs.com/package/@tsurupong/halo-contracts), [`@tsurupong/halo-plugins`](https://www.npmjs.com/package/@tsurupong/halo-plugins).

## Development setup

```sh
pnpm install
pnpm build   # tsc -b
pnpm test    # vitest run (all tests)
```

## CLI

| Command | Role |
|---|---|
| `halo run <profile>` | Run the autonomous loop once for a profile (preflight → loop) |
| `halo project init` | Bring a repository under HALO management (`.harness.yml` / `.halo/`) |
| `halo trigger install / uninstall / list` | Register / remove / list triggers on the OS scheduler (polling / schedule) |
| `halo stop [--reason <text>]` | Place the kill switch (`.halo/STOP`) |
| `halo resume` | Remove the kill switch |
| `halo status [--days <n>]` | Show running state, remaining budget, and a recent-runs summary with cost (default 7 days) |
| `halo history [--days <n>] [--limit <n>]` | List run history chronologically (default 7 days / 20 entries) |
| `halo watchdog [--action <mode>]` | Detect / recover stalled loops (`report` \| `kill` \| `skip`, default `report`) |
| `halo doctor [--fix]` | Self-diagnose the environment (9 probes); `--fix` repairs the scaffold |
| `halo enable <plugin-name>` | Generate a bundled plugin into `.halo/` as a `plugin.json` with absolute `entry`/`aux` paths |

Global flags: `--cwd <path>`, `--json`, `--quiet`/`-q`, `--verbose`/`-v`, `--version`, `--help`/`-h`.

## Repository layout

```
packages/
  contracts/   # TS types + JSON Schemas for port contracts (generated with ts-json-schema-generator)
  core/        # Loop state machine, port resolution, preflight, autonomy checks
  cli/         # halo CLI (argument parsing and delegation to core)
  plugins/     # TypeScript implementations of all bundled plugins (tests colocated)
plugins/       # Plugin discovery units, one directory per bundled plugin
               # (named <port-kind>-<impl-name>): plugin.json + contract.fixtures.json
docs/
  adr/         # Architecture decision records
  design/      # Design docs (contract spec, core design, CLI spec, plugin guide, reliability, etc.)
scripts/       # e2e-dry-run.mjs (manual E2E smoke test, incurs LLM billing)
```

Each plugin consists of `plugin.json` (name / version / port / `entry` / `aux`, ADR-0018) and `contract.fixtures.json`; the implementation lives in `packages/plugins/src/<name>/` with behavior tests at `packages/plugins/src/<name>/<name>.test.ts`. Contract tests verify that each plugin's I/O conforms to the JSON Schemas.

## Testing

```sh
pnpm test           # all tests
pnpm test:contract  # plugin contract tests only
pnpm coverage       # coverage (warn-only, never blocks)
pnpm lint           # eslint
pnpm format         # prettier --check
```

CI (`.github/workflows/ci.yml`) runs three jobs — unit, loop-regression, and contract — none of which call an LLM: zero billing, fully deterministic. The loop regression tests replace the executor with a fixture that returns fixed JSON. The E2E smoke test that actually calls Claude is run manually via `scripts/e2e-dry-run.mjs`.

## Design documents

The primary sources for design decisions are the ADRs in `docs/adr/` and the design docs in `docs/design/`. Recommended reading order: D1 (contract spec) → D2 (core design) → D5 (plugin development guide).

## Status

See the [releases](https://github.com/tsurupong/halo/releases) and `docs/adr/` for the current state and history of the project. ADRs marked *proposed* indicate work that is designed but not yet implemented.

## License

[MIT](./LICENSE)
