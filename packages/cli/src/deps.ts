// 既定の実 I/O 配線 (D3 §0)。コマンドは全てシーム注入で書かれており、ここが唯一
// 実 fs / spawn / 外部コマンド probe を束ねる場所。テストはこの配線を使わず自前で注入する。
import { spawn as nodeSpawn } from 'node:child_process';
import type { CliFs } from './core-ext/fs.js';
import type { SpawnAdapter, SpawnResult, TriggerContext } from './core-ext/triggers.js';
import type { CommandProbe, DoctorProbes } from './core-ext/doctor.js';
import type { RunHooks } from './commands/run.js';
import { createRunHooks } from './core-ext/run-wiring.js';

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
    commandExists: binExists,
    async isWsl() {
      return isWslProc(fs);
    },
    async schedulerBackend() {
      // HALO_SCHEDULER による明示固定 → WSL(schtasks) → systemd → cron → launchd (D10 §3.2)。
      const fixed = SCHEDULER_BACKENDS.find((b) => b === process.env.HALO_SCHEDULER);
      if (fixed) return fixed;
      if ((await isWslProc(fs)) && (await binExists('schtasks.exe'))) return 'schtasks';
      if (await binExists('systemctl')) return 'systemd';
      if (await binExists('crontab')) return 'cron';
      if (process.platform === 'darwin' && (await binExists('launchctl'))) return 'launchd';
      return 'none';
    },
  };
}

const SCHEDULER_BACKENDS = ['schtasks', 'systemd', 'cron', 'launchd', 'none'] as const;

/** /proc/version に microsoft を含めば WSL (D10 §4)。非 Linux では読めず false。 */
async function isWslProc(fs: CliFs): Promise<boolean> {
  try {
    return /microsoft/i.test(await fs.readFile('/proc/version'));
  } catch {
    return false;
  }
}

/**
 * 既定 RunHooks (M5/M6 配線済み)。core の discovery / preflight / loop / runPort を
 * 対象リポジトリの `.halo/ports/*.d` に対して結線する。実 I/O シームの束ねは
 * run-wiring が担い、ここはその既定 (node) 構成を返すだけ (D3 §0/§6, D2 §2)。
 */
export function defaultRunHooks(): RunHooks {
  return createRunHooks();
}
