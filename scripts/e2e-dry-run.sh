#!/usr/bin/env bash
# E2E dry-run smoke skeleton (T39, D8 §4). Offline, zero-billing wiring check:
# drives the *real* `halo run` CLI (MAX_ITER=1) against a throwaway git fixture
# repo whose executor/task-source/gate are tiny bash mocks — no network, no
# `claude`, no real GitHub. Proves the process boundary + worktree lifecycle +
# loop + iteration log all connect. The paid real-GitHub smoke is manual — see
# test/e2e/smoke.md (D8 §4.3).
#
# Usage:  bash scripts/e2e-dry-run.sh
# Exit:   0 = one dry-run iteration completed and iter_1.json was written.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${HALO_CLI:-$ROOT/packages/cli/dist/index.js}"

log() { printf '[e2e] %s\n' "$*"; }
fail() { printf '[e2e] FAIL: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || fail "git is required"
command -v jq >/dev/null || fail "jq is required (mock plugins emit JSON via jq)"
command -v node >/dev/null || fail "node is required"

# Ensure the CLI is built (build is cheap and offline once deps are installed).
if [[ ! -f "$CLI" ]]; then
  log "CLI not built at $CLI — building…"
  if command -v pnpm >/dev/null; then (cd "$ROOT" && pnpm -r build >/dev/null); else fail "pnpm not found and $CLI missing"; fi
fi

REPO="$(mktemp -d "${TMPDIR:-/tmp}/halo-e2e-XXXXXX")"
cleanup() {
  git -C "$REPO" worktree remove --force "${TMPDIR:-/tmp}/halo-wt-issue-1" 2>/dev/null || true
  rm -rf "$REPO"
}
trap cleanup EXIT

log "fixture repo: $REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email e2e@halo.local
git -C "$REPO" config user.name e2e
git -C "$REPO" config commit.gpgsign false

STATE="$REPO/.halo/state"
mkdir -p "$STATE" "$REPO/.halo/profiles"

# --- profile: 1 iteration, L1, short timeout ---
cat >"$REPO/.halo/profiles/e2e.env" <<EOF
AUTONOMY=L1
MAX_ITER=1
TIMEOUT=5m
EOF

# --- mock plugins under .halo/ports/*.d (target-repo resolution, D2 §6) ---
mkplugin() { # port dir exec  (body on stdin) [env-json]
  local port="$1" dir="$2" exec="$3" envjson="${4:-}"
  local d="$REPO/.halo/ports/${port}.d/${dir}"
  mkdir -p "$d"
  jq -n --arg n "@fx/$dir" --arg p "$port" --arg e "./$exec" --argjson env "${envjson:-null}" \
    '{name:$n, version:"1.0.0", port:$p, exec:$e} + (if $env == null then {} else {env:$env} end)' >"$d/plugin.json"
  cat >"$d/$exec"
  chmod +x "$d/$exec"
}

mkplugin task-source ts index.sh "$(jq -nc --arg s "$STATE" '{STATE_DIR:$s}')" <<'SH'
#!/usr/bin/env bash
set -uo pipefail
in="$(cat)"; op="$(printf '%s' "$in" | jq -r '.op // "next"')"
if [[ "$op" == "next" ]]; then
  if [[ -f "$STATE_DIR/served" ]]; then jq -cn '{task_id:null}'; else touch "$STATE_DIR/served"; jq -cn '{task_id:"1",title:"e2e",body:"dry-run one iteration"}'; fi
else jq -cn '{}'; fi
exit 0
SH

mkplugin executor ex run.sh <<'SH'
#!/usr/bin/env bash
# Mock executor: no claude, no billing. Echoes a done result (D8 §4 dry-run).
cat >/dev/null
jq -cn '{status:"done", summary:"mock executor: no-op dry run"}'
exit 0
SH

mkplugin gate 10-pass run.sh <<'SH'
#!/usr/bin/env bash
cat >/dev/null; exit 0
SH

git -C "$REPO" add -A
git -C "$REPO" commit -q -m "e2e fixtures"

# --- run one dry-run iteration ---
log "halo run e2e --dry-run --cwd $REPO"
set +e
node "$CLI" run e2e --dry-run --cwd "$REPO" --quiet
code=$?
set -e
[[ "$code" -eq 0 ]] || fail "halo run exited $code (expected 0)"

# --- assert the iteration log was produced (D8 §4.2 #7) ---
LOG="$REPO/.halo/logs/iter_1.json"
[[ -f "$LOG" ]] || fail "expected $LOG to be written"
outcome="$(jq -r '.outcome' "$LOG")"
[[ "$outcome" == "passed" ]] || fail "iter_1 outcome=$outcome (expected passed)"

log "OK — dry-run completed one iteration, iter_1.json outcome=$outcome"
log "PASS"
