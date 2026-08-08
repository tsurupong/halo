// 既定の実 I/O 配線 (D3 §0)。コマンドは全てシーム注入で書かれており、ここが唯一
// 実 fs / spawn / 外部コマンド probe を束ねる場所。テストはこの配線を使わず自前で注入する。
import { spawn as nodeSpawn } from 'node:child_process';
import type { CliFs } from '@tsurupong/halo-core';
import type { SpawnAdapter, SpawnResult, TriggerContext } from '@tsurupong/halo-core';
import type { CommandProbe, DoctorProbes } from '@tsurupong/halo-core';
import type { RunHooks, SignalSeam } from './commands/run.js';
import type { SchedulerSeam } from './commands/watchdog.js';
import { schedulerInstall, schedulerUninstall } from '@tsurupong/halo-plugins/lib/scheduler';
import { createRunHooks } from './core-ext/run-wiring.js';

/** entry 契約 (plugin.json の aux.install/aux.uninstall 等, ADR-0017) を実行する SpawnAdapter。
 * `script` には呼び出しコマンド (通常 `process.execPath`)、`args` にはスクリプトの絶対パス以下の
 * argv が core 側 (triggers.ts) で組み立てられて渡る (D1 §1.9)。 */
export function nodeSpawnAdapter(): SpawnAdapter {
  return (script, args, env) =>
    new Promise<SpawnResult>((resolve, reject) => {
      const child = nodeSpawn(script, [...args], {
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
      // WSL の drvfs マウント(/mnt/c, /mnt/d, ...)全般を非 ext4 扱いにする。
      return !/^\/mnt\/[a-z](\/|$)/.test(cwd);
    },
    async diskOk() {
      return true; // 実測は重量プリフライトの責務 (D3 §4 注記)。doctor は簡易 OK。
    },
    commandExists: binExists,
    async isWsl() {
      return isWslProc(fs);
    },
    // c14 (ADR-0023): 時計を注入した時だけ watchdog heartbeat 検査が走る。
    now: () => Date.now(),
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

/**
 * 既定スケジューラシーム (ADR-0023, D9 §2.6)。`halo trigger install` が使うのと同一の
 * バックエンド抽象 (schtasks / systemd / cron / launchd) をそのまま呼ぶ。
 */
export function nodeSchedulerSeam(): SchedulerSeam {
  return {
    install: (trigger, profile, spec, fireArgv) =>
      schedulerInstall(trigger, profile, spec, fireArgv),
    uninstall: (trigger, profile) => schedulerUninstall(trigger, profile),
  };
}

/**
 * 既定シグナルシーム (ADR-0022, D3 §2.1)。`halo run` だけが解放すべき資源
 * (lock / worktree / phase ログ) を持つので、ハンドラを張るのも run だけ。
 * 解除関数を返すのは、リスナーを残したまま次のコマンドへ抜けないため。
 */
export function nodeSignalSeam(): SignalSeam {
  return {
    on(handler) {
      const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
      const wrapped = signals.map((sig) => {
        const fn = (): void => handler(sig);
        process.on(sig, fn);
        return { sig, fn };
      });
      return () => {
        for (const { sig, fn } of wrapped) process.off(sig, fn);
      };
    },
    // process.exit は巻き戻しを行わない — 2 回目のシグナルの契約そのもの (D9 §5.2)。
    exit(code) {
      process.exit(code);
    },
  };
}
