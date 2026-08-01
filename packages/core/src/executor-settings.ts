// executor-settings — the HALO-managed permission settings injected into every
// `claude -p` spawn (ADR-0019 layer 1). D4 §2.2 fixes the deny standard set; this
// module is its single executable representation, so the injector (CLI run wiring)
// and the drift check (`halo doctor`) are generated from one list and cannot
// silently diverge — the exact failure mode ADR-0019 §Risks names.
//
// The file is materialised *outside* the worktree, under `.halo/` (D4 §2.4 #1/#4):
// a settings file living inside the repository is writable state, not a boundary —
// the executor would be able to edit its own permission source.
//
// Layering (D4 §4.3): deny rules are evaluated before the permission mode and hold
// even under `bypassPermissions`, so this is the ex-ante barrier; `gate-loop-audit`
// remains the ex-post backstop. Patterns are 要件 §11.2 "initial values" — tunable
// from operation — but the *mechanism* is fixed (D4 §11 table).
//
// Everything here is pure; the caller owns the filesystem.

import { join } from 'node:path';

/** The shape written to `executor-settings.json` and read by `claude --settings`. */
export interface ExecutorPermissionSettings {
  permissions: { deny: string[] };
  sandbox: { denyRead: string[] };
}

/**
 * Secret-file reads (D4 §2.2). Blocks the "make it read and steal" conduit of the
 * injection threat model (D4 §6) at the tool call, not after the fact.
 */
export const DENY_SECRET_READS: readonly string[] = [
  'Read(**/.env)',
  'Read(**/.env.*)',
  'Read(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Read(~/.config/gh/**)',
];

/**
 * The ADR-0004 protected set: the harness's own rules. Permanent (D4 §2.2), not a
 * tunable initial value. `Edit` is denied alongside `Write` because either tool
 * reaches the same file, and `.claude/settings*.json` is included because its
 * `allow`/`hooks` can widen the effective permissions of the very run it governs.
 */
export const DENY_SELF_MODIFICATION: readonly string[] = [
  'Write(**/CLAUDE.md)',
  'Edit(**/CLAUDE.md)',
  'Write(**/PROMPT.md)',
  'Edit(**/PROMPT.md)',
  'Write(**/.harness.yml)',
  'Edit(**/.harness.yml)',
  'Write(**/.claude/settings.json)',
  'Edit(**/.claude/settings.json)',
  'Write(**/.claude/settings.local.json)',
  'Edit(**/.claude/settings.local.json)',
];

/**
 * Destructive / privilege-escalating commands (D4 §2.2, mirrors hook items #1/#2/#7),
 * plus the ADR-0026 egress prohibition: the executor processes tasks in the worktree;
 * publishing results (push / PR) is the sink's job, regardless of autonomy level.
 * `git push*` subsumes the old `--force*` / `-f*` patterns. Known layer-1 gap:
 * `git -c ... push` style slips a prefix glob — that residue is layer 2 (gate) territory.
 */
export const DENY_DANGEROUS_COMMANDS: readonly string[] = [
  'Bash(rm -rf*)',
  'Bash(rm -fr*)',
  'Bash(git push*)',
  'Bash(gh *)',
  'Bash(git remote*)',
  'Bash(sudo*)',
];

/**
 * OS-level read block for credential directories (D4 §2.2 `sandbox.denyRead`).
 * Duplicates the `Read(...)` denies on purpose: each covers the other's gaps.
 */
export const SANDBOX_DENY_READ: readonly string[] = ['~/.ssh', '~/.aws', '~/.config/gh'];

/**
 * Every pattern that must be present in the injected file regardless of repository
 * configuration. `halo doctor` asserts this baseline is a subset of what was written
 * (repo-declared extras from `protectedPaths` are legitimate additions, not drift).
 */
export const EXECUTOR_DENY_BASELINE: readonly string[] = [
  ...DENY_SECRET_READS,
  ...DENY_SELF_MODIFICATION,
  ...DENY_DANGEROUS_COMMANDS,
];

/**
 * Translate `.harness.yml` `protectedPaths` into deny rules (ADR-0019: "test-file
 * patterns supplied by `.harness.yml`"). This is what keeps layer 1 and layer 2
 * consistent — the gate receives the same list through `gate.in.protected_paths`.
 *
 * Repo-relative patterns get a leading double-star segment so they match inside the
 * disposable worktree, whose absolute path changes every iteration. Patterns that are
 * already anchored (leading slash, or an existing double-star segment) are left alone.
 * Pure.
 */
export function protectedPathDenyRules(patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern === '') continue;
    const anchored =
      pattern.startsWith('/') || pattern.startsWith('**/') ? pattern : `**/${pattern}`;
    out.push(`Write(${anchored})`, `Edit(${anchored})`);
  }
  return out;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Build the settings document to inject (D4 §2.2 + §2.4). Sources are HALO-managed
 * only: the baseline above plus the repository's committed `protectedPaths` — never
 * anything read from inside the worktree. Pure.
 */
export function buildExecutorSettings(
  options: { protectedPaths?: readonly string[] } = {},
): ExecutorPermissionSettings {
  return {
    permissions: {
      deny: dedupe([
        ...EXECUTOR_DENY_BASELINE,
        ...protectedPathDenyRules(options.protectedPaths ?? []),
      ]),
    },
    sandbox: { denyRead: [...SANDBOX_DENY_READ] },
  };
}

/** Serialise for writing (trailing newline, matching the rest of HALO's file output). Pure. */
export function serializeExecutorSettings(settings: ExecutorPermissionSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Directory + filename of the injected settings, under `.halo/` (outside the worktree). */
export const EXECUTOR_SETTINGS_DIRNAME = 'settings';
export const EXECUTOR_SETTINGS_FILENAME = 'executor-settings.json';

/** Absolute path of the injected settings file for a `.halo` directory. Pure. */
export function executorSettingsPath(haloDir: string): string {
  return join(haloDir, EXECUTOR_SETTINGS_DIRNAME, EXECUTOR_SETTINGS_FILENAME);
}

/** Verdict of comparing a written settings file against the authoritative baseline. */
export type ExecutorSettingsDrift =
  | { status: 'ok' }
  | { status: 'unreadable'; reason: string }
  | { status: 'drift'; missingDeny: string[]; missingSandboxDenyRead: string[] };

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function member(container: unknown, key: string): unknown {
  return typeof container === 'object' && container !== null
    ? (container as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Drift detection for `halo doctor` (ADR-0019 §Risks mitigation): does the file that
 * was actually injected still contain every baseline pattern? Extras are ignored —
 * a repository may legitimately add `protectedPaths` denies. Pure.
 */
export function checkExecutorSettingsDrift(text: string): ExecutorSettingsDrift {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'unreadable', reason: 'invalid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'unreadable', reason: 'root must be an object' };
  }
  const deny = stringArray(member(member(parsed, 'permissions'), 'deny'));
  const denyRead = stringArray(member(member(parsed, 'sandbox'), 'denyRead'));

  const missingDeny = EXECUTOR_DENY_BASELINE.filter((p) => !deny.includes(p));
  const missingSandboxDenyRead = SANDBOX_DENY_READ.filter((p) => !denyRead.includes(p));
  return missingDeny.length === 0 && missingSandboxDenyRead.length === 0
    ? { status: 'ok' }
    : { status: 'drift', missingDeny, missingSandboxDenyRead };
}
