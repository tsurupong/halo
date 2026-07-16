import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', '..', 'dist', 'on-fail-requeue', 'main.js');

function runLauncher(input: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [distPath], { input, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
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

describe('on-fail-requeue', () => {
  it('(a) transient・上限未満は queue へ戻りカウンタ=1', () => {
    const tmp = makeTmpDir();
    const tasksDir = join(tmp, '.halo', 'tasks');
    const requeueDir = join(tmp, '.halo', 'requeue');
    mkdirSync(join(tasksDir, 'failed'), { recursive: true });
    writeFileSync(join(tasksDir, 'failed', 'T-1.md'), '# task');

    const result = runLauncher(
      JSON.stringify({ task_id: 'T-1', reason: 'HTTP 429 rate limit exceeded', retry_count: 1, gate: '30-test' }),
      { HALO_TASKS_DIR: tasksDir, HALO_REQUEUE_DIR: requeueDir, REQUEUE_MAX_ATTEMPTS: '3' },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(join(tasksDir, 'queue', 'T-1.md'))).toBe(true);
    expect(readFileSync(join(requeueDir, 'T-1.count'), 'utf8').trim()).toBe('1');
  });

  it('(b) transient・上限到達は quarantine へ移動しカウンタ削除', () => {
    const tmp = makeTmpDir();
    const tasksDir = join(tmp, '.halo', 'tasks');
    const requeueDir = join(tmp, '.halo', 'requeue');
    mkdirSync(requeueDir, { recursive: true });
    writeFileSync(join(requeueDir, 'T-2.count'), '2');
    mkdirSync(join(tasksDir, 'queue'), { recursive: true });
    writeFileSync(join(tasksDir, 'queue', 'T-2.md'), '# task');

    runLauncher(JSON.stringify({ task_id: 'T-2', reason: 'test timed out', retry_count: 2 }), {
      HALO_TASKS_DIR: tasksDir,
      HALO_REQUEUE_DIR: requeueDir,
      REQUEUE_MAX_ATTEMPTS: '3',
    });

    expect(existsSync(join(tasksDir, 'quarantine', 'T-2.md'))).toBe(true);
    expect(existsSync(join(tasksDir, 'queue', 'T-2.md'))).toBe(false);
    expect(existsSync(join(requeueDir, 'T-2.count'))).toBe(false);
  });

  it('(c) 非 transient は何もしない', () => {
    const tmp = makeTmpDir();
    const tasksDir = join(tmp, '.halo', 'tasks');
    const requeueDir = join(tmp, '.halo', 'requeue');
    mkdirSync(join(tasksDir, 'failed'), { recursive: true });
    writeFileSync(join(tasksDir, 'failed', 'T-3.md'), '# task');

    const result = runLauncher(
      JSON.stringify({ task_id: 'T-3', reason: 'assertion failed: expected 42', retry_count: 1 }),
      { HALO_TASKS_DIR: tasksDir, HALO_REQUEUE_DIR: requeueDir, REQUEUE_MAX_ATTEMPTS: '3' },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(join(tasksDir, 'failed', 'T-3.md'))).toBe(true);
    expect(existsSync(join(tasksDir, 'queue', 'T-3.md'))).toBe(false);
    expect(existsSync(join(requeueDir, 'T-3.count'))).toBe(false);
  });

  it('(d) タスクファイル不在は exit 0・stdout 空', () => {
    const tmp = makeTmpDir();
    const tasksDir = join(tmp, '.halo', 'tasks');
    const requeueDir = join(tmp, '.halo', 'requeue');

    const result = runLauncher(JSON.stringify({ task_id: 'ghost', reason: 'ECONNRESET', retry_count: 0 }), {
      HALO_TASKS_DIR: tasksDir,
      HALO_REQUEUE_DIR: requeueDir,
      REQUEUE_MAX_ATTEMPTS: '3',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('(e) task_id に不正文字を含む場合は何もせず exit 0', () => {
    const tmp = makeTmpDir();
    const tasksDir = join(tmp, '.halo', 'tasks');
    const requeueDir = join(tmp, '.halo', 'requeue');

    const result = runLauncher(JSON.stringify({ task_id: '../evil', reason: '429', retry_count: 0 }), {
      HALO_TASKS_DIR: tasksDir,
      HALO_REQUEUE_DIR: requeueDir,
      REQUEUE_MAX_ATTEMPTS: '3',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(join(tmp, '.halo', 'evil.md'))).toBe(false);
  });
});
