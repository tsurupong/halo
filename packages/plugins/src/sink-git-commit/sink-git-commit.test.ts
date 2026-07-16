import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(__dirname, '..', '..', '..', '..', 'plugins', 'sink-git-commit');
const launcherPath = join(pluginDir, 'commit.sh');
const distPath = join(__dirname, '..', '..', 'dist', 'sink-git-commit', 'main.js');

function runLauncher(input: string, env: Record<string, string> = {}) {
  const r = spawnSync('sh', [launcherPath], { input, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function git(repo: string, args: string[]) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'halo-plugin-test-'));
  tmpDirs.push(d);
  return d;
}

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(`${distPath} が見つかりません。先に pnpm build を実行してください。`);
  }
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('sink-git-commit', () => {
  it('(a) 変更ありでコミットする(メッセージに complete task を含み stdout は空)', () => {
    const tmp = makeTmpDir();
    const repo = join(tmp, 'wt');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'feature/issue-T-1']);
    git(repo, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '--allow-empty', '-m', 'seed']);
    const base = git(repo, ['rev-parse', 'HEAD']).stdout.trim();

    writeFileSync(join(repo, 'impl.txt'), 'new code');
    const input = JSON.stringify({ task_id: 'T-1', workdir: repo, summary: 'did the thing' });
    const result = runLauncher(input);

    const head = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(head).not.toBe(base);
    expect(git(repo, ['log', '-1', '--format=%s']).stdout).toContain('complete task T-1');
    expect(git(repo, ['status', '--porcelain']).stdout.trim()).toBe('');
  });

  it('(b) 変更なしの2回目実行はコミットされない(HEAD不変)', () => {
    const tmp = makeTmpDir();
    const repo = join(tmp, 'wt');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-q', '-b', 'feature/issue-T-1']);
    git(repo, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '--allow-empty', '-m', 'seed']);

    writeFileSync(join(repo, 'impl.txt'), 'new code');
    const input = JSON.stringify({ task_id: 'T-1', workdir: repo, summary: 'did the thing' });
    runLauncher(input);
    const headAfterFirst = git(repo, ['rev-parse', 'HEAD']).stdout.trim();

    const result = runLauncher(input);
    const headAfterSecond = git(repo, ['rev-parse', 'HEAD']).stdout.trim();

    expect(result.code).toBe(0);
    expect(headAfterSecond).toBe(headAfterFirst);
  });

  it('(c) git 外の workdir は exit 0・stdout 空でスキップ', () => {
    const tmp = makeTmpDir();
    const plain = join(tmp, 'plain');
    mkdirSync(plain, { recursive: true });
    const input = JSON.stringify({ task_id: 'T-2', workdir: plain, summary: 'x' });
    const result = runLauncher(input);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('(d) task_id 欠落は exit 0・stdout 空でスキップ', () => {
    const result = runLauncher(JSON.stringify({ workdir: '/tmp', summary: 'x' }));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });
});
