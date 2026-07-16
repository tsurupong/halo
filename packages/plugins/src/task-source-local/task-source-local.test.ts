// task-source-local 契約テスト(旧 run.sh 62 行の挙動を厳密に再現することを検証)。
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', '..', 'dist', 'task-source-local', 'main.js');

if (!existsSync(distPath)) {
  throw new Error(`dist not found: ${distPath} (run \`pnpm build\` first)`);
}

function runLauncher(input: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [distPath], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'halo-plugin-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

function setupTasksDir(): { tasksDir: string; queueDir: string } {
  const tasksDir = makeTmpDir();
  const queueDir = join(tasksDir, 'queue');
  mkdirSync(queueDir, { recursive: true });
  return { tasksDir, queueDir };
}

function baseEnv(tasksDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HALO_TASKS_DIR: tasksDir, ...extra };
}

describe('task-source-local contract', () => {
  it('next: queue empty -> {task_id:null}, exit 0', () => {
    const { tasksDir } = setupTasksDir();
    const { code, stdout } = runLauncher(JSON.stringify({ op: 'next' }), baseEnv(tasksDir));
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { task_id: null };
    expect(out.task_id).toBeNull();
  });

  it('next: queue has files -> sorted first, title from "# " line, full body, kind:code', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'b-task.md'), '# B Task\nbody b');
    writeFileSync(join(queueDir, 'a-task.md'), '# A Task\nbody a');
    const { code, stdout } = runLauncher(JSON.stringify({ op: 'next' }), baseEnv(tasksDir));
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { task_id: string; title: string; body: string; kind: string };
    expect(out.task_id).toBe('a-task');
    expect(out.title).toBe('A Task');
    expect(out.body).toBe('# A Task\nbody a');
    expect(out.kind).toBe('code');
  });

  it('next: no "# " title line -> title falls back to id', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'no-title.md'), 'just body text');
    const { stdout } = runLauncher(JSON.stringify({ op: 'next' }), baseEnv(tasksDir));
    const out = JSON.parse(stdout) as { task_id: string; title: string };
    expect(out.task_id).toBe('no-title');
    expect(out.title).toBe('no-title');
  });

  it('complete: moves queue -> done and writes result file', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-1.md'), '# T1\nbody');
    const { code, stdout } = runLauncher(
      JSON.stringify({ op: 'complete', task_id: 'task-1', pr_url: 'https://github.com/o/r/pull/1' }),
      baseEnv(tasksDir),
    );
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(join(queueDir, 'task-1.md'))).toBe(false);
    const donePath = join(tasksDir, 'done', 'task-1.md');
    expect(existsSync(donePath)).toBe(true);
    const result = readFileSync(join(tasksDir, 'done', 'task-1.result'), 'utf8');
    expect(result).toContain('completed_at=');
    expect(result).toContain('pr_url=https://github.com/o/r/pull/1');
  });

  it('complete: unknown task_id -> exit 2', () => {
    const { tasksDir } = setupTasksDir();
    const { code, stdout } = runLauncher(
      JSON.stringify({ op: 'complete', task_id: 'missing', pr_url: 'https://x' }),
      baseEnv(tasksDir),
    );
    expect(code).toBe(2);
    expect(stdout).toBe('');
  });

  it('fail: retry_count below threshold -> stays in queue, logs failure', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-2.md'), '# T2\nbody');
    const { code, stdout } = runLauncher(
      JSON.stringify({ op: 'fail', task_id: 'task-2', reason: 'tests red', retry_count: 1 }),
      baseEnv(tasksDir),
    );
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(join(queueDir, 'task-2.md'))).toBe(true);
    const log = readFileSync(join(tasksDir, 'failures.log'), 'utf8');
    expect(log).toContain('fail #1: tests red');
  });

  it('fail: retry_count >= threshold -> moves to needs-human', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-3.md'), '# T3\nbody');
    const { code } = runLauncher(
      JSON.stringify({ op: 'fail', task_id: 'task-3', reason: 'still red', retry_count: 3 }),
      baseEnv(tasksDir),
    );
    expect(code).toBe(0);
    expect(existsSync(join(queueDir, 'task-3.md'))).toBe(false);
    expect(existsSync(join(tasksDir, 'needs-human', 'task-3.md'))).toBe(true);
  });

  it('fail: custom HALO_FAIL_THRESHOLD is respected', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-4.md'), '# T4\nbody');
    runLauncher(
      JSON.stringify({ op: 'fail', task_id: 'task-4', reason: 'red', retry_count: 1 }),
      baseEnv(tasksDir, { HALO_FAIL_THRESHOLD: '1' }),
    );
    expect(existsSync(join(tasksDir, 'needs-human', 'task-4.md'))).toBe(true);
  });

  it('unknown op -> exit 2, stdout empty', () => {
    const { tasksDir } = setupTasksDir();
    const { code, stdout } = runLauncher(JSON.stringify({ op: 'bogus' }), baseEnv(tasksDir));
    expect(code).toBe(2);
    expect(stdout).toBe('');
  });
});
