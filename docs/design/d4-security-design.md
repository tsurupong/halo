# D4. Security Design

| Item | Content |
|---|---|
| Document version | 0.1 (outline) |
| Prerequisites | [HALO Requirements Specification](../../../docs/HALO要件定義書.md) v1.8 is the top-level document (this document is the implementation spec of §6.1 / §6.2 / §7 / §11.1) |
| Positioning | Public (the threat model is directly tied to OSS trustworthiness, so it is a public document) |
| Constraint | **The safety invariants (§11.1) require this document to exist before the first unattended execution** (in creation order, an outline is required right after D1) |
| Related documents | [D1 Contract Specification] / [D2 Core Detailed Design] / [03 gate/sink/on-fail](./03-gate-sink-onfail.md) / [ADR-0010 Core TypeScript-ization] / [ADR-0011 Abolishing specs/ and unifying into the graph] |
| Execution environment | WSL2 / Arch Linux assumed. bubblewrap is a **Linux-specific additional barrier** and is positioned outside the (language-independent) contract |

This document reduces the Requirements Specification's non-functional security requirements (§6.1), runaway and cost control (§6.2), and the human gate (§7) to an implementable granularity. Of the numbers, those marked "initial value (tentative)" in §11.2 are treated as **tentative values** in this document as well, maintaining the premise of adjustment after measurement. No constraints not in the Requirements Specification are newly created.

> **Main changes from v1.5 → v1.8 (as handled in this document)**
> - **Core TypeScript-ization (ADR-0010)**: The bash assumptions of the v1.5 line (`run.sh` / `bin/run.sh` / `core/helpers.sh`, etc.) move to `packages/core` (TypeScript) in v1.8. This document describes the sandbox launch, PATH scrubbing, etc. as "initialization steps of the core," independent of a specific shell implementation. The **plugin bodies** of executor / gate / hook, etc. allow a mix of bash/TS (language is free as long as they follow the unified contract).
> - **Abolishing specs/ (ADR-0011)**: The v1.5-line method of "holding a specs/ directory in the worktree and checking spec_refs existence with `test -f`" is abolished. Requirements and specs are centrally managed in the knowledge graph, and immutability is guaranteed by **write control to the graph** (§5). loop-audit's spec_refs check becomes "an existence query of graph nodes," and a hash check of graph files (the 7th check) has been added.

---

## 1. Sandbox Configuration (bubblewrap)

### 1.1 Design Policy

Permit all file operations of the executor (`claude -p` headless) **only inside that task's disposable worktree**. Set **the sandbox boundary = the task's work scope** (§4.2 executor), and by matching the two, "where this task touched" becomes uniquely identifiable for auditing.

- bubblewrap is a **Linux-specific additional barrier** and is placed outside the unified contract (stdin/stdout JSON + exit code, language-independent). In non-Linux environments or environments without bwrap, the contract holds but the physical isolation of this document degrades (operation in that case follows the pending item of §11.2 and is handled in the D7 Operations Runbook).
- Write permission is **only** for that worktree (`$TMPDIR/halo-wt-issue-<N>/`, the naming convention is D2).
- The shared build cache is writable within a range that does not affect correctness (on the premise that corruption is detected by the gate, §4.2 runtime).
- The graph DB is **shared as a read-only snapshot** during loop execution (§5.1). Writes are only the one re-index at preflight, and this is executed outside the sandbox (normal user privileges) (§5).
- The MCP server operates outside the sandbox (normal user privileges) (§6.1, details in §7).

### 1.2 bwrap Mount Policy (minimal mounts)

The minimal mounts to match the write permission range to the worktree. The principle is that what is not mounted is **invisible (blocked by default)**.

| Mount (example) | Target | Mode | Purpose |
|---|---|---|---|
| `--ro-bind /usr /usr` and other system-related | `/usr` `/bin` `/lib`, etc. | read-only | Binaries and libraries needed for execution |
| `--bind <worktree> <worktree>` | That worktree | read-write | **The sole write destination** (the work scope) |
| `--bind <cache> <cache>` | Shared cache | read-write | Speeding up dependency materialization (on the premise that corruption is detected by the gate) |
| `--ro-bind <graphs> <graphs>` | Graph DB | read-only | Context reference only (writes are §5) |
| `--tmpfs /tmp` | Temporary area | volatile | For process work (not persisted) |
| `--unshare-all --share-net` | Namespaces | — | Share only the network for `gh` / API communication |
| `--die-with-parent` | Process | — | Reliably die along with the parent (core) when it terminates |

- `~/.ssh` / `~/.aws` / `~/.config/gh` / other worktrees / `$HOME` outside the project are **explicitly not mounted**. In addition, they are doubly blocked with the `sandbox.denyRead` / deny of §2.
- **PATH scrubbing (WSL2-specific)**: WSL2 by default inherits the Windows-side `PATH` (`/mnt/c/...`), and the mixing-in of Windows executables breaks reproducibility and the sandbox boundary. At loop launch (an initialization step before bwrap launch), the core rebuilds PATH to only `/usr/local/bin:/usr/bin:/bin` + HALO-managed runtime paths and removes all entries including `/mnt/c/`. Dependency materialization (worktree, each store, cache) is fixed to ext4 (under `/home`), and placement under `/mnt/c/` is prohibited (the placement constraint of §4.2 runtime).

---

## 2. The Standard Set of deny Rules for settings.json

### 2.1 Design Intent of Duplication

Per §6.1, dangerous operations are blocked in 2 layers: **the PreToolUse hook (exit 2 = block, the same convention as §4.2 gate)** and **the deny of settings.json**. The hook is dynamic (analyzing the command string) and deny is static (a definite refusal per tool/pattern), and each covers the other's omissions. deny is the first barrier, ahead of the hook.

### 2.2 The deny / sandbox Standard Set (initial values)

```jsonc
// The standard deny set, HALO-managed under .halo/ (excerpt, initial values). Injection flow is §2.4.
{
  "permissions": {
    "deny": [
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.config/gh/**)",
      "Write(**/CLAUDE.md)",
      "Write(**/PROMPT.md)",
      "Write(**/.harness.yml)",
      "Bash(rm -rf*)",
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(sudo*)"
    ]
  },
  "sandbox": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.config/gh"]
  }
}
```

- The Write deny of `CLAUDE.md` / `PROMPT.md` / `.harness.yml` is fixed as a **permanent rule** (corresponding to the self-modification prohibition of §11.1, multi-layered in §4).
- The Write deny of test files depends on the project structure, so the pattern is supplemented on the target repository's `.harness.yml` side (only the permanent part is fixed in this document).
- `sandbox.denyRead` is an OS-level read block that makes secret directories invisible even if the hook is bypassed (corresponding to the "OS-level sandbox.denyRead" of §6.1).

### 2.3 List of Operations Blocked by the PreToolUse hook (initial values)

| # | Operation category | Detection pattern (example) | Determination | Block reason |
|---|---|---|---|---|
| 1 | Recursive deletion | `rm -rf` / `rm -fr` / `rm --recursive --force` | exit 2 | Prevent spillover outside the worktree / destruction of work |
| 2 | Force push | `git push --force` / `-f` / `--force-with-lease` | exit 2 | Prevent history rewriting / destruction of shared branches (PR creation is handled by the sink) |
| 3 | Reading secret files | `cat`/`grep`, etc. against `.env` `.env.*` | exit 2 | Prevent secret-value exposure (duplicated with the `Read(**/.env)` deny) |
| 4 | Credential directories | Reading `~/.ssh` / `~/.aws` / `~/.config/gh` | exit 2 | Prevent theft of PATs/keys (duplicated with `sandbox.denyRead`) |
| 5 | Self-modification | Writing to `CLAUDE.md` / `PROMPT.md` / `.harness.yml` / test files | exit 2 | A safety invariant (§11.1). Defense-in-depth with the gate's loop-audit |
| 6 | History tampering | `git reset --hard` / `git rebase` / `git commit --amend` (unmanaged branches) | exit 2 | Maintain auditability |
| 7 | Privilege escalation | `sudo` / `su` / `chmod 777` / `chown` | exit 2 | Prevent bypassing the sandbox boundary |
| 8 | Outbound secret exfiltration | Sending with `curl`/`wget` that includes a secret file in the body | exit 2 | Prevent information leakage (exfiltration via injection) |
| 9 | Scheduler/persistence | `crontab` / `systemctl` / task scheduler registration | exit 2 | Prevent establishing a launch path other than the trigger (ADR-0008) |

> #5 is duplicated between PreToolUse (in advance, stopping the moment a write is attempted) and the loop-audit gate (after the fact, git diff inspection, §4). Even if PreToolUse is bypassed, loop-audit sends it back.

### 2.4 Injection Flow at Executor Spawn (ADR-0019)

The deny set is not statically placed into the target repository. It is **injected at spawn time** by `executor-claude`, so the executor process can never modify its own permission source:

1. At loop start, the core materializes the settings file (the §2.2 standard set + test-file patterns from the target's `.harness.yml`) from **HALO-managed sources only** (`.halo/`), at a path **outside the worktree**, and exposes it to the executor plugin (env `HALO_SETTINGS_FILE`).
2. `executor-claude` passes it to every invocation: `claude -p ... --settings "$HALO_SETTINGS_FILE"`.
3. Deny rules have top evaluation priority in Claude Code's permission order — they apply **in every permission mode, including `bypassPermissions`** — so this layer holds regardless of the mode profile (§6).
4. `.claude/settings.json` inside the worktree, if present, is target-repository state and is **not** relied upon (it is writable by the executor and therefore not a security boundary).

The authoritative pattern list stays the §4.3 table; the injected deny set and the loop-audit checks are both derived from it, and `halo doctor` verifies the injected file matches (drift detection).

---

## 3. The Minimal-Privilege Definition of the GitHub PAT (fine-grained)

### 3.1 Policy

A classic PAT with full `repo` scope is **prohibited** (§6.1). Limit to a fine-grained PAT capable of **only PR creation and label operations**. The token is injected from an environment variable (`GH_TOKEN`) or a secret manager and is not hard-coded into source. Only the minimum necessary is injected into the worktree.

### 3.2 fine-grained PAT Permission Scope Details

| Repository permission | Access | Required operation | Reason not granted |
|---|---|---|---|
| Contents | **Read-only** | Branch/code retrieval, diff reference | Writes suffice with local git + push (via PR) |
| Pull requests | **Read and write** | `gh pr create` (draft/normal), body `Closes #number` | The required permission of the sink (`15-create-pr`) |
| Issues | **Read and write** | Label reassignment (ready→in-progress), `fail`/`complete` comments, granting `needs-human`, auto-filing a `kind:docs` issue on staleness detection | The required permission of task-source / on-fail / preflight |
| Metadata | **Read-only** (required, auto-granted) | Basic repository info | The minimal prerequisite of a fine-grained PAT |
| Administration | None | — | Changing repository settings is a human gate |
| Workflows / Actions | None | — | Prevent modification of CI settings |
| Secrets / Environments | None | — | Structurally exclude access to secret values |

- **Merge permission is not granted**: PR merge is a human gate (§7-3). Make the PAT unable to merge, guaranteeing the safe-outputs policy (§6) at the token-permission level as well.
- **Limited to target repositories**: Narrow to only the HALO validation targets with "Only select repositories" (minimizing the blast radius on leakage).
- **Expiration**: Set a short term (initial value, tentative: 90 days), and a human re-issues on expiration. If leakage is suspected, revoke and rotate immediately (security rule).

---

## 4. All Paths of Self-Modification Prevention (loop-audit 7 checks)

### 4.1 Positioning and Authority

This is a **safety invariant** of §11.1 and must exist **before** the first unattended execution (required from day 1 of Phase 1). All determinations are made deterministically by **static inspection based on git diff**, without interpreting the AI's intent or the meaning of its output.

> **Authority for the number of check items**: **v1.8's §11.1 is authoritative**, and the correct number is **7 items** (the table in §4 of this document). [03 gate/sink/on-fail](./03-gate-sink-onfail.md) §2 is also already reconciled to 7 items. The differences from the v1.5 line (6 items, specs/ premise) are 2 points: ① the check method for spec_refs existence changed from "`test -f specs/*.md`" to **"an existence query of graph nodes"** (abolishing specs/, ADR-0011), and ② the **7th check "the hash of graph files matches the loop start"** was added (detecting graph modification during execution, §5.3).

### 4.2 The Check Method of the 7 Items

Internally obtain `git -C <workdir> diff --numstat` / `git -C <workdir> diff <base>...HEAD` and inspect the following in order. If even one item is violated, `exit 2`.

| # | Check item | Check method | Example reason on fail |
|---|---|---|---|
| ① | **spec_refs existence** | Query whether the task's `spec_refs` (`kg://` node IDs) **actually exist in the knowledge graph** (read-only). Fail if there is a nonexistent reference. * v1.5's `test -f` is abolished | `spec_refs 'kg://...' does not exist in the graph` |
| ② | **Test files unchanged** | Match the diff's change targets against test-detection patterns (`*.test.*` / `*_test.*` / `test_*.py` / `tests/**`, etc.). Fail if even one is **deleted or changed** (new additions are permitted) | `Test file src/order.test.ts was changed` |
| ③ | **Zero new escape hatches** | Whether there is no new appearance of `eslint-disable` / `as any` / `@ts-ignore` in the diff's **added lines** (`+`). Keeping existing ones is permitted; additions are forced to zero | `A new @ts-ignore was added in src/api.ts` |
| ④ | **Coverage threshold unchanged** | Whether the coverage threshold value in a config file is not **lowered** in the diff | `The coverage threshold was modified from 90 → 80` |
| ⑤ | **Self-modification prohibition** | Fail if the diff's change targets include `CLAUDE.md` / `PROMPT.md` / `.harness.yml` / test files (§11.1) | `Self-modification of PROMPT.md was detected` |
| ⑥ | **1500-line diff limit** | Fail if the total of added + deleted lines exceeds **1500** (the fixed value of §11.1). Forcing task splitting | `diff 1720 lines > 1500. Split the task` |
| ⑦ | **Graph modification detection** | Whether the hash of graph files **matches the loop start**. Detect direct modification during execution as fail (§5.3) | `A graph file was modified during loop execution` |

- ② and ⑤ overlap on test files, but ② protects "modification of tests in general" and ⑤ protects "self-modification (the rule-set of the harness)"—separate invariants. Held independently, they complement each other.
- The 1500 lines of ⑥ is the fixed value of §11.1. The coverage threshold value of ④ (e.g., 90%) is an initial value (tentative) of §11.2, but the invariant itself of "**prohibiting modification in the lowering direction**" is fixed.

### 4.3 List of Protected Targets (all paths of self-modification prevention)

| Protected target | Path ①: settings.json deny | Path ②: PreToolUse hook | Path ③: loop-audit gate | Path ④: permission/physical |
|---|---|---|---|---|
| `CLAUDE.md` | `Write(**/CLAUDE.md)` | #5 write block | ⑤ post-hoc diff inspection | bwrap write boundary (§1) |
| `PROMPT.md` | `Write(**/PROMPT.md)` | #5 | ⑤ | Same as above |
| `.harness.yml` | `Write(**/.harness.yml)` | #5 | ⑤ | Same as above |
| Test files | Supplemented on the `.harness.yml` side | #5 | ②⑤ | Same as above |
| Coverage threshold config | — | — | ④ | — |
| Knowledge graph | — | — | ①⑦ | read-only mount (§1/§5) |

- PreToolUse stops "the moment a write is attempted," and loop-audit stops "the case where a write got through via some path." Defense-in-depth where each covers the other's omission.
- **Relationship to dogfooding**: Changes to the harness itself are permanently capped at autonomy **L2** (human approval required, §11.1). loop-audit ⑤ definitively blocks this at the gate layer, structurally prohibiting the identification of "the entity that rewrites the rules" and "the entity bound by them."

---

## 5. Graph Write Control (guaranteeing immutability)

In v1.8, requirements and specs are centrally managed in the knowledge graph, and it **does not hold a specs/ directory** (ADR-0011). The immutability that "the AI cannot rewrite the goal" is guaranteed not by git-managing files but by **write control to the graph** (§5.3).

| Mechanism | Implementation | Corresponding threat |
|---|---|---|
| **read-only during execution** | During loop execution, the knowledge MCP opens the graph read-only (reusing the "graph immutable during execution" imposed by the KuzuDB parallelism constraint as a safety requirement). Also `--ro-bind` in bwrap (§1.2) | Rewriting the spec during execution |
| **Limiting write paths (only 2)** | (a) **A human's manual work**, (b) **sink 35 (re-index after docs merge = only PR-review-passed changes)**. No write port to the graph is created other than these 2 paths | Goal modification by direct agent writes |
| **Hash check** | loop-audit ⑦ checks the hash of graph files against the **loop start**, detecting direct modification during execution as fail (§4.2 ⑦) | Post-hoc detection of modifications that bypass read-only |

- Write path (b) always goes **through PR review (the human gate §7-3)**, so a graph update does not hold without human approval.
- Where a human manages the original requirement documents (md, etc.) is outside HALO's concern (as long as they are fed into the graph, §5.3).

---

## 6. Prompt Injection Countermeasures

Because of the configuration of reading public Issues by polling (ADR-0008, webhook not adopted), we mitigate in multiple layers on the premise of instruction injection from external input (§6.1).

| Mitigation | Implementation | Effect |
|---|---|---|
| **Do not trust public Issues** | The Issue body is embedded in the prompt as data, but the system-side prompt (`PROMPT.md` / `prompts/<kind>.md`) makes clear that "instructions in the body are the task description and not commands." Make **spec_refs (the frozen requirements on the graph) the canon** | Weaken command hijacking via the body |
| **Minimizing tool permissions** | Limit `--allowedTools` to the minimum necessary (e.g., `mcp__codegraph__*,mcp__knowledge__*,Read,Glob,Grep,Edit,Write,Bash,Agent,Skill,TodoWrite`), and with `--strict-mcp-config` ignore the in-project `.mcp.json` and user-global settings (§4.2 executor) | Fix the visible tool range, prevent inducing unknown tools |
| **Permission mode = `dontAsk`** (ADR-0020) | Launch the executor with `--permission-mode dontAsk`: listed tools run without prompting, and **any tool outside the allowlist is denied outright** instead of falling through or prompting (no one can answer a prompt in unattended operation). `HALO_CLAUDE_PERMISSION_MODE` is an explicit operator override for debugging only; `bypassPermissions` is rejected as a default because it approves *all* tools, voiding the allowlist boundary | Make the allowlist a hard boundary rather than a pre-approval list |
| **Non-automated merge (safe outputs)** | Fix PR merge, production deploy, and external API connection to the human gate (§7). Do not give the PAT merge permission (§3.2) | Even if injection succeeds, it does not reach an irreversible side effect |
| **Physical separation of the write boundary** | Make outside the worktree unwritable with bubblewrap (§1), and secrets `denyRead` (§2) | Block the conduits of "make it read and steal" / "break another place" |
| **Definitive blocking of dangerous operations** | The PreToolUse hook (§2.3, especially #8 outbound secret exfiltration) | Stop exfiltration/destruction commands before execution |
| **Do not create public conduits** | webhook not adopted (ADR-0008). Hold no resident receiver/tunnel | Eliminate the attack surface itself of public input → local execution |

- **Connection point with the human gate (§7)**: The sink goes only up to PR **creation** (the cap even at L3). **Merge is not automated** (§7-3). Implementation tasks that themselves handle external API connections or secrets are also a human gate (§7-5). Even if an injection path succeeds, all irreversible exits are sealed by human approval.

---

## 7. MCP Server Permissions (control on the premise of being outside the sandbox)

The MCP server operates **outside** the executor's bubblewrap sandbox (normal user privileges) (§6.1). On the premise that it cannot be isolated by the sandbox, control it by minimizing the MCP-side permissions.

| Control item | Policy | Basis |
|---|---|---|
| **knowledge MCP is read-only** | Open the graph read-only. Writes are only the 2 paths of §5 (human / sink 35) at preflight; do not provide a write API via MCP | §6.1 / §5.3 |
| **codegraph MCP is a read-only snapshot** | Share a main-based read-only snapshot. Writes (re-index) are only the one at preflight, outside the sandbox and outside MCP | §5.1 |
| **Limiting the tool exposure range** | The initially exposed tools are only read-type: `search_docs` / `trace_spec_to_code` (knowledge), `find_code`, etc. (codegraph). Do not expose tools with side effects | §5.2 / §5.4 |
| **Fixing the configuration with `--strict-mcp-config`** | At executor launch, ignore the in-project `.mcp.json` and user-global settings, and enable only the MCP configuration HALO specifies | §4.2 executor / §6 |
| **Outside the sandbox but holds no write destination** | MCP is only graph read and query. Structurally give it no side effects of filesystem writes or external sends | §6.1 |
| **Determinism of Agentic RAG** | Make each tool's search step deterministic and entrust only orchestration to the AI (embedding the next move in the return value). Do not put non-deterministic side effects in the MCP layer | §5.4 |

- Since MCP runs outside the sandbox, it is controlled not by "isolation" but by "**giving it no permission itself (read-only, zero side effects)**." Even if injection induces an MCP tool, it cannot do more than read.

---

## Chapter Summary

1. Sandbox configuration (bubblewrap = Linux-specific barrier, write range = worktree only, PATH scrubbing / WSL2)
2. The settings.json deny standard set + the 9 PreToolUse hook items + the duplication of `sandbox.denyRead`
3. The minimal-privilege details of the GitHub fine-grained PAT (PR creation + labels only, no merge permission, classic PAT prohibited)
4. All paths of self-modification prevention (loop-audit **7 checks**, the defense-in-depth table of protected targets × 4 paths)
5. Graph write control (the 3 mechanisms of read-only during execution / 2 write paths / hash check)
6. Prompt injection countermeasures (distrusting public Issues, tool minimization, non-automated merge)
7. MCP server permissions (on the premise of being outside the sandbox, controlled by read-only, zero side effects)

## Explicit Statement of Pending Items and Initial Values (per §11)

| Item | Classification | Handling in this document |
|---|---|---|
| The existence of the loop-audit 7 checks, self-modification prohibition, 1500-line diff | **Fixed** (§11.1) | Fixed. Required before the first unattended execution |
| The **concrete patterns/values** of deny / hook / PAT scope / 90-day expiration | **Initial value (tentative)** | Injected as a standard set at executor spawn (§2.4, ADR-0019) but subject to operational adjustment |
| The **injection mechanism** (deny set injected via `--settings` at spawn) and **permission mode `dontAsk`** | **Fixed** (ADR-0019 / ADR-0020) | The mechanism is fixed; only pattern contents and the allowlist membership remain tunable |
| Degraded operation of physical isolation in environments without bwrap | **Pending** | Handled in the D7 Operations Runbook |
| The exposure range of additional MCP tools | **Initial value (tentative)** | Start with read-type only, decide on expansion after track record |
