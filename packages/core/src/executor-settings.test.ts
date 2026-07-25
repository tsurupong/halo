// executor-settings: the injected deny set is the ex-ante half of ADR-0019, so the
// tests that matter are "does the baseline actually contain the D4 §2.2 categories"
// and "does the drift check notice when it stops containing them" — a settings file
// that silently lost its secret-read denies is exactly the failure SECURITY.md used
// to describe as protection the implementation did not have.
import { describe, expect, test } from 'vitest';
import {
  DENY_SECRET_READS,
  DENY_SELF_MODIFICATION,
  DENY_DANGEROUS_COMMANDS,
  SANDBOX_DENY_READ,
  EXECUTOR_DENY_BASELINE,
  buildExecutorSettings,
  protectedPathDenyRules,
  serializeExecutorSettings,
  executorSettingsPath,
  checkExecutorSettingsDrift,
} from './executor-settings.js';

describe('deny baseline (D4 §2.2)', () => {
  test('covers secret reads, self-modification and destructive commands', () => {
    // The three categories D4 §2.2 fixes. Before this module only self-modification
    // was injected, so these assertions are the regression guard for C2/N1.
    expect(EXECUTOR_DENY_BASELINE).toEqual(
      expect.arrayContaining([
        'Read(**/.env)',
        'Read(~/.ssh/**)',
        'Read(~/.aws/**)',
        'Read(~/.config/gh/**)',
        'Write(**/CLAUDE.md)',
        'Write(**/PROMPT.md)',
        'Write(**/.harness.yml)',
        'Bash(rm -rf*)',
        'Bash(git push --force*)',
        'Bash(sudo*)',
      ]),
    );
  });

  test('denies Edit as well as Write for every protected rule file', () => {
    for (const file of ['CLAUDE.md', 'PROMPT.md', '.harness.yml']) {
      expect(DENY_SELF_MODIFICATION).toContain(`Write(**/${file})`);
      expect(DENY_SELF_MODIFICATION).toContain(`Edit(**/${file})`);
    }
  });

  test('baseline is exactly the three category lists', () => {
    expect(EXECUTOR_DENY_BASELINE).toEqual([
      ...DENY_SECRET_READS,
      ...DENY_SELF_MODIFICATION,
      ...DENY_DANGEROUS_COMMANDS,
    ]);
  });
});

describe('protectedPathDenyRules (ADR-0019 layer-1/layer-2 consistency)', () => {
  test('anchors repo-relative patterns and emits Write + Edit', () => {
    expect(protectedPathDenyRules(['packages/plugins/src/gate-loop-audit/**'])).toEqual([
      'Write(**/packages/plugins/src/gate-loop-audit/**)',
      'Edit(**/packages/plugins/src/gate-loop-audit/**)',
    ]);
  });

  test('leaves already-anchored patterns alone', () => {
    expect(protectedPathDenyRules(['/etc/hosts', '**/*.test.ts'])).toEqual([
      'Write(/etc/hosts)',
      'Edit(/etc/hosts)',
      'Write(**/*.test.ts)',
      'Edit(**/*.test.ts)',
    ]);
  });

  test('ignores blank entries', () => {
    expect(protectedPathDenyRules(['', '   '])).toEqual([]);
  });
});

describe('buildExecutorSettings', () => {
  test('always includes the baseline and the sandbox read block', () => {
    const settings = buildExecutorSettings();
    for (const rule of EXECUTOR_DENY_BASELINE) expect(settings.permissions.deny).toContain(rule);
    expect(settings.sandbox.denyRead).toEqual([...SANDBOX_DENY_READ]);
  });

  test('appends protectedPaths denies so the gate and the deny layer agree', () => {
    const settings = buildExecutorSettings({ protectedPaths: ['plugins/**/plugin.json'] });
    expect(settings.permissions.deny).toContain('Write(**/plugins/**/plugin.json)');
    expect(settings.permissions.deny).toContain('Edit(**/plugins/**/plugin.json)');
  });

  test('deduplicates when a protectedPath restates a baseline rule', () => {
    const settings = buildExecutorSettings({ protectedPaths: ['**/CLAUDE.md'] });
    const occurrences = settings.permissions.deny.filter((d) => d === 'Write(**/CLAUDE.md)');
    expect(occurrences).toHaveLength(1);
  });

  test('serialises as pretty JSON with a trailing newline', () => {
    const text = serializeExecutorSettings(buildExecutorSettings());
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(buildExecutorSettings());
  });
});

describe('executorSettingsPath', () => {
  test('lives under .halo/, i.e. outside the worktree (D4 §2.4 #4)', () => {
    expect(executorSettingsPath('/repo/.halo')).toBe('/repo/.halo/settings/executor-settings.json');
  });
});

describe('checkExecutorSettingsDrift (ADR-0019 §Risks)', () => {
  test('a freshly built file has no drift', () => {
    const text = serializeExecutorSettings(buildExecutorSettings());
    expect(checkExecutorSettingsDrift(text)).toEqual({ status: 'ok' });
  });

  test('repo-declared extras are not drift', () => {
    const text = serializeExecutorSettings(
      buildExecutorSettings({ protectedPaths: ['.github/workflows/**'] }),
    );
    expect(checkExecutorSettingsDrift(text)).toEqual({ status: 'ok' });
  });

  test('reports the exact patterns a stale file lost', () => {
    // The pre-fix implementation: self-modification writes only, no sandbox block.
    const stale = JSON.stringify({ permissions: { deny: [...DENY_SELF_MODIFICATION] } });
    const verdict = checkExecutorSettingsDrift(stale);
    expect(verdict.status).toBe('drift');
    if (verdict.status !== 'drift') return;
    expect(verdict.missingDeny).toContain('Read(**/.env)');
    expect(verdict.missingDeny).toContain('Bash(rm -rf*)');
    expect(verdict.missingDeny).not.toContain('Write(**/CLAUDE.md)');
    expect(verdict.missingSandboxDenyRead).toEqual([...SANDBOX_DENY_READ]);
  });

  test('malformed JSON and non-object roots are unreadable, not silently ok', () => {
    expect(checkExecutorSettingsDrift('{oops').status).toBe('unreadable');
    expect(checkExecutorSettingsDrift('[]').status).toBe('unreadable');
  });

  test('a file whose deny list is missing entirely is drift, not ok', () => {
    const verdict = checkExecutorSettingsDrift('{}');
    expect(verdict.status).toBe('drift');
    if (verdict.status !== 'drift') return;
    expect(verdict.missingDeny).toEqual([...EXECUTOR_DENY_BASELINE]);
  });

  test('every dangerous-command rule is asserted, not just the read rules', () => {
    const withoutBash = JSON.stringify({
      permissions: { deny: [...DENY_SECRET_READS, ...DENY_SELF_MODIFICATION] },
      sandbox: { denyRead: [...SANDBOX_DENY_READ] },
    });
    const verdict = checkExecutorSettingsDrift(withoutBash);
    expect(verdict.status).toBe('drift');
    if (verdict.status !== 'drift') return;
    expect(verdict.missingDeny).toEqual([...DENY_DANGEROUS_COMMANDS]);
  });
});
