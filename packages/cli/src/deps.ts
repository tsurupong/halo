// 既定の実 I/O 配線 (D3 §0)。コマンドは全てシーム注入で書かれており、ここが唯一
// 実 fs / spawn / 外部コマンド probe を束ねる場所。テストはこの配線を使わず自前で注入する。
import { spawn as nodeSpawn } from 'node:child_process';
import type { CliFs } from './core-ext/fs.js';
import type { SpawnAdapter, SpawnResult, TriggerContext } from './core-ext/triggers.js';
import type { CommandProbe, DoctorProbes } from './core-ext/doctor.js';
import type { RunHooks } from './commands/run.js';
import { runtimeError } from './exit-codes.js';

/** bash アダプタ script を実行する SpawnAdapter (D1 §1.9)。 */
export function nodeSpawnAdapter(): SpawnAdapter {
  return (script, args, env) =>
    new Promise<SpawnResult>((resolve, reject) => {
      const child = nodeSpawn('bash', [script, ...args], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
}

/** `which <bin>` 相当の存在確認。 */
function binExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = nodeSpawn('command', ['-v', bin], { shell: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function run(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = nodeSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', () => resolve({ code: 1, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function nodeCommandProbe(): CommandProbe {
  return {
    exists: binExists,
    async ghAuth() {
      const r = await run('gh', ['auth', 'status']);
      const authenticated = r.code === 0;
      const overprivileged =
        /repo\b/.test(r.stdout + r.stderr) && !/fine-grained/i.test(r.stdout + r.stderr);
      return { authenticated, overprivileged };
    },
    async claudeResponds() {
      const r = await run('claude', ['--version']);
      return r.code === 0;
    },
    async gitStatus() {
      const repo = await run('git', ['rev-parse', '--is-inside-work-tree']);
      const name = await run('git', ['config', 'user.name']);
      const email = await run('git', ['config', 'user.email']);
      return {
        isRepo: repo.code === 0 && /true/.test(repo.stdout),
        hasUserName: name.code === 0 && name.stdout.trim().length > 0,
        hasUserEmail: email.code === 0 && email.stdout.trim().length > 0,
      };
    },
  };
}

export function nodeDoctorProbes(cwd: string, fs: CliFs, spawn: SpawnAdapter): DoctorProbes {
  const haloDir = `${cwd.replace(/\/$/, '')}/.halo`;
  const triggerCtx: TriggerContext = { haloDir, cwd, fs, spawn };
  return {
    haloDir,
    cwd,
    fs,
    command: nodeCommandProbe(),
    triggerCtx,
    async orphanLock() {
      // TMPDIR/halo.lock の残留を存在で判定 (詳細な staleness は core.lock の管轄)。
      const tmp = process.env.TMPDIR ?? '/tmp';
      return fs.exists(`${tmp.replace(/\/$/, '')}/halo.lock`);
    },
    async onExt4() {
      return !cwd.startsWith('/mnt/c') && !cwd.startsWith('/mnt/d');
    },
    async diskOk() {
      return true; // 実測は重量プリフライトの責務 (D3 §4 注記)。doctor は簡易 OK。
    },
  };
}

/**
 * 既定 RunHooks。preflight/loop の完全配線は M5 (executor/runtime/ports) に依存する。
 * M4 時点では未配線であることを明示的な runtime error で示す (黙って握り潰さない)。
 */
export function defaultRunHooks(): RunHooks {
  const notWired = (phase: string) => (): never => {
    throw runtimeError(`run.${phase} は M5 ランタイム配線 (executor/runtime/ports) が必要です`, {
      hint: 'M5 実装後に既定 hooks を core.preflight / core.runLoop へ結線する',
    });
  };
  return {
    preflightLight: notWired('preflightLight') as RunHooks['preflightLight'],
    preflightHeavy: notWired('preflightHeavy') as RunHooks['preflightHeavy'],
    runLoop: notWired('runLoop') as RunHooks['runLoop'],
  };
}
