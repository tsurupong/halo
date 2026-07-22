# ADR-0020: Executor Permission Profile (allowedTools + dontAsk)

**Date**: 2026-07-18
**Status**: accepted (implemented 2026-07-22)
**Deciders**: Owner

## Context

The docs never specify a Claude Code permission mode for the executor: D4 §6 and D1 §1.3 fix `--allowedTools` + `--strict-mcp-config`, but the mode itself is undocumented, and the implementation currently defaults to `--permission-mode acceptEdits` (overridable via the `HALO_CLAUDE_PERMISSION_MODE` env). Under `acceptEdits`, tools **not** covered by the allowlist still fall through to mode handling rather than being refused, so the allowlist is pre-approval, not a boundary. The Agent SDK documentation (verified 2026-07-18) recommends `allowedTools` + `permissionMode: "dontAsk"` for locked-down headless agents: listed tools run without prompting, and anything else is **denied outright** instead of prompting — the correct semantics for an unattended loop where nobody can answer a prompt.

## Decision

Fix the executor's default permission profile to `--allowedTools <minimal set>` + `--permission-mode dontAsk`. The minimal set is the revised D4 §6 list (`mcp__codegraph__*,mcp__knowledge__*,Read,Glob,Grep,Edit,Write,Bash,Agent,Skill,TodoWrite`). Revision rationale (2026-07-22): under `dontAsk`, tools outside the allowlist are denied outright, so the original list (`Edit,Write,Bash` + 2 MCPs) would have blocked read/search tools, subagent delegation (`Agent`), and skill invocation (`Skill`) entirely — official Agent SDK docs confirm Agent calls are denied in `dontAsk` mode unless `Agent` is allowlisted. Note that a skill's `allowed-tools` frontmatter has no effect in headless/SDK execution; the query-side `--allowedTools` is the only enforcement point. `HALO_CLAUDE_PERMISSION_MODE` remains as an explicit operator override (e.g., for interactive debugging), but the shipped default changes from `acceptEdits` to `dontAsk`. Deny rules (ADR-0019) keep top priority regardless of mode.

## Alternatives Considered

### Alternative 1: Keep `acceptEdits`
- **Pros**: Current behavior; edits inside the worktree proceed without prompts.
- **Cons**: Unlisted tools are not refused by the allowlist; the effective tool boundary is wider than the documented one.
- **Why not**: The allowlist is meant to be the visible-tool boundary (D4 §6); `dontAsk` is the mode that actually makes it one.

### Alternative 2: `bypassPermissions` inside the bwrap sandbox
- **Pros**: Zero prompt risk; sandbox provides the physical boundary anyway.
- **Cons**: Disables the whole permission layer — the allowlist approves everything including unlisted tools; requires `allowDangerouslySkipPermissions`; degrades non-Linux/no-bwrap environments to no boundary at all (D4 §1.1 already treats bwrap as an *additional* barrier, not the contract).
- **Why not**: HALO's portability premise (ADR-0015) forbids making the only boundary a Linux-specific one.

## Consequences

### Positive
- The allowlist becomes a hard boundary: any tool outside it fails fast instead of prompting (which would hang) or silently proceeding.
- The permission profile is finally documented and testable (doctor can verify the spawn arguments).

### Negative
- Legitimate new tool needs (e.g., a future MCP tool) now require an explicit allowlist change instead of working implicitly — an intentional friction.
- A denied tool mid-task surfaces as executor `stuck`/failed output; the failure re-injection path (D2 §2.4) must carry the denial reason so the next iteration can adapt.

### Risks
- Overly narrow allowlist causes systematic `stuck` results → mitigate by monitoring on-fail reasons and adjusting the D4 §6 initial set from operational measurement (per ADR-0012, mechanism fixed, values tunable).

## Links

- Orthogonal to **ADR-0006** (autonomy levels): autonomy governs which *sinks* may act (output filtering); the permission profile governs which *tools* the executor may call (input boundary). The two axes may later be combined into per-autonomy permission profiles, but this ADR fixes only the default.
- Layered under **ADR-0019** (deny rules evaluate before mode, in every mode).
- Tool list authority: [D4 Security Design §6](../design/d4-security-design.md).
