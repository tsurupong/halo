import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', '..', 'dist', 'sink-git-commit', 'main.js');

function runLauncher(input: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [distPath], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
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
    git(repo, [
      '-c',
      'user.name=seed',
      '-c',
      'user.email=seed@x',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'seed',
    ]);
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
    git(repo, [
      '-c',
      'user.name=seed',
      '-c',
      'user.email=seed@x',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'seed',
    ]);

    writeFileSync(join(repo, 'impl.txt'), 'new code');
    const input = JSON.stringify({ task_id: 'T-1', workdir: repo, summary: 'did the thing' });
    runLauncher(input);
    const headAfterFirst = git(repo, ['rev-parse', 'HEAD']).stdout.trim();

    const result = runLauncher(input);
    const headAfterSecond = git(repo, ['rev-parse', 'HEAD']).stdout.trim();

    expect(result.code).toBe(0);
    expect(headAfterSecond).toBe(headAfterFirst);
  });

  it('(e) node_modules 配下の変更はコミットに巻き込まない (issue #41)', () => {
    const tmp = makeTmpDir();
    const repo = join(tmp, 'wt');
    mkdirSync(join(repo, 'node_modules', '.vite'), { recursive: true });
    git(repo, ['init', '-q', '-b', 'feature/issue-T-1']);
    // 対象リポジトリが node_modules を追跡しているケースを再現する
    writeFileSync(join(repo, 'node_modules', '.vite', 'results.json'), '{}');
    git(repo, ['add', '-A', '-f']);
    git(repo, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'seed']);

    writeFileSync(join(repo, 'impl.txt'), 'new code');
    writeFileSync(join(repo, 'node_modules', '.vite', 'results.json'), '{"dirty":true}');
    const input = JSON.stringify({ task_id: 'T-1', workdir: repo, summary: 'did the thing' });
    const result = runLauncher(input);

    expect(result.code).toBe(0);
    const files = git(repo, ['show', '--name-only', '--format=', 'HEAD']).stdout.trim();
    expect(files).toBe('impl.txt');
    // node_modules の変更は未ステージのまま残る(成果物に混入しない)
    expect(git(repo, ['status', '--porcelain']).stdout).toContain(
      'node_modules/.vite/results.json',
    );
  });

  it('(g) ネストした node_modules (monorepo) も巻き込まない', () => {
    const tmp = makeTmpDir();
    const repo = join(tmp, 'wt');
    mkdirSync(join(repo, 'packages', 'foo', 'node_modules'), { recursive: true });
    git(repo, ['init', '-q', '-b', 'feature/issue-T-1']);
    writeFileSync(join(repo, 'packages', 'foo', 'node_modules', 'cache.json'), '{}');
    git(repo, ['add', '-A', '-f']);
    git(repo, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'seed']);

    writeFileSync(join(repo, 'impl.txt'), 'new code');
    writeFileSync(join(repo, 'packages', 'foo', 'node_modules', 'cache.json'), '{"dirty":true}');
    const input = JSON.stringify({ task_id: 'T-1', workdir: repo, summary: 'x' });
    const result = runLauncher(input);

    expect(result.code).toBe(0);
    const files = git(repo, ['show', '--name-only', '--format=', 'HEAD']).stdout.trim();
    expect(files).toBe('impl.txt');
  });

  it('(h) executor が既にステージした node_modules も巻き込まない', () => {
    const tmp = makeTmpDir();
    const repo = join(tmp, 'wt');
    mkdirSync(join(repo, 'node_modules', '.vite'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'foo', 'node_modules'), { recursive: true });
    git(repo, ['init', '-q', '-b', 'feature/issue-T-1']);
    writeFileSync(join(repo, 'node_modules', '.vite', 'results.json'), '{}');
    writeFileSync(join(repo, 'packages', 'foo', 'node_modules', 'cache.json'), '{}');
    git(repo, ['add', '-A', '-f']);
    git(repo, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'seed']);

    // executor 相当が実装と node_modules をまとめてステージ済みの状態を再現
    writeFileSync(join(repo, 'impl.txt'), 'new code');
    writeFileSync(join(repo, 'node_modules', '.vite', 'results.json'), '{"dirty":true}');
    writeFileSync(join(repo, 'packages', 'foo', 'node_modules', 'cache.json'), '{"dirty":true}');
    git(repo, ['add', '-A', '-f']);

    const input = JSON.stringify({ task_id: 'T-1', workdir: repo, summary: 'x' });
    const result = runLauncher(input);

    expect(result.code).toBe(0);
    const files = git(repo, ['show', '--name-only', '--format=', 'HEAD']).stdout.trim();
    expect(files).toBe('impl.txt');
  });

  it('(f) 変更が node_modules 配下のみならコミットしない', () => {
    const tmp = makeTmpDir();
    const repo = join(tmp, 'wt');
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    git(repo, ['init', '-q', '-b', 'feature/issue-T-1']);
    writeFileSync(join(repo, 'node_modules', 'cache.json'), '{}');
    git(repo, ['add', '-A', '-f']);
    git(repo, ['-c', 'user.name=seed', '-c', 'user.email=seed@x', 'commit', '-q', '-m', 'seed']);
    const base = git(repo, ['rev-parse', 'HEAD']).stdout.trim();

    writeFileSync(join(repo, 'node_modules', 'cache.json'), '{"dirty":true}');
    const input = JSON.stringify({ task_id: 'T-1', workdir: repo, summary: 'x' });
    const result = runLauncher(input);

    expect(result.code).toBe(0);
    expect(git(repo, ['rev-parse', 'HEAD']).stdout.trim()).toBe(base);
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
