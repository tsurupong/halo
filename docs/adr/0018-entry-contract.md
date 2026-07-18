# ADR-0018: Plugin Entry Contract (Drop sh Launchers)

**Date**: 2026-07-18
**Status**: accepted
**Deciders**: Owner

## Context

ADR-0017 moved all bundled plugins to TypeScript but kept a thin POSIX `sh`
launcher per plugin directory (`exec node ".../main.js" "$@"`) as the spawn
target, on the reasoning that a `sh` launcher was the least surprising target
across platforms compared to a `#!/usr/bin/env node` shebang.

In practice the launcher layer kept the exact class of environment dependency
ADR-0017 set out to remove:

- The launcher must carry its executable bit, and this repo lives on NTFS/WSL
  (`/mnt/d`), where exec-bit and shebang handling of checked-out files has
  already proven fragile (ADR-0017 §Alternatives considered).
- `runPort` spawns the launcher path directly (`shell: false`), so `sh` itself
  must be resolvable on `PATH` — a dependency Windows-native execution does not
  satisfy at all, and one more moving part on any host.
- `halo enable` (`packages/cli/src/commands/enable.ts`) had to regenerate a
  launcher file, `chmod` it, and keep its relative `../../packages/plugins/dist/...`
  path in sync with the installed package layout (D11 §3) — logic that exists
  only to route around the launcher, not because of anything the port contract
  (D1) needs.

Node.js is already a hard requirement of the harness; nothing about the launcher
adds portability that spawning Node directly wouldn't already provide.

## Decision

Replace the `plugin.json` `exec` field with a mandatory `entry` field (path to
a JS module) plus an optional `aux` map (named auxiliary JS entry points, e.g.
`fire`/`install`/`uninstall` for trigger plugins), and drop the `sh` launcher
entirely:

1. **`plugin.json` breaking change**: `exec` is removed; `entry` (string,
   required) and `aux` (`Record<string, string>`, optional) are added to the
   manifest contract (`packages/contracts`), validated by
   `packages/core/src/discovery.ts` (`validatePluginManifest` rejects a
   manifest that still has `exec`, pointing at this ADR).
2. **Core spawns Node directly**: `packages/cli/src/core-ext/run-wiring.ts`
   (`makeRunner`) launches every plugin via
   `runPort({ execPath: process.execPath, args: [plugin.entryPath], ... })` —
   `runPort` itself (`packages/core/src/runPort.ts`) is unchanged; only the
   command it is told to spawn changes from a launcher path to `node` plus the
   resolved entry module.
3. **`HALO_PLUGIN_DIR` injection**: the child env gains `HALO_PLUGIN_DIR` (the
   plugin's own directory), giving a plugin a stable way to resolve sibling
   `aux` files or bundled assets without relying on `process.argv[1]` or a
   launcher-supplied `cwd` convention.
4. **`halo enable` writes only `plugin.json`**: `packages/cli/src/commands/enable.ts`
   resolves the installed `@tsurupong/halo-plugins` package at runtime and
   writes a `plugin.json` whose `entry`/`aux` are already absolute paths into
   `dist/` — no launcher file, no `chmod`, no shell.

## Alternatives Considered

### Alternative 1: Keep the `sh` launcher, fix exec-bit handling
- **Pros**: no manifest/contract change, no core/CLI code to touch.
- **Cons**: does not remove the `sh`/`PATH` dependency; still fails on native
  Windows; `halo enable`'s launcher-regeneration logic stays.
- **Why not**: the launcher was the thing under investigation, not an
  incidental detail — hardening it repeats the D10/ADR-0017 pattern of chasing
  environment-specific launcher failures instead of removing the launcher.

### Alternative 2: `#!/usr/bin/env node` shebang, no `sh`, no `exec` field change
- **Pros**: smaller diff; keeps `exec` pointing at a single file.
- **Cons**: still exec-bit-dependent; ADR-0017 already rejected this same
  approach for the launcher itself, for the same reason (fragile exec-bit /
  shebang handling on this repo's NTFS/WSL history).
- **Why not**: doesn't solve the exec-bit problem, only removes `sh` from it.

## Consequences

### Positive
- exec-bit, shebang, `PATH`, and `chmod` are no longer part of the plugin spawn
  path; `runPort` spawns `process.execPath` (an absolute path known to the
  running core) with the entry module as its sole argv, exactly as it already
  does for any other subprocess.
- Plugins run unmodified under native Windows Node (no POSIX `sh` requirement),
  removing the last WSL/NTFS-specific spawn concern from the bundled plugin set.
- `halo enable` (`packages/cli/src/commands/enable.ts`) drops all launcher
  generation and `chmod` logic; it now only absolutizes `entry`/`aux` paths and
  writes `plugin.json` (D11 §3, revised).
- `aux` gives multi-entry plugins (trigger-polling / trigger-schedule's
  `fire`/`install`/`uninstall`) a typed, discovered set of secondary entry
  points instead of shelling out with a subcommand argv.

### Negative
- Non-Node plugins are no longer supported by the bundled discovery/runner path
  — `entry` is always spawned as `node <entryPath>`. Third-party plugins
  written in another language have no contract-level path forward under this
  ADR (see Risks).
- `plugin.json: exec` is a breaking manifest change: any `.halo/ports/*.d/`
  directory built for v0.2.0 (via `halo enable` or hand-authored) fails
  discovery validation (`DiscoveryError`) until regenerated. This is a v0.3.0
  breaking release.

### Risks
- **Non-Node plugin authors have no migration path today.** Mitigation:
  `runPort`'s spawn seam already accepts an arbitrary `execPath`/`args`; a
  future `execArgv`-style manifest field (e.g. an explicit interpreter/command
  override) can reintroduce language-agnostic execution without touching
  `runPort` or the core loop. Deferred rather than designed now, since no
  concrete non-Node bundled or third-party plugin exists yet.
- **Silent breakage for existing `.halo/` trees on upgrade.** Mitigation: the
  validator raises a descriptive `DiscoveryError` naming `exec` and pointing at
  this ADR rather than failing silently or falling back; `halo enable` is the
  documented remediation.

## Supersedes

Supersedes ADR-0017 §Decision item 3 ("Thin POSIX `sh` launchers") and the
corresponding parts of D11 §3 (launcher generation). ADR-0017's other decisions
(TypeScript rewrite, unchanged port contract, Vitest contract tests, scheduler
module, single-runner CI) are unaffected and remain in force. ADR-0017 is
annotated with a "Superseded-by: ADR-0018 (launcher removal)" note; it is not
retracted in full.

## Related

ADR-0001 (unified contract), ADR-0017 (TypeScript plugins — launcher section
superseded here), D1 (contract spec — `entry`/`aux` manifest fields), D11
(TypeScript migration design — §3 revised here).
