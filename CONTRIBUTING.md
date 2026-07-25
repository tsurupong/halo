# Contributing to HALO

Thanks for taking a look. This document covers the setup, the language policy, and — most
importantly — **what a plugin PR has to satisfy to be merged**, since plugins are where
most contributions are expected.

## Setup

```sh
pnpm install
pnpm build     # tsc -b
pnpm test      # vitest run
pnpm lint      # eslint packages scripts eslint.config.js
pnpm format    # prettier --check .
```

Requirements: Node.js >= 22 and pnpm 10.14.0 (pinned via `packageManager` — a mismatched
pnpm is the most common first-run failure). All commands run from this directory; there is
no package.json at the repository root above it.

CI runs four jobs, all of which must pass: `static` (lint + format), `unit`,
`loop-regression`, and `contract` (plugin contracts + schema drift). None of them call an
LLM, so CI costs nothing and is deterministic. The paid end-to-end smoke
(`scripts/e2e-dry-run.mjs`) is manual and pre-release only.

## Language policy

Mixed-language repositories get messy without a rule, so here it is:

| What | Language |
|---|---|
| Code identifiers, type names, file names | English |
| Commit subject line (conventional-commit `type: subject`) | English |
| `README.md`, `SECURITY.md`, this file, `docs/adr/`, `docs/design/` | English |
| In-code comments | Japanese is fine and is the current norm |
| Commit body, PR description, issue text | Japanese or English, whichever you think in |

The rule of thumb: anything a stranger reads to *evaluate* the project is English; anything
a maintainer reads to *work on* it may be Japanese. Do not translate existing Japanese
comments as a drive-by change.

## Changes to the core

- Read the design docs before changing behaviour. `docs/adr/` holds the decisions and
  `docs/design/` the specifications; they are the primary source, not the code.
- A behaviour change that contradicts an ADR needs a new ADR superseding it, in the same PR.
- `packages/contracts` is the single source of truth for the JSON Schemas. After editing a
  type, run `pnpm --filter @tsurupong/halo-contracts gen` and commit the regenerated
  `schemas/*.json` — the `contract` job fails on drift.
- Tests come with the change, not after it. The `loop-regression` job exists because the
  loop is the part that runs unattended at 3am.

## Contributing a plugin

A plugin is a separate process that speaks JSON over stdin/stdout. The contract is
[D1](./docs/design/d1-contract-spec.md); the walkthrough is
[D5](./docs/design/d5-plugin-dev-guide.md).

### Acceptance criteria

A plugin PR is merged when all of the following hold. These are mechanical on purpose —
you can check every one of them yourself before opening the PR.

1. **Naming.** The directory is `<port>-<impl>`, e.g. `task-source-github`,
   `gate-runtime-check`, `sink-progress-log`. The port prefix must be one of the eight
   ports: `task-source`, `context`, `executor`, `gate`, `sink`, `on-fail`, `runtime`,
   `trigger`.
2. **Manifest.** `plugins/<name>/plugin.json` declares `name`, `version`, `port`, and
   `entry` (a path to a built JS module — there are no shell launchers, ADR-0018). Declare
   `minAutonomy` on anything with a side effect; an undeclared value is treated as the
   safest side and the plugin simply will not run below L3.
3. **Contract fixtures.** `plugins/<name>/contract.fixtures.json` provides the input/output
   examples. The `contract` CI job validates them against the generated JSON Schemas, so
   fixtures that do not match the contract fail the build. This is the acceptance test —
   if the fixtures pass, the plugin speaks the protocol.
4. **Behaviour tests.** `packages/plugins/src/<name>/<name>.test.ts` covers the behaviour,
   spawning the built entry as a real process rather than importing it. Existing plugin
   tests are the pattern to copy.
5. **Exit codes.** 0 = pass, 2 = fail (with a `gate.out`-shaped JSON on stdout for gates),
   anything else = error. stdout carries exactly one JSON object; diagnostics go to stderr.
6. **No new runtime dependencies.** The published packages have zero third-party runtime
   dependencies and that is a deliberate property of a tool people run against their own
   repositories. A plugin that needs a library should justify it in the PR description.
7. **Fail closed.** When a plugin cannot determine the answer, it must fail rather than
   pass. A gate that passes on error is worse than no gate.

### Things that will be sent back

- A gate that weakens an existing safety invariant, or an executor that widens the
  permission allowlist, without an ADR.
- Anything that makes `gate-loop-audit` skippable or self-modifiable.
- A plugin that reads secrets it does not need — the executor deliberately runs without
  git-forge tokens (see [SECURITY.md](./SECURITY.md)).

## Pull requests

- Branch from `main` and open a PR; do not push to `main` directly.
- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `style:`.
- Keep the diff under ~1500 changed lines. That is the same ceiling `gate-loop-audit`
  enforces on the agent, and it applies to humans for the same reason: a diff nobody can
  review is not reviewed.
- State how you verified the change. "Tests pass" means you ran them and saw the output.

## Security

Do not report vulnerabilities through issues or pull requests. See
[SECURITY.md](./SECURITY.md) for the private reporting channel.
