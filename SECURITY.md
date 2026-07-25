# Security Policy

HALO runs an AI agent unattended: it writes files, runs commands, and — depending on the
configured autonomy level — creates commits and pull requests. Treat it as a tool that
executes untrusted-influenced instructions with your credentials, and read this document
before pointing it at a repository you care about.

The full threat model is [D4 Security Design](./docs/design/d4-security-design.md). This
file is the summary plus the reporting channel.

## Reporting a vulnerability

Report privately through GitHub's advisory workflow:

**<https://github.com/tsurupong/halo/security/advisories/new>**

Please do not open a public issue for a vulnerability. Include the version (`halo --version`
or the npm package version), the configuration that reproduces it (`.harness.yml`, the
profile, the enabled plugins), and what an attacker gains.

This is a small project without a paid security team, so there is no guaranteed response
SLA. Expect a first reply within about a week, and please allow reasonable time for a fix
before public disclosure.

## Supported versions

Only the latest published minor line receives fixes. Older versions are not patched.

## Threat model in brief

The core assumption: **task input is untrusted**. Tasks come from sources such as public
GitHub Issues, so the task body may contain instructions written by an attacker. HALO's
design does not try to make injection impossible — it tries to make a successful injection
unable to reach anything irreversible.

Defences, roughly outermost to innermost:

| Layer | What it does |
|---|---|
| Human gates | PR **merge**, production deploy, and requirement sign-off are never automated (D4 §6/§7). The most autonomous sink still stops at PR *creation*. |
| Autonomy levels | L1–L3 progressively unlock side effects. `.harness.yml` `maxAutonomy` is a committed, reviewable ceiling applied *after* the profile and `--autonomy`, so a run cannot be raised past it from the command line (ADR-0004). |
| Permission allowlist | The executor launches with an explicit `--allowedTools` allowlist and `--permission-mode dontAsk`, so a tool outside the list is denied rather than prompting (nobody can answer a prompt at 3am) — ADR-0020. |
| Injected deny rules | At every executor spawn HALO writes a settings file *outside* the worktree and passes it with `--settings`, so the agent cannot edit its own permission source. It denies: writes to the protected paths (`CLAUDE.md`, `PROMPT.md`, `.harness.yml`, `.claude/settings*.json`, plus everything listed in `.harness.yml` `protectedPaths`), reads of `.env` files and of `~/.ssh` / `~/.aws` / `~/.config/gh`, and destructive commands (`rm -rf`, `git push --force`, `sudo`). Deny is evaluated before the permission mode, so it holds in every mode (ADR-0019, D4 §2.2). `halo doctor` reports drift between the injected file and that list. |
| Audit gate | `gate-loop-audit` inspects the diff after the fact: self-modification of `CLAUDE.md` / `PROMPT.md` / `.harness.yml` / `.claude/settings*.json` (plus anything in `protectedPaths`), test deletion or modification, new escape hatches, and coverage-threshold weakening all fail the iteration (ADR-0004, D4 §4). |
| Disposable worktree | Each task runs in a fresh `git worktree` created from the current HEAD and removed afterwards (ADR-0002), so a failed run leaves nothing behind. This is a blast-radius limit, not a sandbox — see the gaps below. |
| Credential separation | Git-forge tokens (`GH_TOKEN` / `GITHUB_TOKEN` and enterprise variants) are stripped from the executor's environment: the task source and sink need them, the agent does not. |
| Budget stops | Iteration count, wall-clock timeout, daily iteration cap, and a per-run USD ceiling all terminate the loop (ADR-0021). |

**Self-modification is the invariant that matters most.** The entity that rewrites the
rules must not be the entity bound by them. Changes to the harness itself are capped at
autonomy L2 (human approval required) and blocked at the gate layer.

## What HALO does not protect against

Be explicit about the gaps — they are design boundaries, not oversights:

- **A malicious or compromised plugin.** Plugins are separate processes launched by the
  core with the operator's privileges. Enabling a plugin is equivalent to running its code.
  Review third-party plugins before `halo enable`.
- **A compromised model endpoint or CLI.** HALO trusts the `claude` binary and its
  configured endpoint.
- **Anything the operator explicitly allows.** Raising `maxAutonomy` to L3, widening the
  allowlist, or granting a token more scope than [D4 §3](./docs/design/d4-security-design.md)
  specifies moves the boundary outward on purpose.
- **Repository contents as a whole.** The gate protects a declared set of paths. Ordinary
  source files are the agent's job to change — that is the point of the tool.
- **OS-level sandboxing.** The bubblewrap mount policy in [D4 §1](./docs/design/d4-security-design.md)
  is **designed but not implemented** — no released version confines the executor at the
  kernel level. Today's boundaries are the permission allowlist, the injected deny rules,
  and the audit gate. Do not rely on process isolation that is not there yet.

## Operating recommendations

- Run against a repository whose history you can discard, or under a dedicated bot account.
- Use a fine-grained token scoped to a single repository, without merge permission (D4 §3).
- Declare `maxAutonomy` in `.harness.yml` rather than relying on the profile alone — the
  profile lives under the gitignored `.halo/`, so only the committed declaration is
  reviewable by someone reading the repository.
- If the harness maintains itself, list the gate implementation and plugin manifests in
  `protectedPaths` so an unattended run cannot weaken its own audit gate.
- Keep `.halo/STOP` in mind: creating that file stops the loop at the next iteration
  boundary.
