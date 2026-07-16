// gate-loop-audit の contract test(plugins/gate-loop-audit/test.contract.sh 相当)。
// ランチャー(audit.sh)経由でspawnし、gate.in JSON -> gate.out JSON / exit code 契約を検証する。
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(__dirname, '..', '..', '..', '..', 'plugins', 'gate-loop-audit');
const launcherPath = join(pluginDir, 'audit.sh');
const distPath = join(__dirname, '..', '..', 'dist', 'gate-loop-audit', 'main.js');

if (!existsSync(distPath)) {
  throw new Error(`dist not found: ${distPath} — run 'pnpm build' first`);
}

function runLauncher(input: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('sh', [launcherPath], { input, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function runAudit(workdir: string): { code: number; stdout: string; stderr: string } {
  const input = JSON.stringify({ task_id: 'T-1', workdir, changed_files: [] });
  return runLauncher(input);
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
}

function newRepo(tmpRoot: string): string {
  const wt = mkdtempSync(join(tmpRoot, 'wt-'));
  git(wt, ['init', '-q']);
  git(wt, ['config', 'user.email', 't@e.x']);
  git(wt, ['config', 'user.name', 't']);
  mkdirSync(join(wt, 'src'), { recursive: true });
  mkdirSync(join(wt, 'tests'), { recursive: true });
  writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(wt, 'src', 'a.test.ts'), "test('a', () => {});\n");
  writeFileSync(join(wt, 'vitest.config.txt'), 'coverage:\n  lines: 90\n');
  writeFileSync(join(wt, 'PROMPT.md'), '# prompt\n');
  git(wt, ['add', '-A']);
  git(wt, ['commit', '-qm', 'init']);
  return wt;
}

describe('gate-loop-audit (launcher contract)', () => {
  const tmpRoots: string[] = [];
  function makeTmpRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'halo-plugin-test-'));
    tmpRoots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('harmless src change -> exit 0, stdout empty', () => {
    const wt = newRepo(makeTmpRoot());
    writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 2;\n');
    const { code, stdout } = runAudit(wt);
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('test file modified -> fail (check 2)', () => {
    const wt = newRepo(makeTmpRoot());
    writeFileSync(join(wt, 'src', 'a.test.ts'), "test('a', () => { expect(1).toBe(1); });\n");
    const { code, stdout } = runAudit(wt);
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('50-loop-audit');
  });

  it('new test file added -> pass (check 2 allows add)', () => {
    const wt = newRepo(makeTmpRoot());
    writeFileSync(join(wt, 'src', 'b.test.ts'), "test('b', () => {});\n");
    git(wt, ['add', join(wt, 'src', 'b.test.ts')]);
    const { code, stdout } = runAudit(wt);
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('@ts-ignore added -> fail (check 3)', () => {
    const wt = newRepo(makeTmpRoot());
    writeFileSync(join(wt, 'src', 'a.ts'), '// @ts-ignore\nexport const a = 3;\n');
    const { code, stdout } = runAudit(wt);
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('50-loop-audit');
  });

  it('coverage threshold 90->80 -> fail (check 4)', () => {
    const wt = newRepo(makeTmpRoot());
    writeFileSync(join(wt, 'vitest.config.txt'), 'coverage:\n  lines: 80\n');
    const { code, stdout } = runAudit(wt);
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('50-loop-audit');
  });

  it('PROMPT.md self-modification -> fail (check 5)', () => {
    const wt = newRepo(makeTmpRoot());
    writeFileSync(join(wt, 'PROMPT.md'), '# prompt tampered\n');
    const { code, stdout } = runAudit(wt);
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('50-loop-audit');
  });

  it('diff > 1500 lines -> fail (check 6)', () => {
    const wt = newRepo(makeTmpRoot());
    const lines = Array.from({ length: 1600 }, (_, i) => String(i + 1)).join('\n');
    writeFileSync(join(wt, 'src', 'big.ts'), `${lines}\n`);
    const { code, stdout } = runAudit(wt);
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('50-loop-audit');
  });

  it('missing workdir -> fail with gate.out shape', () => {
    const input = JSON.stringify({ task_id: 'T-1', workdir: '/no/such/dir', changed_files: [] });
    const { code, stdout } = runLauncher(input);
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('50-loop-audit');
  });
});
