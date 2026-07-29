# ADR-0024: Drop the OS-Level Sandbox (bubblewrap) from the Design

**Date**: 2026-07-29
**Status**: accepted
**Deciders**: Owner
**Amends**: [ADR-0002](0002-disposable-worktree.md) (the worktree lifecycle is unchanged; the "make bubblewrap's write scope match the worktree" clause is retired)

## Context

The design corpus describes an OS-level sandbox around the executor: D4 §1 specifies a bubblewrap mount policy (write access limited to the task worktree, secrets not mounted, `--unshare-all --share-net`, `--die-with-parent`), ADR-0002 sizes the worktree as its write boundary, and the v1.5-era documents 02/06 carry the original specification. None of it was ever implemented — `packages/` contains zero references to bwrap, and SECURITY.md has had to carry an explicit non-goal ("designed but not implemented — do not rely on process isolation that is not there") to stop readers from assuming kernel-level confinement exists.

Since that design was written, the enforcement layers that actually shipped cover most of the same threat surface:

1. **Pre-execution deny injection (ADR-0019)**: `executor-claude` passes a HALO-managed settings file via `--settings`; deny rules apply in every permission mode, and the run aborts if the file cannot be written. `sandbox.denyRead` in that set already blocks secret-directory reads at the Claude Code level.
2. **Permission profile (ADR-0020)**: `--allowedTools` minimal allowlist + `--permission-mode dontAsk` makes the allowlist a hard boundary; unlisted tools are denied outright.
3. **Post-hoc audit (ADR-0004 / gate-loop-audit)**: deterministic git-diff inspection catches anything that slipped through, including self-modification and protected paths.

Meanwhile the bubblewrap layer has structural costs:

- **Linux-only.** ADR-0015 targets POSIX portability (Linux / macOS / WSL2 / CI); D4 §1.1 already had to demote bwrap to an "additional barrier outside the contract," meaning the security story could never depend on it anyway.
- **Unimplemented spec drift.** A detailed mount table that no code enforces keeps generating false reader expectations (this was flagged again in the 2026-07-29 knowledge-graph audit: ADR-0002 reads as if the sandbox exists, SECURITY.md says it does not).
- **Residual value is thin.** What bwrap would add over layers 1–3 is protection against the `claude` binary itself ignoring its own permission layer (bug or compromise). SECURITY.md already lists "a compromised model endpoint or CLI" as an explicit non-goal — HALO trusts the binary.

## Decision

1. **Do not implement an OS-level sandbox.** The executor's enforced boundaries are the ADR-0019 deny injection, the ADR-0020 permission profile, and the ADR-0004 audit gate. Worktree isolation (ADR-0002) remains as a *state-contamination* boundary, not a security boundary.
2. **Retire the bubblewrap specification.** D4 §1's mount policy is replaced by a short "not adopted" note pointing here; the PATH-scrubbing initialization step (WSL2 `/mnt/c` removal) is **kept** — it never depended on bwrap and protects reproducibility on its own.
3. **SECURITY.md states the position affirmatively**: OS-level sandboxing is *not adopted* (with this ADR as the reference) rather than "designed but not implemented."
4. **The v1.5-era documents (02/06) are left as-is.** They are already declared superseded by the D-series where they conflict (design README); rewriting history is not required.

## Alternatives Considered

### Alternative 1: Implement the D4 §1 bwrap policy as designed
- **Pros**: Kernel-level write confinement; protects even against a misbehaving `claude` binary.
- **Cons**: Linux-only (contradicts ADR-0015's portability target, so it can never be a required layer); real implementation cost on WSL2 (mount policy across ext4/NTFS boundaries); duplicates layers that now exist and are tested.
- **Why not**: The one threat it uniquely covers (the executor binary itself bypassing its permission layer) is already a declared non-goal. Paying a Linux-only complexity tax for a non-goal is the wrong trade.

### Alternative 2: Keep the spec as "future work" without implementing
- **Pros**: No document changes; the design is ready if ever needed.
- **Cons**: This is the status quo, and it demonstrably misleads — the spec reads as an existing property of the system and has required a standing disclaimer in SECURITY.md. Unowned "future work" in a security document is worse than absence.
- **Why not**: A security design should describe boundaries that exist. If OS-level isolation becomes necessary, it can be re-introduced by a new ADR (this is a two-way door: nothing shipped depends on its absence), likely via whatever sandboxing the Claude Code runtime itself offers by then rather than a hand-rolled bwrap wrapper.

### Alternative 3: Replace bwrap with a portable sandbox (e.g. containers)
- **Pros**: Portability across the POSIX targets.
- **Cons**: A container runtime dependency contradicts the zero-third-party-runtime-dependency policy and adds an operational prerequisite for every operator; the threat it addresses remains the declared non-goal above.
- **Why not**: Same cost/benefit failure as Alternative 1, with a heavier dependency.

## Consequences

### Positive
- The security documents describe only enforced boundaries; the "designed but not implemented" disclaimer disappears.
- No portability split: the security story is identical on Linux, macOS, WSL2, and CI.
- The recurring doc-vs-reality audit finding is closed at the root.

### Negative
- No kernel-level backstop if the `claude` binary's own permission layer fails. This is accepted explicitly: it was already a SECURITY.md non-goal, and layers 1–3 plus the human gate (no merge permission on the PAT) bound the blast radius.

### Risks
- If a future threat model stops trusting the executor binary, OS-level isolation must be re-introduced (new ADR). Nothing in the current architecture forecloses that.
