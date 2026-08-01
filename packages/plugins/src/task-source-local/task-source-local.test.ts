// task-source-local 契約テスト(旧 run.sh 62 行の挙動を厳密に再現することを検証)。
import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  utimesSync,
} from 'node:fs';
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
  it('next: claims the task by moving it queue -> doing (ADR-0025)', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-claim.md'), '# Claim me\nbody');
    const { code, stdout } = runLauncher(JSON.stringify({ op: 'next' }), baseEnv(tasksDir));
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { task_id: string };
    expect(out.task_id).toBe('task-claim');
    // Claimed: no longer in queue/, now sitting in doing/.
    expect(existsSync(join(queueDir, 'task-claim.md'))).toBe(false);
    expect(existsSync(join(tasksDir, 'doing', 'task-claim.md'))).toBe(true);
  });

  it('next: a claimed (doing/) task is never handed out again', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-a.md'), '# A\nbody');
    writeFileSync(join(queueDir, 'task-b.md'), '# B\nbody');
    const env = baseEnv(tasksDir);
    const first = JSON.parse(runLauncher(JSON.stringify({ op: 'next' }), env).stdout) as {
      task_id: string;
    };
    const second = JSON.parse(runLauncher(JSON.stringify({ op: 'next' }), env).stdout) as {
      task_id: string;
    };
    expect(first.task_id).toBe('task-a');
    expect(second.task_id).toBe('task-b');
    expect(first.task_id).not.toBe(second.task_id);
  });

  it('release: moves doing -> queue, unclaiming the task without recording a failure', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-rel.md'), '# Rel\nbody');
    const env = baseEnv(tasksDir);
    runLauncher(JSON.stringify({ op: 'next' }), env);
    expect(existsSync(join(tasksDir, 'doing', 'task-rel.md'))).toBe(true);
    const { code, stdout } = runLauncher(
      JSON.stringify({ op: 'release', task_id: 'task-rel', reason: 'below threshold' }),
      env,
    );
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(join(tasksDir, 'doing', 'task-rel.md'))).toBe(false);
    expect(existsSync(join(queueDir, 'task-rel.md'))).toBe(true);
    // release does not touch failures.log / retry count — that is op=fail's job.
    expect(existsSync(join(tasksDir, 'failures.log'))).toBe(false);
  });

  it('release: unclaimed (unknown) task_id -> exit 2', () => {
    const { tasksDir } = setupTasksDir();
    const { code, stdout } = runLauncher(
      JSON.stringify({ op: 'release', task_id: 'missing', reason: 'x' }),
      baseEnv(tasksDir),
    );
    expect(code).toBe(2);
    expect(stdout).toBe('');
  });

  it('fail: claimed (doing/) task stays claimed below threshold — release is a separate op', () => {
    // ADR-0025: fail no longer unclaims by itself; the core calls release
    // explicitly below the threshold. Escalation is still fail's job.
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-fail.md'), '# F\nbody');
    const env = baseEnv(tasksDir);
    runLauncher(JSON.stringify({ op: 'next' }), env);
    const { code } = runLauncher(
      JSON.stringify({ op: 'fail', task_id: 'task-fail', reason: 'red', retry_count: 1 }),
      env,
    );
    expect(code).toBe(0);
    expect(existsSync(join(tasksDir, 'doing', 'task-fail.md'))).toBe(true);
    expect(existsSync(join(queueDir, 'task-fail.md'))).toBe(false);
  });

  it('fail: claimed task reaching threshold moves doing -> needs-human', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-esc.md'), '# E\nbody');
    const env = baseEnv(tasksDir);
    runLauncher(JSON.stringify({ op: 'next' }), env);
    const { code } = runLauncher(
      JSON.stringify({ op: 'fail', task_id: 'task-esc', reason: 'still red', retry_count: 3 }),
      env,
    );
    expect(code).toBe(0);
    expect(existsSync(join(tasksDir, 'doing', 'task-esc.md'))).toBe(false);
    expect(existsSync(join(tasksDir, 'needs-human', 'task-esc.md'))).toBe(true);
  });

  it('complete: claimed (doing/) task moves doing -> done', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-c.md'), '# C\nbody');
    const env = baseEnv(tasksDir);
    runLauncher(JSON.stringify({ op: 'next' }), env);
    const { code } = runLauncher(
      JSON.stringify({ op: 'complete', task_id: 'task-c', pr_url: 'commit:abc' }),
      env,
    );
    expect(code).toBe(0);
    expect(existsSync(join(tasksDir, 'doing', 'task-c.md'))).toBe(false);
    expect(existsSync(join(tasksDir, 'done', 'task-c.md'))).toBe(true);
  });

  // ADR-0025 Decision #4 / Risks: claim したまま launch が異常終了したタスクの回収は
  // task-source の責務。stale (経過時間が閾値超) な doing/ エントリは次の next で queue/
  // へ自動回収してから通常の queue 先頭選択に入る。
  it('next: recovers a stale doing/ entry back to queue before selecting (ADR-0025 stale recovery)', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    const doingDir = join(tasksDir, 'doing');
    mkdirSync(doingDir, { recursive: true });
    writeFileSync(join(doingDir, 'task-stale.md'), '# Stale\nbody');
    // Backdate mtime well past the default staleness window.
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000);
    utimesSync(join(doingDir, 'task-stale.md'), old, old);
    const { code, stdout } = runLauncher(
      JSON.stringify({ op: 'next' }),
      baseEnv(tasksDir, { HALO_CLAIM_STALE_SEC: '3600' }),
    );
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { task_id: string };
    // Recovered back to queue, then re-claimed in the same call (queue -> doing).
    expect(out.task_id).toBe('task-stale');
    expect(existsSync(join(tasksDir, 'doing', 'task-stale.md'))).toBe(true);
    expect(existsSync(join(queueDir, 'task-stale.md'))).toBe(false);
  });

  it('next: a fresh (non-stale) doing/ entry is left alone and not re-handed-out', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    const doingDir = join(tasksDir, 'doing');
    mkdirSync(doingDir, { recursive: true });
    writeFileSync(join(doingDir, 'task-fresh.md'), '# Fresh\nbody');
    writeFileSync(join(queueDir, 'task-other.md'), '# Other\nbody');
    const { stdout } = runLauncher(
      JSON.stringify({ op: 'next' }),
      baseEnv(tasksDir, { HALO_CLAIM_STALE_SEC: '3600' }),
    );
    const out = JSON.parse(stdout) as { task_id: string };
    expect(out.task_id).toBe('task-other');
    expect(existsSync(join(doingDir, 'task-fresh.md'))).toBe(true);
  });

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
    const out = JSON.parse(stdout) as {
      task_id: string;
      title: string;
      body: string;
      kind: string;
    };
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

  it('next: first "# " line is empty -> falls back to id even if a later line has a real title', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'empty-first.md'), '# \n# Real Title\nbody');
    const { stdout } = runLauncher(JSON.stringify({ op: 'next' }), baseEnv(tasksDir));
    const out = JSON.parse(stdout) as { task_id: string; title: string };
    expect(out.task_id).toBe('empty-first');
    expect(out.title).toBe('empty-first');
  });

  it('complete: moves doing -> done and writes result file (claimed via next)', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-1.md'), '# T1\nbody');
    const env = baseEnv(tasksDir);
    runLauncher(JSON.stringify({ op: 'next' }), env);
    const { code, stdout } = runLauncher(
      JSON.stringify({
        op: 'complete',
        task_id: 'task-1',
        pr_url: 'https://github.com/o/r/pull/1',
      }),
      env,
    );
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(join(tasksDir, 'doing', 'task-1.md'))).toBe(false);
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

  it('fail: retry_count below threshold -> stays claimed (doing/), logs failure', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-2.md'), '# T2\nbody');
    const env = baseEnv(tasksDir);
    runLauncher(JSON.stringify({ op: 'next' }), env);
    const { code, stdout } = runLauncher(
      JSON.stringify({ op: 'fail', task_id: 'task-2', reason: 'tests red', retry_count: 1 }),
      env,
    );
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(existsSync(join(tasksDir, 'doing', 'task-2.md'))).toBe(true);
    const log = readFileSync(join(tasksDir, 'failures.log'), 'utf8');
    expect(log).toContain('fail #1: tests red');
  });

  it('fail: retry_count >= threshold -> moves to needs-human', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-3.md'), '# T3\nbody');
    const env = baseEnv(tasksDir);
    runLauncher(JSON.stringify({ op: 'next' }), env);
    const { code } = runLauncher(
      JSON.stringify({ op: 'fail', task_id: 'task-3', reason: 'still red', retry_count: 3 }),
      env,
    );
    expect(code).toBe(0);
    expect(existsSync(join(tasksDir, 'doing', 'task-3.md'))).toBe(false);
    expect(existsSync(join(tasksDir, 'needs-human', 'task-3.md'))).toBe(true);
  });

  it('fail: custom HALO_FAIL_THRESHOLD is respected', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-4.md'), '# T4\nbody');
    const env = baseEnv(tasksDir, { HALO_FAIL_THRESHOLD: '1' });
    runLauncher(JSON.stringify({ op: 'next' }), env);
    runLauncher(
      JSON.stringify({ op: 'fail', task_id: 'task-4', reason: 'red', retry_count: 1 }),
      env,
    );
    expect(existsSync(join(tasksDir, 'needs-human', 'task-4.md'))).toBe(true);
  });

  // N4: 通算リトライ回数はファイルで持つ。コアの retry_count は runLoop 内の in-memory
  // 値なので、trigger が run を都度起動する運用では毎回 1 で届き、閾値に到達しない。
  it('fail: persists the running total across processes and escalates on the third one', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-9.md'), '# T\nbody');
    const env = baseEnv(tasksDir);
    runLauncher(JSON.stringify({ op: 'next' }), env);
    // 別プロセスの3回の失敗を再現。毎回 retry_count=1 で届く。
    for (const reason of ['first', 'second', 'third']) {
      runLauncher(JSON.stringify({ op: 'fail', task_id: 'task-9', reason, retry_count: 1 }), env);
    }
    const log = readFileSync(join(tasksDir, 'failures.log'), 'utf8');
    expect(log).toContain('fail #1: first');
    expect(log).toContain('fail #2: second');
    expect(log).toContain('fail #3: third');
    expect(existsSync(join(tasksDir, 'needs-human', 'task-9.md'))).toBe(true);
    expect(existsSync(join(tasksDir, 'doing', 'task-9.md'))).toBe(false);
    expect(existsSync(join(queueDir, 'task-9.md'))).toBe(false);
    // 隔離まで進んだら計数は片付ける。
    expect(existsSync(join(tasksDir, 'retry', 'task-9.count'))).toBe(false);
  });

  it('complete: clears the persisted retry count so a re-submitted id starts at zero', () => {
    const { tasksDir, queueDir } = setupTasksDir();
    writeFileSync(join(queueDir, 'task-10.md'), '# T\nbody');
    const env = baseEnv(tasksDir);
    runLauncher(JSON.stringify({ op: 'next' }), env);
    runLauncher(
      JSON.stringify({ op: 'fail', task_id: 'task-10', reason: 'flaky', retry_count: 1 }),
      env,
    );
    expect(readFileSync(join(tasksDir, 'retry', 'task-10.count'), 'utf8').trim()).toBe('1');
    runLauncher(JSON.stringify({ op: 'complete', task_id: 'task-10', pr_url: 'commit:abc' }), env);
    expect(existsSync(join(tasksDir, 'retry', 'task-10.count'))).toBe(false);
  });

  it('unknown op -> exit 2, stdout empty', () => {
    const { tasksDir } = setupTasksDir();
    const { code, stdout } = runLauncher(JSON.stringify({ op: 'bogus' }), baseEnv(tasksDir));
    expect(code).toBe(2);
    expect(stdout).toBe('');
  });
});
