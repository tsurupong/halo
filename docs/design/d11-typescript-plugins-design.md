# D11: TypeScript Plugin Migration Design

Related: ADR-0017 (decision), ADR-0001 (unified contract), ADR-0015 (scheduler abstraction), D1 (contract spec), D5 (plugin dev guide), D8 (test strategy), D10 (portability — workstreams 4/6 superseded here).

## 1. Scope and goals

Replace every bundled shell plugin with a TypeScript implementation while keeping the
D1 port contract byte-compatible: same `plugin.json` discovery, same spawn model
(`runPort` is untouched), same stdin/stdout JSON shapes, same exit-code semantics
(0 = pass, 2 = fail, other = error), same env-variable inputs.

Non-goals: changing any port schema, changing `runPort`/core, native Windows
support, migrating third-party plugin authorship away from "any language".

## 2. Package layout

New workspace package `packages/plugins` (`@tsurupong/halo-plugins`, ESM,
`tsc -b`, same lint/format config as the other packages):

```
packages/plugins/
  package.json            # type: module, build: tsc -b
  tsconfig.json           # composite, references contracts
  src/
    lib/
      io.ts               # readStdinJson(), writeStdoutJson(), fail(code, msg)
      exec.ts             # run(cmd, args, opts) → {code, stdout, stderr} wrapper
      scheduler.ts        # port of plugins/lib/scheduler.sh (4 backends)
    executor-claude/main.ts
    gate-loop-audit/main.ts
    gate-runtime-check/{main.ts,typecheck.ts,test.ts}
    on-fail-record/main.ts
    on-fail-requeue/main.ts
    runtime-node-pnpm/main.ts
    sink-git-commit/main.ts
    sink-progress-log/main.ts
    task-source-github/main.ts
    trigger-polling/{fire.ts,install.ts,uninstall.ts}
    trigger-schedule/{fire.ts,install.ts,uninstall.ts}
  test/
    contract.test.ts      # generic fixture driver (§5)
    scheduler.test.ts
```

Entry-point pattern (each `main.ts`):

```ts
import { readStdinJson, writeStdoutJson } from '../lib/io.js';
const input = await readStdinJson();      // validated against contracts schema
// ... plugin logic ...
writeStdoutJson(output);
process.exit(0);                          // or 2 on fail
```

Input/output types come from `@tsurupong/halo-contracts`; each plugin validates its
stdin against the distributed JSON schema with ajv (the same schemas the contract
tests use), turning today's implicit `jq` parsing into typed, validated I/O.

## 3. Launcher contract

`plugins/<name>/` keeps its directory as the discovery unit:

```
plugins/sink-git-commit/
  plugin.json             # unchanged shape; exec: "run.sh" (or existing name)
  run.sh                  # thin launcher, POSIX sh only:
  contract.fixtures.json  # unchanged
```

Launcher body (identical for every plugin, only the entry name differs):

```sh
#!/bin/sh
exec node "$(dirname "$0")/../../packages/plugins/dist/sink-git-commit/main.js" "$@"
```

Rules:

- POSIX `sh` builtins only (`dirname` is required by POSIX). No bash, no `jq`.
- `"$@"` forwards subcommand args (trigger plugins use `fire|install|uninstall`).
- The npm-published layout resolves `dist/` relative to the installed package;
  the launcher path is the only per-layout difference and is generated at build
  time if the relative path ever needs to differ (not expected in Phase 2).
- Exit code, stdin, stdout pass through `exec` untouched, so `runPort`'s
  timeout/SIGTERM/SIGKILL and `classifyExit` behavior are unchanged.

## 4. Per-plugin migration notes

| Plugin | External cmds after TS | Notes |
|---|---|---|
| executor-claude | `claude` | stub override via env (`CLAUDE_STUB_OUT`) preserved verbatim |
| gate-loop-audit | `git` | diff-path audit; the bash-3.2 herestring bug class disappears |
| gate-runtime-check | — | delegation to typecheck/test sub-checks becomes in-package imports |
| on-fail-record | — | pure fs + JSON |
| on-fail-requeue | — | pure fs + JSON (queue/quarantine moves) |
| runtime-node-pnpm | `pnpm` | spawn passthrough |
| sink-git-commit | `git` | stage+commit on feature branch (ADR-0016 semantics unchanged) |
| sink-progress-log | — | pure fs + JSON |
| task-source-github | `gh` | keep `gh` CLI (auth reuse) rather than octokit for Phase 2 |
| trigger-polling / trigger-schedule | scheduler binaries | `fire` stays trivially small; install/uninstall call `lib/scheduler.ts` |
| plugins/lib | (deleted) | `require.sh` → in-process checks; `scheduler.sh` → `lib/scheduler.ts` |

`lib/scheduler.ts` preserves ADR-0015 behavior: backend order schtasks → systemd →
cron → launchd, `HALO_SCHEDULER` env override, identical task/unit naming, so an
environment installed by the shell version uninstalls cleanly with the TS version.

## 5. Test migration

- `contract.fixtures.json` files stay in place and stay the source of truth.
- One generic Vitest driver (`packages/plugins/test/contract.test.ts`) walks
  `plugins/*/contract.fixtures.json`, and for each case spawns the plugin **through
  its launcher** (same argv/stdin/env as `runPort`), then asserts stdout JSON,
  exit code, and schema validity. This replaces every `test.contract.sh`.
- `pnpm test:contract` is repointed at this driver; the CI "plugin shell tests"
  step and `test.*.sh` files are deleted in the final task.
- Unit tests for nontrivial logic (scheduler backend detection, loop-audit rules,
  requeue/quarantine) live next to the source as ordinary Vitest files.
- ADR-0004: the audit path set in gate-loop-audit gains
  `packages/plugins/**/*.test.ts` and `packages/plugins/test/**`.

## 6. Migration order (one PR-sized step each)

1. **Scaffold**: `packages/plugins` package + `lib/io.ts`/`exec.ts` + generic
   contract driver running against the *existing shell plugins* (proves the driver
   reproduces `test.contract.sh` results before anything is rewritten).
2. **Pure-JSON plugins**: sink-progress-log, on-fail-record, on-fail-requeue,
   gate-runtime-check (no external commands; lowest risk).
3. **Git-facing**: sink-git-commit, gate-loop-audit.
4. **Externals**: executor-claude, runtime-node-pnpm, task-source-github.
5. **Scheduler**: `lib/scheduler.ts` + trigger-polling + trigger-schedule
   (largest; includes backend tests replacing `test.backends.sh`).
6. **Cleanup**: delete `plugins/lib/*.sh`, all `test.*.sh`, the CI shell-test
   step; update D5 (plugin dev guide) and D10 (mark §4/§6 superseded).

Each step keeps the full suite green; shell and TS plugins coexist between steps
because the launcher swap is per-plugin.

## 7. Acceptance criteria

- All contract fixtures pass through the Vitest driver for all 11 plugins.
- `halo doctor` and an e2e dry run (`scripts/e2e-dry-run.sh`) pass with only
  `node`, `git`, `pnpm` (+ `gh`/`claude`/scheduler binaries where those ports are
  used) on PATH — no `jq`, no bash.
- CI green on the single ubuntu runner with the shell-test step removed.
- `grep -r '#!/usr/bin/env bash' plugins/` returns nothing.
