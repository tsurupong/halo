# ADR-0017: Rewrite Shell Plugins in TypeScript

**Date**: 2026-07-16
**Status**: proposed
**Deciders**: Owner

## Context

All bundled plugins are Bash scripts (12 plugins + `plugins/lib`, ~800 lines total)
depending on 14 external commands (`jq`, `git`, `gh`, GNU `grep`/`sed`, scheduler
binaries, ...). ADR-0015/D10 tried to make this portable (dependency preflight,
GNU/BSD-safe idioms, bash 3.2 guards, ubuntu+macos CI matrix), but the field results
show the approach does not converge:

- macOS CI stayed red after three rounds of bash 3.2 / BSD-userland fixes
  (gate-loop-audit contract checks ② and ⑤; herestring exit-status semantics).
- Every plugin re-implements JSON I/O through `jq`, which the runtime (Node >= 22,
  required by the core anyway) provides natively and type-safely.
- The shell layer is the only part of the product outside the TypeScript toolchain:
  no types, no shared test harness, contract tests are bespoke bash
  (`test.contract.sh`) instead of Vitest.

The portability problem is not "write more careful bash" — it is that bash itself is
the non-portable dependency. Node.js is already a hard requirement of the harness.

## Decision

1. **Rewrite all bundled plugins in TypeScript** in a new workspace package
   `packages/plugins`, sharing the existing build (`tsc -b`), lint, and Vitest setup.
2. **The port contract (D1) does not change.** Plugins remain separate processes
   spawned via `plugin.json` `exec`, speaking one-JSON-in / one-JSON-out over
   stdin/stdout with exit codes 0/2/other. Third-party plugins may still be written
   in any language.
3. **Thin POSIX `sh` launchers.** Each `plugins/<name>/` keeps its `plugin.json`
   (name/version/port/exec unchanged in shape) plus a 2-line `exec node ...` launcher
   pointing at the built entry in `packages/plugins/dist/`. The launcher uses only
   POSIX `sh` builtins — no bash, no external commands.
4. **Contract tests move to Vitest.** `contract.fixtures.json` files are kept as the
   source of truth; `test.contract.sh` files are replaced by a generic Vitest driver
   in `packages/plugins` that spawns each plugin exactly as `runPort` does.
5. **`plugins/lib/scheduler.sh` becomes a TypeScript module** (`scheduler.ts`)
   preserving the ADR-0015 backend abstraction (schtasks / systemd / cron / launchd)
   via `child_process`. `require.sh` disappears; remaining external-command needs
   (`git`, `gh`, `pnpm`, scheduler binaries) are checked in-process per plugin.
6. **CI runs on a single ubuntu runner.** The OS matrix and the macOS GNU-tools
   setup are removed; the "plugin shell tests" CI step is deleted once the last
   `test.*.sh` is migrated.

## Consequences

- External command surface shrinks from 14 to the 4 that are the plugin's actual
  subject (`git`, `gh`, `pnpm`, scheduler binaries); `jq`/GNU-userland requirements
  disappear, and with them the macOS CI failure class.
- One toolchain: plugins get types (contracts schemas already exist), ESLint,
  Prettier, coverage, and the same test runner as the core.
- Plugins now require a build step before use from a source checkout
  (`pnpm build`); the npm-published package ships prebuilt `dist/`.
- D10 workstream 4 (GNU/BSD-safe shell idioms) and the `require.sh` preflight are
  superseded; workstreams 1–3 (fire correctness, scheduler abstraction, doctor)
  survive with the scheduler abstraction re-hosted in TypeScript.
- ADR-0004 (self-modification prohibition) is unaffected: `gate-loop-audit` keeps
  failing agent edits to `CLAUDE.md` / `PROMPT.md` / `.harness.yml` / test files;
  the audited path set now includes `packages/plugins/**/*.test.ts`.

## Alternatives considered

- **Keep bash, keep hardening (status quo / D10 §6)**: three fix rounds did not
  produce a green macOS matrix; every future plugin re-pays the portability tax.
- **Import plugins in-process into the core (no spawn)**: cheaper, but breaks the
  process-isolation and language-agnostic port contract (ADR-0001) and changes
  timeout/kill semantics (`runPort` SIGTERM/SIGKILL). Rejected.
- **Node launchers via shebang `#!/usr/bin/env node` (no sh)**: NTFS/WSL exec-bit
  handling of non-`.sh` scripts proved fragile in this repo's history; a `sh`
  launcher is the least surprising spawn target across platforms.

## Related

ADR-0001 (unified contract), ADR-0010 (TypeScript core), ADR-0015 (scheduler
abstraction — retained; POSIX shell hardening — superseded), D1 (contract spec),
D5 (plugin dev guide — to be updated), D10 (portability — partially superseded),
D11 (this migration's design).
