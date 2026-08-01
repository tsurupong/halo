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
        'Bash(git push*)',
        'Bash(gh *)',
        'Bash(git remote*)',
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

// Claude Code の Bash deny は「コマンド文字列に対する前方一致 glob」。その意味論を
// ここで再現し、ADR-0026 の egress deny が実測の迂回経路 (E2E スモーク 2026-07-29 で
// executor が git push + gh pr create を実行) を塞ぐこと、および既知のすり抜け形
// (`git -c ... push`) が層1では残ることを明文化する — 後者は層2 (gate) 側の課題。
function bashDenyMatches(deny: readonly string[], command: string): boolean {
  return deny.some((rule) => {
    const m = /^Bash\((.*)\)$/.exec(rule);
    if (!m) return false;
    const pattern = m[1]!;
    const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}`);
    return re.test(command);
  });
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('egress deny (ADR-0026)', () => {
  test('push は force に限らず全面 deny', () => {
    for (const cmd of [
      'git push',
      'git push origin main',
      'git push --force origin main',
      'git push -f',
      'git push --set-upstream origin feat/x',
    ]) {
      expect(bashDenyMatches(DENY_DANGEROUS_COMMANDS, cmd)).toBe(true);
    }
  });

  test('gh CLI と git remote は全面 deny', () => {
    for (const cmd of [
      'gh pr create --fill',
      'gh auth git-credential fill',
      'gh issue list',
      'git remote add mirror https://example.com/x.git',
      'git remote set-url origin https://example.com/x.git',
    ]) {
      expect(bashDenyMatches(DENY_DANGEROUS_COMMANDS, cmd)).toBe(true);
    }
  });

  test('worktree 内の正当な操作 (add/commit/fetch 等) は deny されない', () => {
    for (const cmd of [
      'git add -A',
      'git commit -m "feat: x"',
      'git status',
      'git fetch origin',
      'git log --oneline',
      'echo ghost', // "gh " ではなく "gh" 前方一致だと誤爆する — スペース込みで検証
      'ghq list',
    ]) {
      expect(bashDenyMatches(DENY_DANGEROUS_COMMANDS, cmd)).toBe(false);
    }
  });

  test('既知のすり抜け形は層1では残る (層2 gate の守備範囲として明文化)', () => {
    // 前方一致 glob の限界: これらが deny を通過することは設計上の既知事項。
    // 塞ぐ場合は gate-loop-audit の事後検査 (push 済みブランチ検出) 側で扱う。
    for (const cmd of ['git -c credential.helper= push origin main', 'command git push']) {
      expect(bashDenyMatches(DENY_DANGEROUS_COMMANDS, cmd)).toBe(false);
    }
  });

  test('冗長な force 専用パターンは git push* に統合済み', () => {
    expect(DENY_DANGEROUS_COMMANDS).not.toContain('Bash(git push --force*)');
    expect(DENY_DANGEROUS_COMMANDS).not.toContain('Bash(git push -f*)');
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
