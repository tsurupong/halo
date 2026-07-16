# ADR-0015: POSIX Portability Target and Scheduler Backend Abstraction

**Date**: 2026-07-16
**Status**: proposed
**Deciders**: Owner

## Context

HALO was bootstrapped on one specific environment: WSL2 (Arch) on Windows, with the repository on an NTFS mount. Several load-bearing pieces hardcode that environment:

- `plugins/trigger-{polling,schedule}/install.sh` register triggers exclusively via Windows `schtasks.exe` + `wsl.exe`. On a Linux server, macOS, or a CI container, trigger installation is impossible.
- `plugins/trigger-*/fire` re-homes `PATH` to a fixed list that omits `$HOME/.local/bin` (where `claude` commonly lives) and invokes `halo run` without `--cwd`, inheriting the scheduler's undefined working directory. Both caused real overnight failures on 2026-07-15.
- Shell plugins assume `jq`, GNU `timeout`, and `bash` exist, with no preflight verification; `doctor`'s placement check (ext4-vs-NTFS) is WSL-specific but runs unconditionally.
- Core uses POSIX process groups (`kill(-pid)`) and `$TMPDIR`/`/tmp` for locks and worktrees.

"Run identically everywhere" needs a defined "everywhere".

## Decision

1. **Portability target is POSIX**: Linux, macOS, WSL2, and Linux CI containers, with bash >= 3.2, git, Node >= 22. Native Windows (non-WSL) is explicitly out of scope — the process-group kill model, lock semantics, and shell plugins would all need a parallel implementation.
2. **Scheduler access goes through a backend abstraction**: trigger `install.sh`/`uninstall.sh` detect and delegate to the first available backend, in order: `schtasks` (WSL with interop), `systemd` user timers, `cron` (crontab), `launchd` (macOS). Detection is overridable via `HALO_SCHEDULER` for deterministic setups. The `fire` contract (argv: profile name, no stdin) is backend-independent and unchanged.
3. **Environment facts are verified, not assumed**: `doctor` gains checks for the required external commands (`jq`, `timeout`, `git`, `claude`) and reports the detected scheduler backend; WSL-specific checks run only when WSL is detected.
4. **Portability is CI-enforced**: the workflow matrix runs on `ubuntu-latest` and `macos-latest`, so "works on both" is a gate, not a hope.

## Alternatives Considered

### Alternative 1: Support native Windows too
- **Pros**: Truly universal.
- **Cons**: No POSIX process groups (kill-tree rewrite), no bash plugins without WSL/git-bash, different lock/tmpdir semantics. Roughly a second implementation of the execution layer.
- **Why not**: All current and foreseeable deployments have a POSIX layer available. Cost is disproportionate to demand.

### Alternative 2: One scheduler backend per plugin directory (`trigger-polling-cron`, `trigger-polling-schtasks`, …)
- **Pros**: Follows the existing one-plugin-one-implementation naming convention.
- **Cons**: Multiplies 2 triggers x 4 backends into 8 near-identical plugins; the user must know their backend before installing; fixtures and tests octuple.
- **Why not**: The port boundary is "trigger", not "scheduler". Backend choice is an environment fact, best auto-detected inside the adapter.

### Alternative 3: Replace OS schedulers with a long-running daemon (`halo daemon`)
- **Pros**: No external scheduler dependency at all.
- **Cons**: Loses the WSL2 property that a Windows-side trigger boots the stopped VM; adds supervision/restart/log-rotation problems the OS scheduler already solves.
- **Why not**: Contradicts the design decision (design 04 §4.3) that the primary trigger lives outside the VM. A daemon can be a later, additional backend.

## Consequences

### Positive
- The same repository + `.halo/` setup installs and runs on a Linux box, macOS laptop, WSL2, or CI without editing scripts.
- The two field-verified fire bugs (PATH re-homing, missing `--cwd`) are fixed at the source instead of in per-machine patched copies.
- `doctor` tells the operator *before* an overnight run which dependency or scheduler is missing.

### Negative
- Backend detection adds a matrix of environments the contract tests must simulate (mitigated: detection is a pure function over injected probe results, tested without real schedulers).
- macOS `launchd` and `cron` cannot boot a stopped WSL2 VM; on WSL the `schtasks` backend remains first-priority for that reason. Accepted and documented.
- Native Windows users must use WSL2. Accepted.
