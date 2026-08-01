# D1. Contract Specification (HALO Contracts Specification)

| Item | Content |
|---|---|
| Document version | 1.1 (2026-07-25: `exec`→`entry`/`aux` per ADR-0018, `gate.in` `base`/`protected_paths`, `.harness.yml` safety fields, sink autonomy table per ADR-0016, `diagnostics[]`, mcp.d Phase 4 note) |
| Premise | The HALO Requirements Specification v1.8 is the top-level document |
| Positioning | **The formal definition of the public API**. Also serves as the README of `packages/contracts` |
| Public/Private | Public (OSS) |
| Change management policy | **Managed most conservatively of all documents. Strict semver; breaking change = major** (see §7 below) |
| Status | Subject to finalization before implementation begins (progresses in parallel with the contracts type definitions) |

> This document lowers §3.2 (design principles) and §4 (port specification) of the Requirements Specification to an implementable granularity, and does not introduce anything that contradicts the requirements. Numeric parameters (retry limit 3, max-turns 40, timeout 15 minutes, etc.) are treated as "provisional initial values" per requirements §11.2, and are explicitly marked as **initial values** in this document.

---

## 0. Scope and Invariants

The HALO core loop (`packages/core`) and all plugins communicate over a **unified contract of "JSON on stdin, JSON on stdout, decision by exit code" across process boundaries** (requirements §3.2, principle 2). This contract is the public API of the OSS, and the following are treated as the most important invariants.

1. **Process-boundary contract**: The core is implemented in TypeScript (distributed via npm, `npx halo`). The contract lives at the process boundary — stdin JSON / stdout JSON / exit code — so a plugin never depends on the core's internals. **Since [ADR-0018](../adr/0018-entry-contract.md) the bundled discovery/runner path spawns `node <entry>`, so a plugin activated through `ports/<port>.d/` must be a JS module**; the bash examples in this document remain valid as *contract* illustrations but no longer describe a supported spawn path. The boundary itself stays language-agnostic (`runPort` takes an arbitrary `execPath`/`args`), and a manifest field for an explicit interpreter is deferred until a concrete non-Node plugin exists (ADR-0018 §Risks).
2. **Fixed process boundary**: Each plugin is launched as a single process and does not assume any means of communication other than stdin/stdout/exit code (shared memory, global state, mutual dependence on side effects to environment variables, etc.).
3. **Activation by directory convention**: Placing a plugin in `ports/<port-name>.d/` enables it; deleting it disables it. Execution order is controlled by a numeric prefix (the `conf.d` approach; §2 for each port, §6).

> **Changes from v1.5 → v1.8**: The core's implementation language was changed from bash (`core/loop.sh` + `core/helpers.sh`) to TypeScript (distributed via npm). This document does not refer to the core-internal bash implementation (the function set in `helpers.sh`, etc.) and specifies **only the process-boundary contract**. The plugin implementation language remains arbitrary, and the bash examples in this document are valid as plugin implementation examples.

---

## 1. I/O Types for Each of the 9 Ports

The ports are the 9 kinds in requirements §4.1 (plus the auxiliary `mcp.d`). The JSON Schema for each port is placed in `packages/contracts` and is mutually generated with the TS types (§6). The `$id` follows `https://halo.dev/contracts/<port>.<io>.json`.

Every input is passed to the plugin's **stdin** as a single JSON object, and ports that require output return a single JSON object on **stdout**. Decisions are, as a rule, made by **exit code** (§3).

### Port Responsibility Overview

| # | Port | Single/Multiple | stdout output | Decision method |
|---|---|---|---|---|
| ① | task-source | Single (first only) | Yes (op=next only) | Exit code |
| ② | context | Multiple (all run, merged) | Yes (fragments) | Always treated as success |
| ③ | executor | Single (first only) | Yes (status) | status in stdout + exit code |
| ④ | gate | Multiple (all run, logical AND) | Only on fail | Exit code (0=pass / 2=fail) |
| ⑤ | sink | Multiple (all run, independent) | None | Best effort |
| ⑥ | on-fail | Multiple (all run, independent) | None | Best effort |
| ⑦ | runtime | Bundle (setup/check/test) | None | Exit code (0/2) |
| ⑧ | kind | Not a port (`.harness.yml` declaration) | — | — |
| ⑨ | trigger | Bundle (install/uninstall/fire) | None | Exit code |
| Aux | mcp.d | Not a port (configuration fragment) | — | — |

> ⑧ kind is "runtime/prompt switching based on task kind"; it is not an executable plugin but a declaration in `.harness.yml` (§1.8). It is counted as one of the 9 port numbers, but the ones that have an I/O contract are the 8 ports + mcp.d.

---

### 1.1 ① task-source

Responsible for fetching tasks and reporting completion/failure. The input is discriminated by `op` (oneOf).

**Input (stdin)**

| op | Additional fields | Meaning |
|---|---|---|
| `next` | None | Fetch one next ready task, **claiming** (occupying) it before returning (ADR-0025) |
| `complete` | `task_id`, `pr_url` | Record task completion (terminal: releases the claim) |
| `fail` | `task_id`, `reason`, `retry_count` | Record task failure. Does **not** release the claim by itself — below the escalation threshold the claim stays in place until a separate `release` call; at the threshold `fail` escalates (`needs-human`), which is itself a terminal state (ADR-0025) |
| `release` | `task_id`, `reason` | Release a claimed task back to ready **without** recording a failure (ADR-0025). Called by the core at the tail of the failure path, only when the retry threshold has not been reached |

**Claim/release semantics (ADR-0025)**: `op=next` is the single atomic operation that both selects and occupies a task — implementations MUST make the claim atomic (local: `queue/ → doing/` rename on the same filesystem; github: `ready → in-progress` label swap) and MUST NOT return an already-claimed task from a subsequent `next`. This closes the gap the pre-ADR-0025 contract left for parallel workers (`write_set` is already reserved for Phase 5) and makes "which task is in flight" observable as task-source state rather than an accident of queue ordering. `complete` and `fail`-at-threshold are terminal operations on a claimed task (claim released either as delivered or as escalated); `release` is the third, non-terminal way a claim ends — "not delivered, not yet escalated, back to ready." Recovery of a claim orphaned by a launch that died mid-run (a "ghost claim") is the task-source implementation's own responsibility (local: stale `doing/` entries recovered on the next `op=next`, or reported by `halo doctor`; github: stale `in-progress` labels recovered the same way) — the core takes no part in it.

`release` is a MINOR (additive) contract change: a task-source implementation that predates ADR-0025 does not know the op and exits non-zero, and the core swallows that failure as a best-effort migration accommodation, exactly like `complete` / `fail` failures already are.

**Output (stdout, `op=next` only)**

| Field | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string \| null` | ✓ | `null` means no task available (0 ready). In this case the core exits immediately with exit 0 |
| `title` | `string` | | Task title |
| `body` | `string` | | Task body (requirement description. In Phases 1–3 the requirements are written directly) |
| `kind` | `string` | | Derived from the `kind:<name>` label. Defaults to `code` when unspecified (§1.8) |
| `spec_refs` | `string[]` | | References to frozen requirements (**kg:// URI**, §4). loop-audit verifies their existence |
| `write_set` | `string[]` | | For avoiding parallel conflicts in Phase 5 (optional) |

`complete` / `fail` / `release` produce only side effects and require no output (exit 0 = success).

**Example (input op=next / output)**

```json
{"op": "next"}
```
```json
{
  "task_id": "T-012",
  "title": "Add rate limiting on login failures",
  "body": "...",
  "kind": "code",
  "spec_refs": ["kg://document/auth-login", "kg://decision/rate-limit-policy"]
}
```

**Example (no task)**

```json
{"task_id": null}
```

**Behavior of the GitHub Issues adapter** (requirements §4.2①):

- `next`: Before selecting, list `in-progress` Issues and recover any whose `updatedAt` is older than the stale-claim threshold (`HALO_CLAIM_STALE_SEC`, default 3600s) back to `ready` — a ghost claim from a launch that died mid-run (ADR-0025 Decision #4); this recovery step is best-effort and never blocks the normal fetch below. Then fetch the first result of `gh issue list --label ready` and relabel it to `in-progress` (the claim; ADR-0025). **Every `gh` invocation in the primary fetch/lock path is checked**: a non-zero exit is a fault (exit 2 → the core's `TASK_SOURCE_ERROR`), never `{"task_id": null}` — otherwise an expired credential is indistinguishable from an empty queue and an idle night gets recorded as a clean run. If the relabel fails the task is **not** handed out, because an unclaimed task would be re-fetched every iteration.
- `complete`: Auto-closed on merge via `Closes #<number>` in the PR body; the adapter records the delivery reference in a comment and moves the label to `done` (claim released as delivered).
- `fail`: Record the attempt in an Issue comment (`fail #N: <reason>`). Does **not** move the label by itself (ADR-0025) — the claim (`in-progress`) stays in place. On reaching the threshold (**3**, initial value) attach `needs-human` and remove `in-progress`, escalating and stopping re-supply (breaking the infinite loop).
- `release`: Relabel `in-progress → ready` with no comment. Called by the core only when `fail` reported below-threshold — **this is what re-supplies the Issue to the next `next`**; without it the 3-strike escalation is unreachable, since `next` only looks at `ready` and the Issue would sit in `in-progress` forever.

> **Where the attempt count lives**: the core's `retry_count` is per-run, in-memory state, so a trigger that starts a fresh `halo run` each time always reports 1 and never reaches the threshold. The GitHub adapter therefore derives the running total from the Issue itself (counting `fail #N:` comments) and uses `max(derived, retry_count)` — the source of truth is GitHub, consistent with ADR-0009 (zero global state). When the history cannot be read it falls back to `retry_count`, i.e. it under-counts and escalates late rather than labelling `needs-human` early. The local adapter persists the same total under `.halo/tasks/retry/<task_id>.count` and clears it on completion.

**Input JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/task-source.in.json",
  "title": "task-source input",
  "oneOf": [
    { "type": "object", "required": ["op"],
      "properties": { "op": { "const": "next" } }, "additionalProperties": false },
    { "type": "object", "required": ["op", "task_id", "pr_url"],
      "properties": { "op": { "const": "complete" },
        "task_id": { "type": "string" }, "pr_url": { "type": "string", "format": "uri" } },
      "additionalProperties": false },
    { "type": "object", "required": ["op", "task_id", "reason", "retry_count"],
      "properties": { "op": { "const": "fail" },
        "task_id": { "type": "string" }, "reason": { "type": "string" },
        "retry_count": { "type": "integer", "minimum": 0 } },
      "additionalProperties": false },
    { "type": "object", "required": ["op", "task_id", "reason"],
      "properties": { "op": { "const": "release" },
        "task_id": { "type": "string" }, "reason": { "type": "string" } },
      "additionalProperties": false }
  ]
}
```

**Output JSON Schema (op=next)**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/task-source.out.json",
  "title": "task-source output (op=next)",
  "type": "object",
  "required": ["task_id"],
  "properties": {
    "task_id": { "type": ["string", "null"],
      "description": "null means no task (0 ready). Core exits immediately with exit 0" },
    "title": { "type": "string" },
    "body": { "type": "string" },
    "kind": { "type": "string", "default": "code" },
    "spec_refs": { "type": "array", "items": { "type": "string", "format": "uri" },
      "description": "kg:// URI. loop-audit verifies its existence" },
    "write_set": { "type": "array", "items": { "type": "string" } }
  }
}
```

---

### 1.2 ② context

Static context injection before execution. All context plugins are run, and the core concatenates the `fragments` in descending order of priority, truncating at the token limit (requirements §3.2 principle 4, under 100k).

**Input (stdin)**: The `op=next` output of task-source itself (task information).

**Output (stdout)**

| Field | Type | Required | Description |
|---|---|---|---|
| `fragments` | `Fragment[]` | ✓ | Array of context fragments |

`Fragment`:

| Field | Type | Required | Description |
|---|---|---|---|
| `source` | `string` | ✓ | `codegraph` / `knowledge` / `recent-failures`, etc. |
| `content` | `string` | ✓ | Text to inject |
| `priority` | `integer` | ✓ | Higher values take priority. The core concatenates in descending order and truncates at the token limit |

**Example**

```json
{
  "fragments": [
    { "source": "codegraph", "content": "Impact scope: src/order.ts -> src/payment.ts", "priority": 10 },
    { "source": "recent-failures", "content": "Recent: boundary values not considered in 30-test", "priority": 5 }
  ]
}
```

> **Hybrid approach** (requirements §4.2②): The context plugin pre-injects only a light summary (an impact-scope summary), and deeper investigation is fetched by the AI itself using MCP tools during execution.

**Output JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/context.out.json",
  "title": "context output",
  "type": "object",
  "required": ["fragments"],
  "properties": {
    "fragments": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["source", "content", "priority"],
        "properties": {
          "source": { "type": "string" },
          "content": { "type": "string" },
          "priority": { "type": "integer" }
        },
        "additionalProperties": false
      }
    }
  }
}
```

---

### 1.3 ③ executor

Prompt execution. The initial adapter is `claude -p` (headless).

**Input (stdin)**

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | `string` | ✓ | Execution prompt (context already concatenated and prior failures re-injected) |
| `workdir` | `string` | ✓ | Absolute path of the disposable worktree |
| `budget` | `object` | ✓ | Execution budget |
| `budget.max_turns` | `integer` | ✓ | Turn limit (initial value 40) |
| `budget.timeout_sec` | `integer` | ✓ | Timeout in seconds (initial value 900) |
| `budget.max_budget_usd` | `number` | | Optional dollar ceiling for this execution (ADR-0021). Passed through to the runtime's budget stop when supported; executors that cannot enforce it may ignore it (the core's accumulated-cost check remains the backstop). Added in contract MINOR (§7) |

**Output (stdout)**

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | `"done" \| "stuck" \| "timeout"` | ✓ | Anything other than `done` goes to the core's failure path (on-fail is triggered) |
| `summary` | `string` | ✓ | Summary of the execution result |
| `cost` | `object` | | Cost information (equivalent to ccusage). Optional, for observability |

**Example (input / output)**

```json
{
  "prompt": "...",
  "workdir": "/tmp/halo-wt-issue-12",
  "budget": { "max_turns": 40, "timeout_sec": 900 }
}
```
```json
{ "status": "done", "summary": "Added rate limiting middleware, added 3 tests", "cost": { "usd": 0.42 } }
```

**Outline of the execution command** (requirements §4.2③):

```bash
claude -p "$PROMPT" \
  --mcp-config "$HALO_ROOT/.halo/mcp.json" \
  --strict-mcp-config \
  --settings "$HALO_SETTINGS_FILE" \
  --permission-mode dontAsk \
  --allowedTools "mcp__codegraph__*,mcp__knowledge__*,Read,Glob,Grep,Edit,Write,Bash,Agent,Skill,TodoWrite" \
  --max-turns 40
```

- `--settings "$HALO_SETTINGS_FILE"` injects the HALO-managed deny set at spawn (D4 §2.4, ADR-0019); `--permission-mode dontAsk` makes the allowlist a hard boundary — unlisted tools are denied outright instead of prompting (ADR-0020). Both are executor-adapter behavior; the settings-file *content* is governed by D4, outside this contract.
- `--strict-mcp-config` reads only the harness-managed `mcp.json` (fixing the visible tool scope = reproducibility and security).
- `mcp.json` is generated at startup by merging `ports/mcp.d/*.json` (§1.10).
- The worktree lifecycle (add → runtime detection → setup → execution → remove) follows requirements §4.2③. `workdir` is the executor's working scope (an OS-level sandbox is not adopted, ADR-0024).

**Input/Output JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/executor.in.json",
  "title": "executor input",
  "type": "object",
  "required": ["prompt", "workdir", "budget"],
  "properties": {
    "prompt": { "type": "string" },
    "workdir": { "type": "string" },
    "budget": {
      "type": "object",
      "required": ["max_turns", "timeout_sec"],
      "properties": {
        "max_turns": { "type": "integer", "default": 40 },
        "timeout_sec": { "type": "integer", "default": 900 },
        "max_budget_usd": { "type": "number" }
      }
    }
  }
}
```
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/executor.out.json",
  "title": "executor output",
  "type": "object",
  "required": ["status", "summary"],
  "properties": {
    "status": { "enum": ["done", "stuck", "timeout"] },
    "summary": { "type": "string" },
    "cost": { "type": "object" }
  }
}
```

---

### 1.4 ④ gate

Pass/fail judgment of the deliverable. **The decision is by exit code, not by output** (exit 0 = pass / exit 2 = fail, the same convention as Claude Code hooks). The core runs all of gate.d in numeric order; if even one fails, the whole is a fail (logical AND), and the fail reason is re-injected into the next iteration's prompt (§5).

**Input (stdin)**

| Field | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | ✓ | Task ID |
| `workdir` | `string` | ✓ | Absolute path of the worktree under inspection |
| `changed_files` | `string[]` | ✓ | List of changed files |
| `base` | `string` | | The worktree's base commit (the HEAD captured when it was created). Diff-based gates inspect `git diff <base>` so that **committed and uncommitted changes are both audited**; without it they fall back to `git diff HEAD` and an executor that commits its own work escapes inspection (D4 §4.2). Added in contract MINOR (§7) |
| `protected_paths` | `string[]` | | Extra repo-relative glob patterns the audit gate must treat as protected, from `.harness.yml` `protectedPaths` (ADR-0004). **The core reads the declaration at the repository root and passes the list in**, so the set a gate enforces cannot be weakened by editing the copy inside the worktree. A single star matches within one path segment, a double star across segments. Added in contract MINOR (§7) |

**Output (stdout, only on fail)**

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | `string` | ✓ | e.g. `coverage 87% < 90%` |
| `hint` | `string` | | e.g. `insufficient tests for src/order.ts` |
| `gate` | `string` | | Name of the gate that failed (e.g. `30-test`) |

- The `10-typecheck` / `30-test` in gate.d have no real commands; they are thin wrappers that delegate to the adopted runtime's `check` / `test` roles (§1.7). Lint is folded into the runtime's `check`, so there is no separate `20-lint` gate.
- `40-ai-review` (evaluator agent) and `50-loop-audit` (structural checks such as the self-modification ban, requirements §11.1) are gates of the same rank.
- The evaluator is tuned to be "skeptical," but it is made to flag only gaps affecting correctness / requirements to prevent over-flagging (initial value, requirements §11.2).

**Example (input / fail output)**

```json
{ "task_id": "T-012", "workdir": "/tmp/halo-wt-issue-12", "changed_files": ["src/order.ts"] }
```
```json
{ "reason": "coverage 87% < 90%", "hint": "insufficient tests for src/order.ts", "gate": "30-test" }
```

**Input/Output JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/gate.in.json",
  "title": "gate input",
  "type": "object",
  "required": ["task_id", "workdir", "changed_files"],
  "properties": {
    "task_id": { "type": "string" },
    "workdir": { "type": "string" },
    "changed_files": { "type": "array", "items": { "type": "string" } },
    "base": { "type": "string" },
    "protected_paths": { "type": "array", "items": { "type": "string" } }
  }
}
```
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/gate.out.json",
  "title": "gate output (fail only)",
  "type": "object",
  "required": ["reason"],
  "properties": {
    "reason": { "type": "string" },
    "hint": { "type": "string" },
    "gate": { "type": "string" }
  }
}
```

---

### 1.5 ⑤ sink

Side effects after passing (filtered by autonomy level). Run only after passing; even if one sink fails, the other sinks continue (best effort).

**Input (stdin)**

| Field | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | ✓ | Task ID |
| `workdir` | `string` | ✓ | Absolute path of the deliverable worktree |
| `summary` | `string` | ✓ | Execution summary from the executor |

**Output**: None (side effects only).

**Autonomy filter**: Each sink declares its minimum required autonomy level via `minAutonomy` in `plugin.json` (§2). The core skips any sink below the current `AUTONOMY`.

| AUTONOMY | Enabled sinks (bundled set as shipped) |
|---|---|
| L1 | `sink-git-commit` (`minAutonomy: L1`) + `sink-progress-log` (`minAutonomy: L1`) |
| L2 | The L1 set + any `minAutonomy: L2` sink (**none is bundled yet** — see below) |
| L3 | The L2 set + any `minAutonomy: L3` sink, and every sink that declares no `minAutonomy` |

Autonomy levels are cumulative (L3 ⊇ L2 ⊇ L1). A higher level runs all sinks enabled at lower levels.

**Why `sink-git-commit` is L1** (ADR-0016): "report only" is reinterpreted as "no external *publication* (push / PR / deploy)". A commit on the local per-task branch is evidence, not publication, and without it an L1 run passing its gates produced nothing durable — the worktree was removed and the work discarded. This supersedes the v1.8 table that placed `10-git-commit` at L2.

**Current gap**: no sink in the bundled set declares `L2` or `L3`, so raising `AUTONOMY` above L1 currently enables nothing extra. A `create-pr` sink (`minAutonomy: L2`, reading the `AUTONOMY` env to produce **a draft PR at L2 and a normal PR at L3** within a single sink) is **deferred past Phase 1** together with the graph layer — see the phase plan in the Requirements Specification. The mechanism (declaration + core filter, ADR-0006) is in place; only the sink is missing.

Future: `30-reindex-graph` (re-index after merge), `35-reindex-knowledge` (knowledge-graph re-index after a docs merge) — both Phase 4.

**Input JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/sink.in.json",
  "title": "sink input",
  "type": "object",
  "required": ["task_id", "workdir", "summary"],
  "properties": {
    "task_id": { "type": "string" },
    "workdir": { "type": "string" },
    "summary": { "type": "string" }
  }
}
```

---

### 1.6 ⑥ on-fail

Processing on failure. On a gate fail or the executor's stuck/timeout, all are run in numeric order (best effort; an individual failure does not propagate to others).

**Input (stdin)**

| Field | Type | Required | Description |
|---|---|---|---|
| `task_id` | `string` | ✓ | Task ID |
| `reason` | `string` | ✓ | Reason for failure |
| `retry_count` | `integer` | ✓ | Retry count (0 or greater) |
| `gate` | `string` | | Name of the failed gate. When caused by the executor, `stuck`/`timeout` |
| `workdir` | `string` | | Absolute path of the target worktree |

**Output**: None (side effects only).

Initial configuration:

- `10-record-failure`: Appends to `.halo/failure-catalog.md` in incident format (timestamp / task / failed gate / reason / remedy).
- `20-escalate`: When `retry_count` reaches the threshold (initial value 3), attaches the `needs-human` label and clears in-progress.
- `30-suggest-sign`: Generates candidate signs for PROMPT from the failure log and writes them to `.halo/signs-proposed.md` (a human decides on adoption).

The failure catalog is read by context.d (`30-recent-failures`), which injects recent failure patterns into the next iteration (the "fail → record → re-inject" learning path).

**Input JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/on-fail.in.json",
  "title": "on-fail input",
  "type": "object",
  "required": ["task_id", "reason", "retry_count"],
  "properties": {
    "task_id": { "type": "string" },
    "reason": { "type": "string" },
    "retry_count": { "type": "integer", "minimum": 0 },
    "gate": { "type": "string" },
    "workdir": { "type": "string" }
  }
}
```

---

### 1.7 ⑦ runtime

Provides deliverable-kind-specific setup and inspection commands. **What runtime absorbs is not the "language" but the "kind of deliverable"**, treating code (node-pnpm / python-uv / rust) and documents (docs-md) on the same footing. Unlike other ports it is a bundle of three roles, but the contract of each role is identical (stdin JSON + exit code).

The three roles are declared in `plugin.json` (§2, ADR-0018) rather than by fixed filenames:

```jsonc
{
  "port": "runtime",
  "entry": "./setup.js",                              // setup: dependency materialisation
  "aux": { "check": "./check.js", "test": "./test.js" } // static check / dynamic verification
}
```

- Selection is by declaration in `.harness.yml` (there is no auto-detection).
- The `10-typecheck` / `30-test` in gate.d are thin wrappers delegating to the adopted runtime's `check` / `test` roles. There is no separate `20-lint` gate: lint is part of the runtime's `check` (for `node-pnpm`, `tsc --noEmit` followed by `eslint`), so the command lives in exactly one place.
- `setup` must materialize dependencies quickly (node-pnpm hard links / python-uv links / rust shared `CARGO_TARGET_DIR`).

**Common input (setup/check/test)**

| Field | Type | Required | Description |
|---|---|---|---|
| `workdir` | `string` | ✓ | Absolute path of the target worktree |
| `changed_files` | `string[]` | | For narrowing the check/test scope (optional) |

**Decision**: For the `check` / `test` roles, exit 0 = pass / exit 2 = fail.

Initial implementations:

| runtime | setup | check | test |
|---|---|---|---|
| `node-pnpm` | pnpm `--offline` (hard-link sharing) | tsc / eslint | vitest |
| `python-uv` | `uv sync` (link-based) | mypy / ruff | pytest |
| `rust` | Shared `CARGO_TARGET_DIR` | cargo check / clippy | cargo test |
| `docs-md` | Mostly noop | markdownlint + broken-link check + ADR template compliance | Glossary consistency check |

> **Placement constraint (WSL2)**: Because link-based dependency sharing works only within the same filesystem, the worktree, each store, and the cache are placed on the WSL2 ext4 side (under `/home`). Placement under `/mnt/c/` is prohibited.

**Common input JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/runtime.in.json",
  "title": "runtime script input (common to setup/check/test)",
  "type": "object",
  "required": ["workdir"],
  "properties": {
    "workdir": { "type": "string" },
    "changed_files": { "type": "array", "items": { "type": "string" } }
  }
}
```

---

### 1.8 ⑧ kind (`.harness.yml`)

kind is not a port script but a declaration in `.harness.yml`, which is **required** at the root of the target repository. From the Issue's `kind:<name>` label (defaulting to `code` when unspecified), the core looks up the definition and determines the runtime set and prompt template to use. A repository without a `.harness.yml` does not run tasks and is marked `needs-human` (no implicit auto-detection is performed).

```yaml
# .harness.yml (required at the root of the target repository, committed)
kinds:
  code:
    runtimes: [node-pnpm]
    prompt: prompts/code.md
  docs:
    runtimes: [docs-md]
    prompt: prompts/docs.md

# Repository-level safety caps (ADR-0004). Both optional.
maxAutonomy: L2
protectedPaths:
  - packages/plugins/src/gate-loop-audit/**
  - .github/workflows/**
```

**Safety fields** (ADR-0004). They live here rather than in a profile because `.harness.yml` is committed *and* is itself a loop-audit protected file: the cap an unattended run obeys stays reviewable in git and cannot be raised by the agent.

| Field | Type | Required | Description |
|---|---|---|---|
| `maxAutonomy` | `"L1" \| "L2" \| "L3"` | | Repository ceiling on the autonomy level. The effective level is `min(resolved AUTONOMY, maxAutonomy)`, applied **after** the profile and `--autonomy`, so neither can exceed it. Omitted → no repository ceiling |
| `protectedPaths` | `string[]` | | Extra repo-relative glob patterns protected from agent self-modification, on top of the built-in set (`CLAUDE.md`, `PROMPT.md`, `.harness.yml`, `.claude/settings*.json`). Enforced in **both** layers: the core passes the list to gates via `gate.in.protected_paths` (§1.4) and derives `Write`/`Edit` deny rules for the injected executor settings (D4 §2.4). Use this when the harness maintains itself, to keep the gate implementation out of the agent's reach |

A malformed value in either field stops the run with a configuration error (exit 3) rather than being ignored — a mis-spelled cap that silently does nothing is worse than a failed launch.

**`.harness.yml` JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/harness-yml.json",
  "title": ".harness.yml",
  "type": "object",
  "required": ["kinds"],
  "properties": {
    "kinds": {
      "type": "object",
      "minProperties": 1,
      "additionalProperties": {
        "type": "object",
        "required": ["runtimes", "prompt"],
        "properties": {
          "runtimes": { "type": "array", "minItems": 1, "items": { "type": "string" },
            "description": "directory name under runtime.d" },
          "prompt": { "type": "string", "description": "path to the prompt template" }
        }
      }
    },
    "maxAutonomy": { "enum": ["L1", "L2", "L3"],
      "description": "repository ceiling, applied after profile and --autonomy (ADR-0004)" },
    "protectedPaths": { "type": "array", "items": { "type": "string" },
      "description": "extra self-modification-protected globs, enforced by gate and deny (ADR-0004)" }
  }
}
```

---

### 1.9 ⑨ trigger

Startup of the core (the sole entry point that calls the halo CLI). A bundle of 3 scripts; it has no stdin JSON contract (the only argument is the profile name).

```
ports/trigger.d/<name>/
└── plugin.json  # entry = fire, aux = { install, uninstall }   (ADR-0018)
```

The three roles (previously fixed-name `install.sh` / `uninstall.sh` / `fire` files) are declared in the manifest:

```jsonc
{
  "port": "trigger",
  "entry": "./fire.js",
  "aux": { "fire": "./fire.js", "install": "./install.js", "uninstall": "./uninstall.js" }
}
```

- `fire` is the sole entry point that starts the halo CLI (`node_modules/.bin/halo`), and everything below the CLI (preflight, loop, ports) does not know what the trigger is.
- In unattended execution it invokes the absolute path to `.bin` directly rather than going through `npx` (version-pinned and network-independent).
- Initial implementations: `trigger-schedule` (scheduled startup), `trigger-polling` (high-frequency scheduled startup + "exit immediately if 0 ready tasks"). The scheduler backend (`schtasks` / `systemd` / `cron` / `launchd`) is auto-detected inside the adapter and overridable with `HALO_SCHEDULER` (ADR-0015). Future: `webhook` / `manual` (everything below `fire` is swappable without change).

> **Startup profiles** (requirements §4.4) are a set of environment-variable files bundling the loop's execution settings (autonomy, limits, task filter, budget), placed in `.halo/profiles/`. The trigger merely starts `halo run <profile>` by specifying the profile name. The internal format of a profile is under the jurisdiction of D2/D3 and is outside the scope of this document's contract.

---

### 1.10 Aux mcp.d

Not a port but an MCP configuration fragment passed to the executor. `ports/mcp.d/*.json` is merged to generate `.halo/mcp.json` at startup, which is read via `claude -p --mcp-config <mcp.json> --strict-mcp-config`. Each fragment conforms to an MCP server definition object (under the `mcpServers` key).

> **Deferred to Phase 4** (with the graph layer). `project init` creates the empty `ports/mcp.d/` directory, but neither the merge step nor the `--mcp-config` flag is implemented yet: the executor is spawned with `--strict-mcp-config` and no config, i.e. **zero MCP servers**. That is the fail-closed direction, and the servers this port exists to carry (`codegraph` / `knowledge`) are themselves Phase 4. Enabling this port means implementing the merge **and** adding `--mcp-config` to the executor adapter — one without the other changes nothing.

```json
{
  "mcpServers": {
    "codegraph": { "command": "...", "args": ["..."] }
  }
}
```

---

## 2. plugin.json Manifest Specification

Each plugin has a `plugin.json` in its own directory, declaring the metadata the core uses when launching the plugin.

> **Positioning in v1.8**: The v1.5-era design document 01 expressed the autonomy declaration as a meta-comment at the top of the sink file (`# min-autonomy: L3`). In v1.8 this is unified into the **structured field `minAutonomy` in `plugin.json`** (because it can be declared in languages other than bash and is easier to machine-verify). The meta-comment style is treated as an alternative representation for compatibility in the D5 Plugin Development Guide.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✓ | Plugin identifier (`@halo/plugin-*`, etc.) |
| `version` | `string` | ✓ | The plugin's own semver |
| `port` | `string` | ✓ | The port it belongs to (`task-source` / `context` / `executor` / `gate` / `sink` / `on-fail` / `runtime` / `trigger`) |
| `entry` | `string` | ✓ | Relative (or absolute) path to the plugin's main JS entry module. The core spawns it as `process.execPath <entry>` — no shell, no exec bit, no shebang (ADR-0018). Replaces the pre-v0.3.0 `exec` field, which discovery now **rejects** |
| `aux` | `object` | | Named auxiliary JS entries, keyed by role (`fire` / `install` / `uninstall` for trigger, `check` / `test` for runtime). Not spawned by the loop; resolved by whoever owns that role (ADR-0018) |
| `order` | `integer` | | Execution order (equivalent to the numeric prefix; when omitted, follows the numeric prefix of the file name) |
| `minAutonomy` | `"L1" \| "L2" \| "L3"` | | Autonomy filter for sinks, etc. When undeclared, treated as the safest side (= regarded as L3 and skipped at L1/L2) |
| `timeoutSec` | `integer` | | Execution timeout for this plugin (the initial value follows the port default) |
| `env` | `object` | | Environment variables to inject at startup (key = variable name, value = default or reference) |

**Example (sink plugin)**

```json
{
  "name": "@halo/plugin-sink-git-commit",
  "version": "1.0.0",
  "port": "sink",
  "entry": "./main.js",
  "order": 10,
  "minAutonomy": "L1",
  "timeoutSec": 120,
  "env": { "HALO_GIT_NAME": "halo" }
}
```

**Example (trigger bundle, using `aux`)**

```json
{
  "name": "@halo/plugin-trigger-polling",
  "version": "1.0.0",
  "port": "trigger",
  "entry": "./fire.js",
  "aux": { "fire": "./fire.js", "install": "./install.js", "uninstall": "./uninstall.js" }
}
```

> `sink-git-commit` is enabled at `minAutonomy: "L1"` because ADR-0016 reinterprets "report only" as "no external publication": a local branch commit is evidence, not publication. A future `create-pr` sink declares `L2` and reads the `AUTONOMY` env to produce a draft PR at L2 and a normal PR at L3 (branching within a single sink) — see §1.5.

**`plugin.json` JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/plugin.json",
  "title": "plugin manifest",
  "type": "object",
  "required": ["name", "version", "port", "entry"],
  "properties": {
    "name": { "type": "string" },
    "version": { "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$" },
    "port": { "enum": ["task-source", "context", "executor", "gate",
      "sink", "on-fail", "runtime", "trigger"] },
    "entry": { "type": "string" },
    "aux": { "type": "object", "additionalProperties": { "type": "string" } },
    "order": { "type": "integer" },
    "minAutonomy": { "enum": ["L1", "L2", "L3"] },
    "timeoutSec": { "type": "integer", "minimum": 1 },
    "env": { "type": "object", "additionalProperties": { "type": "string" } }
  },
  "additionalProperties": false
}
```

> runtime / trigger are directory bundles: `entry` is the bundle's primary entry (runtime `setup`, trigger `fire`) and the remaining roles live in `aux` (runtime `check` / `test`, trigger `install` / `uninstall`). No numeric prefix is attached; selection is by declaration in `.harness.yml` (runtime) / by the trigger's install (trigger).
>
> **Migration from ≤ v0.2.0**: the `exec` field was removed in v0.3.0 (MAJOR, ADR-0018). A manifest that still declares `exec` is **rejected** by discovery with a `DiscoveryError` naming the field — it is not silently ignored and there is no fallback. Regenerate bundled plugins with `halo enable <name>`.

---

## 3. Execution Convention

All plugins are run under the following unified convention.

### 3.1 Exit Codes

| Exit code | Meaning | Core handling |
|---|---|---|
| `0` | pass / normal | Continue as success |
| `2` | fail | Decision-level failure (gate: sent back; runtime check/test: fail) |
| Other (including `1`) | Error (abnormal termination) | Falls to the safe side and treated as fail. A missing plugin (misconfiguration) stops the core |

- **gate / runtime check/test**: exit 0 = pass, exit 2 = fail (the same convention as Claude Code hooks). Abnormal terminations other than exit 2 are also treated as fail on the safe side.
- **task-source `next`**: `{"task_id": null}` + exit 0, intending "no task," is normal.
- **executor**: The decision is made by `status` in stdout (anything other than `done` is the failure path); abnormal termination of the process itself is treated as an error.
- **sink / on-fail**: Best effort. A non-zero exit of an individual plugin does not impede the execution of other plugins.

### 3.2 stdin / stdout

- **stdin**: A single JSON object is passed to each plugin via stdin.
- **stdout**: Ports that require output (task-source next / context / executor / gate on fail) return a single JSON object on stdout. **stdout is a JSON-only channel**, and debug output and the like must not be mixed in (a cause of parse failures).

### 3.3 Handling of stderr

- **stderr is for diagnostics/logging only** and has no contractual meaning.
- The core captures the plugin's stderr and offloads it to that iteration's structured log (`.halo/logs/iter_N.json`), in the `diagnostics[]` array as `{port, plugin, stderr}` (requirements §6.3, obs schema 06 §6.2). Secrets are redacted and each entry is truncated to its tail before it reaches disk. This matters most for **sink / on-fail**: those ports are best-effort, so without the capture their failures leave no trace anywhere.
- Pass/fail is not judged by the content of stderr (the decision is by exit code / status). A plugin may write human-readable progress and warnings to stderr.

---

## 4. kg:// URI Format (node-ID references in spec_refs)

`spec_refs` are references to document/decision node IDs in the knowledge graph, which are **not file paths**, and are expressed with the `kg://` scheme (requirements §4.2①).

### 4.1 Format

```
kg://<node-type>/<node-id>
```

| Element | Description | Example |
|---|---|---|
| `<node-type>` | The node kind in the knowledge graph (corresponds to the 5 kinds in requirements §11.1) | `document` / `decision` / `term` / `context` / `aggregate` |
| `<node-id>` | A slug unique within the kind (kebab-case recommended) | `auth-login` / `rate-limit-policy` |

**Node kinds** (the 5 knowledge-graph kinds in requirements §11.1):

| node-type | Corresponding node | Purpose |
|---|---|---|
| `context` | Bounded context | Reference to the target domain's boundary |
| `aggregate` | Aggregate | Bridging starting point with implementation components |
| `term` | Domain term | Reference to the vocabulary of the ubiquitous language |
| `document` | Document | Reference to design docs, requirements, acceptance criteria |
| `decision` | Decision | Reference to decision nodes such as ADRs |

**Example**

```
kg://document/auth-login
kg://decision/rate-limit-policy
kg://aggregate/order
```

### 4.2 Verification

- **Existence verification**: loop-audit (gate `50-loop-audit`) queries the graph at the start of the loop and verifies that each kg:// URI in `spec_refs` points to an existing node (requirements §11.1). A reference that does not exist is a fail (structural check ①).
- **Resolution implementation**: Resolving a kg:// URI to a graph node is under the jurisdiction of a private plugin (knowledge MCP) and is specified in the D6 Graph Design document. As a contract, this document specifies **only the format (`kg://<type>/<id>`) and the meaning "points to a graph node."**

> **Deferred** (requirements §9 transitional measures): Before the graph is introduced (Phases 1–3), `spec_refs` is left empty and the requirements are written directly in the Issue body. With the introduction of the knowledge graph in Phase 4, kg:// references and the freeze guarantee (requirements §5.3) are activated. The exhaustiveness of node-types and the addition rules in this section will be aligned with D6 when Phase 4 begins (**deferred**).

---

## 5. STUCK Marker Convention

The stopping convention for when the executor detects a state where it "cannot proceed further" (stuck) (requirements §6.2).

### 5.1 Declaration via executor output

The executor declares its own stuck state via `status` in stdout.

| status | Meaning | Core handling |
|---|---|---|
| `stuck` | Logical impasse (repetition at the same spot, conflicting constraints, etc.) | Falls to the else branch and triggers on-fail |
| `timeout` | `budget.timeout_sec` exceeded | Same as above |

`status != done` falls to the core's failure path (on-fail triggered), and `retry_count` is incremented. When the same Issue fails the threshold number of times (initial value 3), on-fail `20-escalate` attaches `needs-human` and breaks off the re-injection loop (breaking the infinite loop).

### 5.2 STUCK Marker (declaration from within the agent)

As a means for the agent (claude -p) to self-report a stuck state during execution, a convention to **emit a STUCK marker within the deliverable** is provided. The executor adapter detects this and converts it to `status: "stuck"`.

- **Marker format**: Emitted, with a reason, either in the execution log (the final message on stdout) or in a `STUCK` file within the worktree.
- **Recommended form**: A `STUCK:` prefix on the first line + the reason (e.g. `STUCK: cannot resolve the version conflict of a dependency package`).
- On detecting STUCK, the executor adapter stores the reason in `summary` and returns `status: "stuck"`.

> **Initial value/deferred**: The exact detection method of the marker (final-message pattern / file existence) is an implementation detail of the executor adapter and will be finalized by extracting it from the Phase 1 implementation (specified in the D2 Core Detailed Design and the executor adapter implementation). As a contract, this document specifies only that "the executor declares stuck via `status: "stuck"`."

> **Distinction from the kill switch**: The `.halo/STOP` file (requirements §4.4) is a kill switch by which **a human** stops the loop, and is a separate mechanism from the STUCK marker (an impasse self-reported by the agent/executor). STOP is checked by the core at the start of each iteration, which then immediately exits with exit 0.

---

## 6. JSON Schema Auto-Generation and Verification in Non-TS Plugins

### 6.1 Generation mechanism (TS types → JSON Schema single source)

- The **single source of truth for contracts is the TypeScript type definitions in `packages/contracts`**. JSON Schemas are auto-generated from the type definitions, structurally preventing divergence between the two.
- The generated artifacts (`*.json` Schema, Draft 2020-12) are bundled in `packages/contracts` and distributed as part of the public package (`$id` is `https://halo.dev/contracts/<port>.<io>.json`).
- Generation uses TS types → JSON Schema conversion (e.g. something equivalent to `ts-json-schema-generator`). The generation command and divergence detection in CI (whether the generated artifacts match the committed ones) are specified in the D8 Test Strategy document.
- TS plugins and the core import the type definitions directly to uphold the contract at **compile time**.

> **Decision (`additionalProperties: false`)**: The generated Schemas use `additionalProperties: false` (stricter than the hand-written examples) across all 12 contracts. This is a deliberate decision prioritizing early detection of typos and undocumented fields in multilingual plugins. Relaxation will be considered on a per-contract basis only for a boundary that later requires forward compatibility (e.g. `executor.out`).

### 6.2 Verification in non-TS plugins

Because plugins may be in any language, non-TS plugins such as bash / Python are given a path to **self-verify at runtime with JSON Schema**.

| Means | Description |
|---|---|
| Referencing the distributed Schema | The plugin references the `*.json` Schema bundled in `packages/contracts` and can verify stdin/stdout with any JSON Schema validator (e.g. the `ajv` CLI, Python `jsonschema`, `check-jsonschema`, etc.) |
| contract test | A contract test is provided that verifies each sample plugin's I/O against the distributed Schema (running input examples and expected-output examples through the Schema). All sample plugins are covered (specified in the D8 Test Strategy document and the D5 Plugin Development Guide) |
| Boundary verification on the core side | Upon receiving a plugin's stdout, the core verifies it against the relevant output Schema, and invalid JSON / schema violations are handled per that port's convention (context: skip, gate: fail on the safe side, etc.) |

> **Design intent**: The TS side upholds the same contract at compile time, and the non-TS side at runtime (distributed Schema + a general-purpose validator). This makes "the core in TS, plugins in any language" (requirements §2.1, §3.2 principle 2) achievable without sacrificing type safety. The concrete procedures for generation/verification and CI integration are left to D8; this document specifies **the single source (TS types) and the distribution form (bundled JSON Schema)**.

---

## 7. Change Management (semver policy)

The contract defined by this document is HALO's public API and is **managed most conservatively of all design documents** (the public boundary in requirements §8.1 and the positioning of D1 in the design-document list).

| Change kind | semver | Example |
|---|---|---|
| **Breaking change = major** | MAJOR | Adding/removing/renaming a required field, changing a type, changing the exit-code convention, removing a port, incompatible changes to the kg:// format |
| Backward-compatible feature addition = minor | MINOR | Adding an optional field (e.g., `executor.in.budget.max_budget_usd`, ADR-0021), adding a new port or new status value (within a range that does not break existing behavior), adding an optional field to `plugin.json` |
| Backward-compatible fix = patch | PATCH | Fixing descriptions/examples, clarifying Schema wording (without changing meaning) |

- The contract version is the package version of `packages/contracts`; this document's version tracks it. (These drifted apart once — the document sat at 1.0 while the package moved to 0.4.0 — so treat a mismatch as a review finding, not as two independent numbers.)
- Because breaking changes affect all existing plugins (including the 4 samples) and target repositories, a migration guide is provided in D5 on a major update.
- Finalizing the items this document marked as initial value/deferred (numeric parameters, kg:// node-type addition rules, STUCK marker detection details) is treated as **a patch if it does not change meaning, and minor or higher if it changes the contract**.

---

## Appendix A. Contract List (placed in `packages/contracts`)

| File | Port | I/O |
|---|---|---|
| `task-source.in.json` | ① | Input (oneOf: next/complete/fail) |
| `task-source.out.json` | ① | Output (op=next) |
| `context.out.json` | ② | Output (fragments) |
| `executor.in.json` | ③ | Input |
| `executor.out.json` | ③ | Output |
| `gate.in.json` | ④ | Input |
| `gate.out.json` | ④ | Output (fail only) |
| `sink.in.json` | ⑤ | Input |
| `on-fail.in.json` | ⑥ | Input |
| `runtime.in.json` | ⑦ | Input (common to setup/check/test) |
| `harness-yml.json` | ⑧ | `.harness.yml` |
| `plugin.json` (schema) | All | Manifest |

> The input to context is the `op=next` output of task-source itself and has no dedicated Schema. sink / on-fail / runtime / trigger are side-effect-centric and have no output Schema. trigger / mcp.d have no stdin JSON contract (§1.9, §1.10).

## Appendix B. Glossary

| Term | Definition |
|---|---|
| Port | The contact point between the core and the outside. An abstract boundary communicating via stdin/stdout JSON + exit code |
| Plugin (adapter) | A concrete implementation of a port. Placed in `ports/<port>.d/` and activated |
| Disposable worktree | A temporary git worktree for AI work (`$TMPDIR/halo-wt-issue-N/`). Deleted on fail |
| Autonomy (AUTONOMY) | L1 (report only) / L2 (commit + draft PR) / L3 (unattended PR creation). Implemented via the sink filter |
| kg:// URI | The node-ID reference format for the knowledge graph (§4) |
| STUCK | A state declaration by which the executor / agent self-reports an impasse (§5) |
