# D5. Plugin Development Guide (HALO Plugin Development Guide)

| Item | Content |
|---|---|
| Document version | 1.0 |
| Prerequisites | HALO Requirements Specification v1.8 / D1 Contract Specification v1.0 are the governing upper-level documents |
| Positioning | **Public — the linchpin of ecosystem formation**. A public tutorial for third-party developers |
| Public/Private | Public (OSS) |
| Authoring timing | Before OSS release (Phase 3 as a guideline). Can begin once D1 is finalized |

> This guide takes the I/O types, exit codes, and `plugin.json` fields defined by the **D1 Contract Specification** and turns them into practical guidance on how to actually write them. The formal definition of the contract is always authoritative in D1. If any description here appears to conflict with D1, treat D1 as correct and report the relevant passage here as an issue.

---

## 0. Introduction — What is a HALO plugin

The HALO core (`packages/core`, TypeScript implementation) holds only the "skeleton" of the autonomous coding loop. Where to fetch tasks from, how to inspect artifacts, where to deliver passing artifacts — **all of these concrete behaviors are delegated to plugins (adapters)**.

The only point of contact between plugins and the core is the **process boundary**. The core launches each plugin as a single process and communicates through only the following three channels:

1. Passes a single JSON object on **stdin**
2. Receives a single JSON object from **stdout** (only for ports that require output)
3. Determines pass/fail and success/failure via the **exit code** (`0` = pass, `2` = fail, others = error)

Because these three points are the entire contract, **plugins can be written in any language**. Even though the core is TypeScript, your plugin can be bash, Python, or Go. This guide shows examples in two languages, TypeScript (Node) and bash.

> **Note (ADR-0017 / D11, 2026-07-16):** all bundled plugins are now TypeScript in
> `packages/plugins`, spawned through thin POSIX `sh` launchers kept in `plugins/<name>/`
> (the `plugin.json` contract below is unchanged). Their behavior tests are Vitest files
> next to the sources (`packages/plugins/src/<name>/<name>.test.ts`); the bash examples in
> this guide remain valid for third-party plugins.

```
      ┌─────────────┐   stdin(JSON)   ┌──────────────────┐
      │  HALO core  │ ───────────────▶│  your plugin     │
      │  (loop)     │ ◀─────────────── │  (any language)  │
      └─────────────┘  stdout(JSON)    └──────────────────┘
                     ▲  exit code 0/2/other
```

Your plugin belongs to exactly one of the **9 ports** (task-source / context / executor / gate / sink / on-fail / runtime / kind / trigger). The input shape, whether output is required, and the decision method differ per port (§2).

---

## 1. How to build a minimal plugin

A plugin can be constituted from a minimum of 2 files.

```
my-plugin/
├── plugin.json   ← manifest (the core reads its metadata)
└── <executable>  ← the file that plugin.json's exec points to
```

### 1.1 Required fields of plugin.json

`plugin.json` is formally defined in D1 §2. Only 4 fields are required.

| Field | Required | Description |
|---|---|---|
| `name` | ✓ | Plugin identifier (e.g. `@halo/plugin-*`) |
| `version` | ✓ | The plugin's own semver (`^\d+\.\d+\.\d+...`) |
| `port` | ✓ | The port it belongs to (one of `task-source`/`context`/`executor`/`gate`/`sink`/`on-fail`/`runtime`/`trigger`) |
| `exec` | ✓ | Relative path to the executable (bash/node/python all acceptable) |

Optional fields are `order` (execution order), `minAutonomy` (autonomy filter for sink etc.), `timeoutSec` (timeout), and `env` (environment variables to inject). See D1 §2 for details.

> It is `additionalProperties: false`. Adding a key not in the D1 schema will fail validation.

### 1.2 Example A — gate plugin (TypeScript / Node)

Let's build a gate that inspects "whether `console.log` remains in changed files." A gate **returns pass/fail via the exit code** (`0` = pass / `2` = fail). It writes the reason JSON to stdout only when it fails.

`my-gate/plugin.json`:

```json
{
  "name": "@example/plugin-gate-no-console",
  "version": "1.0.0",
  "port": "gate",
  "exec": "./check.mjs",
  "order": 25,
  "timeoutSec": 30
}
```

`my-gate/check.mjs`:

```javascript
#!/usr/bin/env node
// gate plugin: fail (exit 2) if console.log remains in the changed files.
// input (stdin): { task_id, workdir, changed_files } ... D1 §1.4 gate.in
// output (stdout): { reason, hint?, gate? } only on fail ... D1 §1.4 gate.out
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// --- read a single JSON from stdin ---
const input = JSON.parse(readFileSync(0, 'utf8'));
const { workdir, changed_files = [] } = input;

// --- inspection ---
const offenders = [];
for (const rel of changed_files) {
  if (!/\.(js|mjs|ts|tsx)$/.test(rel)) continue;
  let src = '';
  try {
    src = readFileSync(join(workdir, rel), 'utf8');
  } catch {
    continue; // ignore deleted files, etc.
  }
  if (/\bconsole\.log\s*\(/.test(src)) offenders.push(rel);
}

// --- return the verdict via the "exit code" ---
if (offenders.length === 0) {
  process.exit(0); // pass. write nothing to stdout
}

// only on fail, write the reason JSON (a single one) to stdout
process.stdout.write(
  JSON.stringify({
    reason: `console.log remains in ${offenders.length} place(s)`,
    hint: offenders.join(', '),
    gate: '25-no-console',
  })
);
process.exit(2); // fail
```

Verifying behavior (invoking the plugin standalone by hand):

```bash
echo '{"task_id":"T-1","workdir":"/tmp/wt","changed_files":["src/a.ts"]}' \
  | node my-gate/check.mjs
echo "exit=$?"
```

### 1.3 Example B — gate plugin (bash)

Writing the same gate in bash looks like the following. In bash, using `jq` for JSON parsing is the concise approach.

`my-gate-sh/plugin.json`:

```json
{
  "name": "@example/plugin-gate-no-console-sh",
  "version": "1.0.0",
  "port": "gate",
  "exec": "./check.sh",
  "order": 25,
  "timeoutSec": 30
}
```

`my-gate-sh/check.sh`:

```bash
#!/usr/bin/env bash
# gate plugin (bash version): fail (exit 2) if console.log remains.
# progress/warnings go to stderr. stdout is a JSON-only channel (D1 §3.2).
set -euo pipefail

input="$(cat)"                                   # read all of stdin's JSON
workdir="$(jq -r '.workdir' <<<"$input")"
mapfile -t files < <(jq -r '.changed_files[]? // empty' <<<"$input")

offenders=()
for rel in "${files[@]}"; do
  case "$rel" in *.js|*.mjs|*.ts|*.tsx) ;; *) continue ;; esac
  path="$workdir/$rel"
  [[ -f "$path" ]] || continue
  if grep -qE '\bconsole\.log\s*\(' "$path"; then
    offenders+=("$rel")
    echo "found console.log in $rel" >&2         # diagnostics go to stderr
  fi
done

if [[ ${#offenders[@]} -eq 0 ]]; then
  exit 0                                          # pass
fi

# fail: write exactly one reason JSON to stdout
jq -cn --arg hint "$(IFS=,; echo "${offenders[*]}")" \
  --arg reason "console.log remains in ${#offenders[@]} place(s)" \
  '{reason:$reason, hint:$hint, gate:"25-no-console"}'
exit 2
```

> **Important (D1 §3.2)**: stdout is JSON-only. Mixing debug output such as `echo "debug..."` into stdout will break the core's JSON parsing. Human-readable progress and warnings must always be written to **stderr**. The core merely saves stderr to `.halo/logs/iter_N.json` and it does not affect pass/fail (D1 §3.3).

### 1.4 Placing and enabling it

To enable the gate you built in the target repository, place it as a whole directory under `ports/gate.d/` (see §5 for placement details).

```
.halo/ports/gate.d/25-no-console/
├── plugin.json
└── check.mjs
```

Removing it disables it (the `conf.d` scheme, D1 §0-3). The execution order is determined by `order` (or, when absent, the numeric prefix of the filename).

---

## 2. Implementation points per port (9 ports)

This summarizes the "port responsibilities list" of D1 §1 from an implementer's perspective. **Input is always a single JSON on stdin.** Output and decision differ per port.

| # | Port | How it is run | stdout output | Decision | Most important implementation point |
|---|---|---|---|---|---|
| ① | task-source | Single (first only) | Yes (`op=next` only) | Exit code | Branch on `op`. No task means `{"task_id":null}`+exit 0 |
| ② | context | Multiple (all run, merged) | Yes (`fragments`) | Always treated as success | Return light summaries only. Do not dig deep |
| ③ | executor | Single (first only) | Yes (`status`) | stdout `status` + exit code | Declare `done`/`stuck`/`timeout` via `status` |
| ④ | gate | Multiple (all run, logical AND) | Only on fail | Exit code (0=pass/**2=fail**) | The decision is the **exit code**, not the output |
| ⑤ | sink | Multiple (all run, independent) | None | Best-effort | Declare `minAutonomy` |
| ⑥ | on-fail | Multiple (all run, independent) | None | Best-effort | Do not let an individual failure propagate to others |
| ⑦ | runtime | Bundle (setup/check/test) | None | Exit code (0/**2**) | A bundle of 3 scripts. Selection is via `.harness.yml` |
| ⑧ | kind | Not a port | — | — | A declaration in `.harness.yml` (not an executable) |
| ⑨ | trigger | Bundle (install/uninstall/fire) | None | Exit code | Has no stdin JSON. `fire` is the only entry point |

The essentials of each port follow.

### 2.1 ① task-source

Input is a oneOf distinguished by `op` (`next`/`complete`/`fail`). Only when `op=next` does it return task JSON to stdout.

- **Declaring no tasks**: if 0 tasks are ready, output `{"task_id": null}` and **exit 0**. The core sees this and ends the loop immediately. It must not error out here.
- `complete` / `fail` produce side effects only and require no output (exit 0 = success).
- Locking to prevent duplicate acquisition of the same task (for GitHub, relabeling `ready` → `in-progress`) is the responsibility of the task-source side.
- The `spec_refs` in the output are **kg:// URIs** (`kg://<type>/<id>`), not file paths (D1 §4). They may be empty in Phases 1–3.

Minimal `op=next` output:

```json
{ "task_id": "T-012", "title": "...", "body": "...", "kind": "code" }
```

### 2.2 ② context

Input is the `op=next` output of task-source itself (task information). Output is a `fragments` array.

- Each fragment is `{ source, content, priority }` (all three required).
- **The larger the priority, the higher the precedence.** The core concatenates in descending order and truncates at the token limit (under 100k).
- **Injecting only light summaries** is the design philosophy (hybrid scheme, D1 §1.2). Keep it to an impact-scope summary at most; deep dives are fetched by the AI via MCP tools during execution. Do not stuff large amounts of code here.
- All context plugins are run and their results are merged. Since it is always treated as success, on failure it is fine to return empty `fragments`.

### 2.3 ③ executor

The core that runs the prompt. The initial adapter is `claude -p` (headless).

- Input: `{ prompt, workdir, budget:{ max_turns, timeout_sec, max_budget_usd? } }`. `max_budget_usd` is optional (ADR-0021): pass it to the runtime's budget stop if supported, otherwise ignore it — the core's accumulated-cost preflight check is the backstop either way.
- Output: `{ status, summary, cost? }`. If **`status` is anything other than `done`** (`stuck`/`timeout`), the core drops into the failure path (on-fail).
- If the agent gets stuck, return `status: "stuck"`. There is also a convention where the agent itself emits a `STUCK:` marker in the artifacts (D1 §5) — the executor adapter detects it and converts it to `status: "stuck"`.
- Abnormal termination of the process itself is treated as an error. As a principle, the decision is made via the stdout `status`.
- Use `--strict-mcp-config` to have it read only the harness-managed `mcp.json` (reproducibility and security).
- Permission profile (Claude Code adapters): inject the HALO-managed deny set via `--settings "$HALO_SETTINGS_FILE"` (D4 §2.4, ADR-0019) and launch with `--permission-mode dontAsk` + a minimal `--allowedTools` list (ADR-0020) — listed tools run unprompted, everything else is denied outright. Never default to `bypassPermissions`; it approves all tools and voids the allowlist boundary.

### 2.4 ④ gate

**The decision is the exit code, not stdout.** This is the most error-prone point.

- `exit 0` = pass, `exit 2` = fail (same convention as Claude Code hooks). **Abnormal termination other than exit 2 is also treated as fail, erring on the safe side.**
- Only on fail does it write `{ reason, hint?, gate? }` to stdout. On pass it writes nothing to stdout.
- gate.d is run in full in numeric order, and **if even one fails, the whole thing fails** (logical AND). The `reason` of a failure is re-injected into the next iteration's prompt.
- The idiom is to make `10-typecheck`/`20-lint`/`30-test` thin wrappers that hold no actual commands and delegate to the adopted runtime's `check.sh`/`test.sh` (§2.7).

### 2.5 ⑤ sink

Side effects after passing (commit / PR creation / log recording). No output.

- **Declaring `minAutonomy` is essentially required.** The core skips any sink below the current `AUTONOMY`.

  | AUTONOMY | Effective sinks (initial configuration) |
  |---|---|
  | L1 | `20-progress-log` only |
  | L2 | `20-progress-log` / `10-git-commit` / `15-create-pr` (**draft PR**) |
  | L3 | All L2 sinks + `15-create-pr` (**normal PR**) |

  `15-create-pr` is enabled with `minAutonomy: "L2"` and reads the `AUTONOMY` env to differentiate: a draft PR at L2 and a normal PR at L3 (branching within a single sink). Autonomy is cumulative (L3 ⊇ L2 ⊇ L1).

- If `minAutonomy` is **left undeclared, it errs to the safest side (equivalent to L3)** and is skipped at L1/L2 (D1 §2). If you want a reporting sink to run even at L1, explicitly write `"minAutonomy": "L1"`.
- Best-effort. If one sink fails, the other sinks continue. Do not give a sink side effects that drag in other sinks.

### 2.6 ⑥ on-fail

Run in full in numeric order on gate fail or executor stuck/timeout. No output.

- Input: `{ task_id, reason, retry_count, gate?, workdir? }`.
- Best-effort (an individual failure does not propagate to others).
- Typical configuration: `10-record-failure` (appends to `.halo/failure-catalog.md`) / `20-escalate` (adds `needs-human` when `retry_count` reaches the threshold of 3) / `30-suggest-sign` (outputs PROMPT improvement candidates).
- The recorded failure is read by context.d (`30-recent-failures`) and re-injected into the next iteration (the "failure → record → re-inject" learning path).

### 2.7 ⑦ runtime

Absorbs not the "language" but the "**kind of artifact**." Unlike other ports, it is a directory bundle.

```
ports/runtime.d/<name>/
├── setup.sh   # env injection + dependency materialization + cache externalization
├── check.sh   # static check (exit 2 = fail)
└── test.sh    # dynamic verification (exit 2 = fail)
```

- All 3 scripts share the common input `{ workdir, changed_files? }`, and the decision is **exit 0=pass / exit 2=fail**.
- Selection is by the `runtimes` declaration in `.harness.yml`. **It has no `detect.sh`** (no implicit auto-detection).
- `setup.sh` materializes dependencies quickly (pnpm hardlinks / uv links / rust's shared `CARGO_TARGET_DIR`).
- **WSL2 placement constraint**: link-based sharing is effective only within the same file system. Place worktree, store, and cache on the ext4 side (under `/home`). Placement under `/mnt/c/` is forbidden (D1 §1.7).

### 2.8 ⑧ kind

Not a port script. It is a declaration in the **`.harness.yml` required at the target repository root**. It looks up the runtime group and prompt from the Issue's `kind:<name>` label (`code` when unspecified).

```yaml
kinds:
  code:
    runtimes: [node-pnpm]
    prompt: prompts/code.md
  docs:
    runtimes: [docs-md]
    prompt: prompts/docs.md
```

A repository without `.harness.yml` does not run tasks and gets `needs-human` (no implicit auto-detection).

### 2.9 ⑨ trigger

The core's launch mouth. **It has no stdin JSON contract** (the only argument is the profile name). A bundle of 3 scripts.

```
ports/trigger.d/<name>/
├── install.sh    # register the trigger (scheduler/timer, etc.)
├── uninstall.sh  # unregister
└── fire          # launch entry the OS invokes = absolute path to node_modules/.bin/halo run <profile>
```

- `fire` is the **only entry point** that launches the halo CLI. In unattended execution, it invokes the absolute path to `.bin` directly without going through `npx` (version-pinned, network-independent).
- Everything below the CLI (preflight, loop, port group) does not know "what the trigger is." Keep it swappable.

### 2.10 Supplement — mcp.d

Not a port, but MCP configuration fragments passed to the executor. It merges `ports/mcp.d/*.json` and generates `.halo/mcp.json` at launch. Each fragment conforms to the MCP server definitions under the `mcpServers` key.

---

## 3. Explanation of the 4 samples

HALO bundles 4 sample plugins. They are the most useful reference as a starting point for implementation.

### 3.1 task-source-github (① task-source)

An adapter that makes GitHub Issues the source of tasks. It uses the `gh` CLI.

- `op=next`: fetches the head of `gh issue list --label ready` and relabels `ready` → `in-progress` (a lock to prevent duplicate acquisition). It shapes the fetched result into `{ task_id, title, body, kind }` for stdout. If 0 tasks are ready, `{"task_id": null}` + exit 0.
- `op=complete`: records completion. It assumes `Closes #<number>` in the PR body auto-closes the Issue on merge.
- `op=fail`: records the retry count in an Issue comment. If the same Issue fails **3 times** (initial value), it adds the `needs-human` label and escalates to a human (breaking the infinite loop).
- `kind` derives from the Issue's `kind:<name>` label (`code` when unspecified).

Implementation skeleton (bash / `gh` + `jq`):

```bash
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
op="$(jq -r '.op' <<<"$input")"
case "$op" in
  next)
    issue="$(gh issue list --label ready --state open --limit 1 \
      --json number,title,body,labels | jq '.[0] // null')"
    if [[ "$issue" == "null" ]]; then
      echo '{"task_id":null}'; exit 0            # no task
    fi
    num="$(jq -r '.number' <<<"$issue")"
    gh issue edit "$num" --add-label in-progress --remove-label ready >&2
    jq -cn --arg id "T-$num" \
      --arg title "$(jq -r '.title' <<<"$issue")" \
      --arg body  "$(jq -r '.body'  <<<"$issue")" \
      '{task_id:$id, title:$title, body:$body, kind:"code"}'
    ;;
  complete) exit 0 ;;                             # side effects only
  fail)
    num="$(jq -r '.task_id' <<<"$input" | sed 's/^T-//')"
    rc="$(jq -r '.retry_count' <<<"$input")"
    gh issue comment "$num" --body "fail #$rc: $(jq -r '.reason' <<<"$input")" >&2
    [[ "$rc" -ge 3 ]] && gh issue edit "$num" --add-label needs-human >&2
    exit 0 ;;
esac
```

### 3.2 runtime-node-pnpm (⑦ runtime)

A runtime bundle that handles Node/TypeScript artifacts. 3 scripts.

- `setup.sh`: `pnpm install --offline` (fast materialization from the store via hardlink sharing). Place `store-dir` on the ext4 side.
- `check.sh`: `tsc --noEmit` and `eslint`. If either fails, **exit 2**.
- `test.sh`: `vitest run`. If it fails, **exit 2**.

Skeleton of `check.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail
workdir="$(jq -r '.workdir' < /dev/stdin)"
cd "$workdir"
pnpm exec tsc --noEmit    >&2 2>&1 || exit 2   # diagnostics to stderr, fail is exit 2
pnpm exec eslint .        >&2 2>&1 || exit 2
exit 0
```

> gate.d's `10-typecheck`/`30-test` become thin wrappers that merely call this runtime's `check.sh`/`test.sh`. Do not duplicate the commands on the gate side (DRY).

### 3.3 gate-loop-audit (④ gate)

The structural inspection gate for **self-modification prevention** (Requirements §11.1). It is the most important gate, bearing HALO's safety invariant, and is placed as `50-loop-audit`.

Inspection content (formally defined by the D4 Security Design; the gate's I/O is in scope for this guide):

- Whether the change rewrites protected targets (the core itself, port definitions, security settings, etc.).
- Whether each **kg:// URI in `spec_refs` points to an existing node** (existence verification, D1 §4.2). If it does not exist, fail.
- Other structural checks (the 7 checks of Requirements §11.1).

Since it is a gate, the input is `{ task_id, workdir, changed_files }`, and only on fail does it output `{ reason, hint?, gate:"50-loop-audit" }` and exit 2. The kg:// resolution itself is delegated to a private plugin (knowledge MCP, under D6's purview), but the essence is that **this gate makes the final decision on "whether the reference exists" via the exit code**.

### 3.4 trigger-polling (⑨ trigger)

A trigger that picks up ready tasks via high-frequency scheduled launches. It is the initial implementation paired with `schedule/` (scheduled launch).

- `install.sh`: registers a high-frequency periodic run in the OS scheduler (Windows Task Scheduler etc.), having each run invoke `fire`.
- `uninstall.sh`: unregisters.
- `fire`: launches the absolute path of `node_modules/.bin/halo run <profile>`.
- The point is "**exit immediately if 0 tasks are ready**." If task-source returns `{"task_id":null}`, the core exits 0 immediately, so the cost of a miss is small even under high-frequency polling.

---

## 4. How to write contract tests (JSON Schema validation)

Because plugins can be any language, **self-validating at runtime against the distributed JSON Schema** is the only common type-safety measure (D1 §6). Every sample plugin must have contract tests.

### 4.1 Single source and distributed Schema

The single source of truth for the contract is the **TypeScript type definitions** in `packages/contracts`. From there, JSON Schema (Draft 2020-12) is auto-generated and bundled/distributed with the public package (`$id` is `https://halo.dev/contracts/<port>.<io>.json`). Non-TS plugins run this `*.json` Schema through a generic validator.

### 4.2 What to validate

| Target | Schema to use |
|---|---|
| The **input example** the plugin receives | `<port>.in.json` (for gate, `gate.in.json`) |
| The **output** the plugin returns | `<port>.out.json` (for gate fail, `gate.out.json`) |
| `plugin.json` itself | `plugin.json` (the manifest schema) |

> context's input is task-source's `op=next` output, so use `task-source.out.json`. sink/on-fail/runtime/trigger have no output Schema (side-effect centric). See D1 Appendix A for details.

### 4.3 Example — validating output with the ajv CLI (language-independent)

A contract test that validates whether the fail output of `gate-no-console` conforms to `gate.out.json`:

```bash
#!/usr/bin/env bash
# contract test: feed an example input to the plugin and validate the output against the distributed Schema.
set -euo pipefail
SCHEMA_DIR="node_modules/@halo/contracts"        # location of the distributed Schema

# 1) example input that induces a fail (assumes gate.in.json conformance)
input='{"task_id":"T-1","workdir":"/tmp/wt","changed_files":["src/a.ts"]}'

# 2) run the plugin and capture stdout (allow exit 2)
set +e
out="$(echo "$input" | node ./check.mjs)"
code="$?"
set -e

# 3) exit code contract: fail must be 2
[[ "$code" -eq 2 ]] || { echo "expected exit 2, got $code" >&2; exit 1; }

# 4) validate the output against gate.out.json
echo "$out" | npx ajv validate -s "$SCHEMA_DIR/gate.out.json" -d /dev/stdin \
  --spec=draft2020 || { echo "output violates gate.out.json" >&2; exit 1; }

echo "contract test passed"
```

### 4.4 Example — validating a TS plugin's types with Vitest

A TS plugin can import the type definitions directly and keep the contract at compile time, but it is desirable to also nail down the runtime I/O with a contract test.

```typescript
// check.contract.test.ts
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import gateOut from '@halo/contracts/gate.out.json' assert { type: 'json' };
import { execFileSync } from 'node:child_process';

const ajv = new Ajv2020();
const validateOut = ajv.compile(gateOut);

describe('gate-no-console contract', () => {
  it('returns gate.out.json-conformant JSON with exit 2 on fail', () => {
    const input = JSON.stringify({
      task_id: 'T-1',
      workdir: '/tmp/wt',
      changed_files: ['src/a.ts'],
    });
    let stdout = '';
    let code = 0;
    try {
      stdout = execFileSync('node', ['./check.mjs'], { input }).toString();
    } catch (e: any) {
      code = e.status;        // exit 2 lands here
      stdout = e.stdout.toString();
    }
    expect(code).toBe(2);
    const out = JSON.parse(stdout);
    expect(validateOut(out)).toBe(true);
    expect(out.reason).toBeTypeOf('string');
  });
});
```

> The core side also performs boundary validation against the corresponding output Schema the moment it receives the plugin's stdout (D1 §6.2). Invalid JSON / schema violations are handled by each port's convention (context: skip, gate: fail on the safe side, etc.). In other words, **if you pass the contract test, the core will not reject you in production**.

---

## 5. How to place plugins (devDependencies vs .halo/ports/)

There are 2 routes to enable a plugin in the target repository. Use them by purpose.

### 5.1 Direct placement (`.halo/ports/<port>.d/`)

Small project-specific plugins (such as a bash gate of a few dozen lines) are placed directly under the target repository's `.halo/ports/`.

```
<target-repository>/
├── .harness.yml                 # kind declaration (required)
└── .halo/
    └── ports/
        ├── task-source.d/
        │   └── 10-github/…      # task-source-github
        ├── context.d/
        │   └── 30-recent-failures/…
        ├── gate.d/
        │   ├── 10-typecheck/…   # thin wrapper around runtime check.sh
        │   ├── 30-test/…
        │   ├── 25-no-console/…  # custom gate built in §1
        │   └── 50-loop-audit/…  # gate-loop-audit (safety invariant)
        ├── sink.d/
        │   ├── 15-create-pr/…   # minAutonomy: L2 (branch draft/normal by AUTONOMY)
        │   └── 20-progress-log/…# minAutonomy: L1
        ├── on-fail.d/…
        ├── runtime.d/
        │   └── node-pnpm/…      # setup.sh / check.sh / test.sh
        ├── trigger.d/
        │   └── polling/…        # install.sh / uninstall.sh / fire
        └── mcp.d/*.json
```

- **Enable = place, disable = remove** (the `conf.d` scheme).
- The execution order is `order` (or, when absent, the numeric prefix of the filename, e.g. `25-no-console`).
- Since it is committed to the repository, the whole team and unattended runs reproduce the same configuration.

### 5.2 Package distribution (`devDependencies`)

Reusable general-purpose plugins (like the 4 samples) are distributed as npm packages and placed in the target repository's `devDependencies`.

```jsonc
// package.json of the target repository
{
  "devDependencies": {
    "@halo/plugin-task-source-github": "^1.0.0",
    "@halo/plugin-runtime-node-pnpm": "^1.0.0"
  }
}
```

The distributed package is referenced from `.halo/ports/` to activate it (wired into `<port>.d/` via a thin wrapper or symlink). Advantages:

- **Version pinning and updating via semver** is possible (consistent with the change management of D1 §7).
- It can be shared across multiple repositories.
- Since unattended execution assumes invoking the absolute path of `.bin`, the path resolved via `devDependencies` can be used as-is from `fire` etc.

### 5.3 Guidance on choosing

| Situation | Recommendation |
|---|---|
| A small inspection or log for this repository only | Direct placement (`.halo/ports/`) |
| A general-purpose adapter reused across multiple repositories | Package distribution (`devDependencies`) |
| A gate involving a safety invariant (loop-audit etc.) | Package distribution + version pinning (for ease of audit) |

---

## 6. Checklist (before release)

Confirm before releasing/PRing a plugin.

- [ ] The 4 required fields of `plugin.json` (`name`/`version`/`port`/`exec`) are present and it conforms to the `plugin.json` schema (mind `additionalProperties: false`).
- [ ] It reads a single JSON from stdin, keeps **stdout JSON-only**, and emits diagnostics to stderr.
- [ ] It honors the exit-code contract (gate/runtime: 0=pass / **2=fail**, others treated as fail / for task-source next, no task is `{"task_id":null}`+exit 0).
- [ ] For a sink, it explicitly declares `minAutonomy` (undeclared errs to L3-equivalent).
- [ ] It has a contract test asserting the output conforms to the distributed JSON Schema (§4).
- [ ] It places runtime/worktree-related artifacts on the ext4 side (under `/home`) (WSL2 constraint, D1 §1.7).
- [ ] If it uses `spec_refs`, they are in kg:// URI form (`kg://<type>/<id>`), not file paths.

---

## Appendix A. Common mistakes

| Symptom | Cause | Remedy |
|---|---|---|
| The core halts on "JSON parse failure" | Mixed debug output into stdout | Emit diagnostics to stderr (D1 §3.2) |
| A gate is passing yet treated as fail | Not returning exit code 0 / exit 1 on an exception | pass must be `exit 0`. fail is `exit 2` |
| A sink does not run at L2 | `minAutonomy` undeclared (erred to L3-equivalent) | Explicitly state the lower bound you want to run at (e.g. `"minAutonomy":"L2"`) |
| Dependency materialization is slow / links do not work | worktree/store is on the `/mnt/c/` side | Move to the ext4 side (under `/home`) |
| The contract test passes but production rejects it | The version of the validated Schema does not match the distributed artifact | Use the bundled Schema of `@halo/contracts` |
| A kg:// reference fails at loop-audit | Wrote a non-existent node ID / path | Point to a node ID that exists in the graph (leave empty in Phases 1–3) |

## Appendix B. References

- **D1 Contract Specification** — the formal definition of I/O types, exit codes, `plugin.json`, kg:// URIs, and JSON Schema validation (authoritative for every description here).
- **D4 Security Design** — the formal definition of loop-audit's 7 checks, protected targets, and the sandbox.
- **D8 Test Strategy** — CI integration of contract tests and Schema drift detection.
- **Requirements Specification v1.8** — §3.2 design principles, §4 port specification, §11 safety invariants.
