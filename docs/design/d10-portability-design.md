# D10: Portability Design — Run Identically on Any POSIX Environment

Related: ADR-0015 (POSIX target + scheduler abstraction), 04 (trigger/profiles/preflight), D3 (CLI spec), D5 (plugin dev guide), D7 (ops runbook), D9 (reliability design).

## 1. Scope and goals

Make the same repository + `.halo/` setup behave identically on Linux, macOS, WSL2, and Linux CI containers (ADR-0015 target definition). Five workstreams, ordered by rollout:

| # | Workstream | Mechanism | Footprint |
|---|------------|-----------|-----------|
| 1 | Fire script correctness | PATH + `--cwd` fixes in `trigger-*/fire` | 2 plugin scripts |
| 2 | Scheduler backend abstraction | detect + delegate in `install.sh`/`uninstall.sh` | trigger plugins + shared lib |
| 3 | Environment verification | new `doctor` checks | core `doctor.ts` + CLI probes |
| 4 | Plugin runtime portability | dependency preflight, GNU/BSD-safe idioms | shell plugins |
| 5 | CI portability gate | ubuntu + macos matrix | `.github/workflows/ci.yml` |

Non-goals: native Windows support, a `halo daemon` scheduler backend, changes to the fire contract or any port schema.

## 2. Workstream 1 — fire script correctness

Field-verified bugs (2026-07-15 overnight run), fixed at the source:

```bash
# PATH re-homing keeps user-local bin dirs; extendable without editing the script.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin${HALO_PATH_EXTRA:+:$HALO_PATH_EXTRA}"
...
# The scheduler's cwd is undefined; the target repository must be explicit.
exec "$HALO_BIN" run "$PROFILE" --cwd "$HALO_HOME"
```

`HALO_HOME` remains the target-repository root (existing convention; `triggers.ts` already embeds it at install time). Applies to both `trigger-polling/fire` and `trigger-schedule/fire`.

## 3. Workstream 2 — scheduler backend abstraction

### 3.1 Layout

Backend logic lives in one shared library sourced by both trigger plugins:

```
plugins/
  lib/scheduler.sh          # detection + per-backend install/uninstall functions
  trigger-polling/
    install.sh              # parses interval, calls scheduler_install "$SPEC"
    uninstall.sh
    fire                    # unchanged contract (argv: profile)
  trigger-schedule/         # same shape, calendar spec instead of interval
```

`plugin.json` and the fire contract are untouched; discovery and `triggers.ts` need no changes.

### 3.2 Detection (pure, injectable)

```bash
scheduler_detect() {            # echoes: schtasks | systemd | cron | launchd | none
  [[ -n "${HALO_SCHEDULER:-}" ]] && { echo "$HALO_SCHEDULER"; return; }
  is_wsl && command -v schtasks.exe >/dev/null && { echo schtasks; return; }
  command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 \
    && { echo systemd; return; }
  command -v crontab >/dev/null && { echo cron; return; }
  [[ "$(uname -s)" == Darwin ]] && command -v launchctl >/dev/null && { echo launchd; return; }
  echo none
}
is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }
```

Priority rationale: on WSL only `schtasks` can boot a stopped VM (04 §4.3), so it wins there; `systemd` user timers beat `cron` where present (better logging, no mail spam); `launchd` is the macOS native path. `none` → install fails loudly with the detection report.

### 3.3 Backend mapping

One neutral spec is translated per backend. `INTERVAL_MIN` (polling) and `START_TIME` (schedule) keep their existing env names.

| Backend | polling (every N min) | schedule (daily HH:MM) | identity/cleanup key |
|---|---|---|---|
| schtasks | `/SC MINUTE /MO N` (existing behavior) | `/SC DAILY /ST HH:MM` | task name `HALO_<profile>` |
| systemd | transient user timer `OnCalendar=*:0/N` | `OnCalendar=*-*-* HH:MM` | unit `halo-<trigger>-<profile>.timer` in `~/.config/systemd/user/` |
| cron | `*/N * * * * <env> <fire> <profile>` | `MM HH * * * …` | line marker comment `# HALO:<trigger>:<profile>` |
| launchd | `StartInterval` = N*60 | `StartCalendarInterval` | label `dev.halo.<trigger>.<profile>`, plist in `~/Library/LaunchAgents/` |

Shared rules for every backend:

- **Env embedding**: `HALO_HOME`/`HALO_BIN` are embedded into the scheduled command exactly as today, with the same `^[A-Za-z0-9/._-]+$` injection guard (schtasks install.sh already does this; the guard moves into `scheduler.sh`).
- **Idempotency**: install = remove-then-add under the identity key; uninstall of a missing entry exits 0.
- **Uninstall symmetry**: `scheduler_uninstall` uses the same detection, overridable by `HALO_SCHEDULER` so a machine that changed state can still clean up.

### 3.4 Contract tests

`test.contract.sh` per trigger plugin stubs the backend binaries (`schtasks.exe`, `systemctl`, `crontab`, `launchctl` as PATH-prepended fakes writing their argv to files) and asserts:
(a) detection order and `HALO_SCHEDULER` override; (b) per-backend command shape incl. embedded env and injection-guard rejection; (c) idempotent double-install; (d) uninstall symmetry; (e) `none` → non-zero exit with actionable message. Zero real scheduler mutation.

## 4. Workstream 3 — doctor environment verification

New checks in `packages/core/src/doctor.ts` (same pure-check + injected-probe pattern as the existing nine):

| Check | Probe | Fail condition | Hint |
|---|---|---|---|
| c10 required commands | `command -v` for `jq`, `timeout`, `git`, `claude` | any missing | per-OS install hint (`pacman -S jq` / `brew install coreutils jq` …) |
| c11 scheduler backend | `scheduler_detect` equivalent via probes | `none` | list what was probed and how to set `HALO_SCHEDULER` |

Change to existing behavior: c8 (ext4 placement) becomes conditional — it only runs when WSL is detected (probe: `/proc/version` contains "microsoft"); elsewhere it reports `skipped`. `DoctorProbes` gains `isWsl()`, `commandExists(name)`, `schedulerBackend()` — all injected, so tests stay fs/exec-free.

## 5. Workstream 4 — plugin runtime portability

- **Dependency preflight**: a shared `plugins/lib/require.sh` provides `require_cmds jq timeout …`; each shell plugin calls it first and emits its port's safe-side output (gate → fail with reason, executor → `{"status":"stuck", summary}`, best-effort ports → stderr + exit 0) instead of dying mid-script with a cryptic error.
- **GNU/BSD-safe idioms**: no `grep -P`, no `sed -i` without suffix, no `mapfile`/`readarray` (bash 3.2), no `date -d`. Existing scripts are already close; a one-time audit fixes stragglers. `timeout` stays required (macOS: `brew install coreutils`) rather than reimplemented — doctor c10 makes the requirement visible.
- **Exec-bit independence**: NTFS checkouts lose the exec bit. Wherever HALO itself launches a plugin (`runPort` via `discovery.execPath`) the manifest `exec` is already invoked directly; discovery gains a fallback: if the exec file exists but is not executable and is a `*.sh`/extension-less script with a shebang, spawn it as `bash <path>`. This removes the recurring 30-file chmod dance on NTFS.

## 6. Workstream 5 — CI portability gate

`.github/workflows/ci.yml` runs the full suite (`build`, `test`, `lint`, `test:contract`, plus each plugin's `test.contract.sh`) on a matrix of `ubuntu-latest` and `macos-latest`. The trigger contract tests exercise all four backends via stubs on both OSes, so backend regressions surface regardless of the developer's own machine.

## 7. Rollout order and verification

1. WS1 (fire fixes) — smallest, field-verified; ship first. Verify: contract test asserting `--cwd` and PATH content of the generated command line.
2. WS3 (doctor) — visibility before behavior change. Verify: unit tests over injected probes; `halo doctor` run on WSL shows schtasks backend.
3. WS2 (scheduler abstraction) — the core of the ADR. Verify: contract tests (all backends, both triggers); live `install`/`uninstall` smoke on WSL (schtasks) and on one systemd or cron environment.
4. WS4 (plugin portability) — mechanical sweep. Verify: `bash -n` + contract tests green; NTFS checkout with stripped exec bits still runs the loop.
5. WS5 (CI matrix) — lock it in. Verify: green matrix run on GitHub Actions.

## 8. Adjustable defaults (要件 §11.2)

| Name | Default | Where |
|---|---|---|
| `HALO_SCHEDULER` | auto-detect | trigger install/uninstall, doctor |
| `HALO_PATH_EXTRA` | (empty) | fire scripts |
| `HALO_POLL_INTERVAL_MIN` | 15 | polling install (existing) |
| `HALO_SCHEDULE_TIME` | 03:00 | schedule install (existing) |
