// trigger-schedule の contract/fire/backends test(旧 test.contract.sh / test.fire.sh /
// test.backends.sh 相当)。ランチャー(plugins/trigger-schedule/{fire,install.sh,uninstall.sh})は
// `exec node .../dist/trigger-schedule/*.js "$@"` を呼ぶ薄い POSIX sh。
// install.sh/uninstall.sh の検証は env を完全隔離した spawnSync で行い、実 crontab/schtasks には触れない。
import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(__dirname, '..', '..', '..', '..', 'plugins', 'trigger-schedule');
const distDir = join(__dirname, '..', '..', 'dist', 'trigger-schedule');
const installJsPath = join(distDir, 'install.js');
const uninstallPath = join(distDir, 'uninstall.js');
// plugin.json aux.fire は "../../packages/plugins/dist/trigger-schedule/fire.js" なので、
// pluginRoot(plugins/trigger-schedule の絶対パス)から解決すると distDir/fire.js の絶対パスになる。
const resolvedFireJs = join(distDir, 'fire.js');
const firePath = resolvedFireJs;

for (const f of ['fire.js', 'install.js', 'uninstall.js']) {
  const p = join(distDir, f);
  if (!existsSync(p)) {
    throw new Error(`dist not found: ${p} — run 'pnpm build' first`);
  }
}

const nodePath = (() => {
  const r = spawnSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' });
  const found = r.stdout.trim();
  if (found === '') throw new Error('node not found on PATH — cannot build isolated corebin');
  return found;
})();

const tmpRoots: string[] = [];

function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'halo-plugin-test-'));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** COREBIN: 実スケジューラを検出させないための最小 PATH(bash/grep/cat/mkdir/rm/dirname/node)。 */
function buildCoreBin(root: string): string {
  const coreBin = join(root, 'corebin');
  mkdirSync(coreBin, { recursive: true });
  for (const cmd of ['bash', 'grep', 'cat', 'mkdir', 'rm', 'dirname']) {
    const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
    const found = r.stdout.trim();
    if (found === '') throw new Error(`corebin: command not found: ${cmd}`);
    spawnSync('ln', ['-s', found, join(coreBin, cmd)]);
  }
  spawnSync('ln', ['-s', nodePath, join(coreBin, 'node')]);
  return coreBin;
}

/** 完全隔離環境でスクリプトを実行する(env -i 相当)。 */
function runIsolated(
  script: string,
  args: string[],
  opts: { stubDir: string; coreBin: string; home: string; procFile?: string; extraEnv?: Record<string, string> },
): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    PATH: `${opts.stubDir}:${opts.coreBin}`,
    HOME: opts.home,
  };
  if (opts.procFile !== undefined) env['HALO_PROC_VERSION'] = opts.procFile;
  Object.assign(env, opts.extraEnv ?? {});
  const r = spawnSync(script, args, { env, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** install.js を HALO_PLUGIN_DIR=pluginRoot 付きで隔離環境実行する(install.sh 経由をやめた分の薄いラッパー)。 */
function runInstallIsolated(
  args: string[],
  opts: { stubDir: string; coreBin: string; home: string; procFile?: string; extraEnv?: Record<string, string> },
): { code: number; stdout: string; stderr: string } {
  return runIsolated(process.execPath, [installJsPath, ...args], {
    ...opts,
    extraEnv: { ...opts.extraEnv, HALO_PLUGIN_DIR: pluginRoot },
  });
}

describe('trigger-schedule: fire (contract)', () => {
  it('fire invokes .bin/halo run nightly --cwd $HALO_HOME', () => {
    const root = mkTmp();
    const haloHome = join(root, 'halo');
    mkdirSync(join(haloHome, 'node_modules', '.bin'), { recursive: true });
    const argsFile = join(root, 'halo.args');
    writeFileSync(
      join(haloHome, 'node_modules', '.bin', 'halo'),
      `#!/usr/bin/env bash\necho "$*" > "${argsFile}"\nexit 0\n`,
    );
    chmodSync(join(haloHome, 'node_modules', '.bin', 'halo'), 0o755);

    const r = spawnSync(process.execPath, [firePath, 'nightly'], {
      env: { ...process.env, HALO_HOME: haloHome },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(readFileSync(argsFile, 'utf8').trim()).toBe(`run nightly --cwd ${haloHome}`);
  });

  it('fire without profile -> nonzero', () => {
    const root = mkTmp();
    const r = spawnSync(process.execPath, [firePath], { env: { ...process.env, HALO_HOME: root }, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
  });

  it('fire without halo bin -> nonzero', () => {
    const root = mkTmp();
    const r = spawnSync(process.execPath, [firePath, 'nightly'], {
      env: { ...process.env, HALO_HOME: join(root, 'missing') },
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
  });

  it('sanitized PATH contains $HOME/.local/bin, and HALO_PATH_EXTRA is appended to PATH tail', () => {
    const root = mkTmp();
    const haloHome = join(root, 'halo');
    mkdirSync(join(haloHome, 'node_modules', '.bin'), { recursive: true });
    const pathFile = join(root, 'halo.path');
    writeFileSync(
      join(haloHome, 'node_modules', '.bin', 'halo'),
      `#!/usr/bin/env bash\necho "$*" > "${root}/halo.args"\necho "$PATH" > "${pathFile}"\nexit 0\n`,
    );
    chmodSync(join(haloHome, 'node_modules', '.bin', 'halo'), 0o755);

    let r = spawnSync(process.execPath, [firePath, 'nightly'], {
      env: { ...process.env, HALO_HOME: haloHome },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const path1 = readFileSync(pathFile, 'utf8').trim();
    expect(`:${path1}:`).toContain(`:${process.env['HOME']}/.local/bin:`);

    r = spawnSync(process.execPath, [firePath, 'nightly'], {
      env: { ...process.env, HALO_HOME: haloHome, HALO_PATH_EXTRA: '/opt/x' },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    const path2 = readFileSync(pathFile, 'utf8').trim();
    expect(path2.endsWith(':/opt/x')).toBe(true);
  });
});

describe('trigger-schedule: install/uninstall (schtasks, HALO_SCHEDULER 強制指定)', () => {
  it('install -> exit 0, TR string persists HALO_BIN/HALO_HOME; uninstall -> exit 0', () => {
    const root = mkTmp();
    const haloHome = join(root, 'halo');
    mkdirSync(join(haloHome, 'node_modules', '.bin'), { recursive: true });
    const installBin = join(haloHome, 'node_modules', '.bin', 'halo');
    writeFileSync(installBin, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(installBin, 0o755);

    const stubDir = join(root, 'stubbin');
    mkdirSync(stubDir, { recursive: true });
    const createLog = join(root, 'schtasks.create');
    writeFileSync(
      join(stubDir, 'schtasks.exe'),
      `#!/usr/bin/env bash\nfor a in "$@"; do [[ "$a" == /Create ]] && { printf '%s\\n' "$*" > "${createLog}"; break; }; done\nexit 0\n`,
    );
    chmodSync(join(stubDir, 'schtasks.exe'), 0o755);

    const r1 = spawnSync(process.execPath, [installJsPath, 'nightly'], {
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env['PATH'] ?? ''}`,
        HALO_SCHEDULER: 'schtasks',
        HALO_HOME: haloHome,
        HALO_BIN: installBin,
        HALO_PLUGIN_DIR: pluginRoot,
      },
      encoding: 'utf8',
    });
    expect(r1.status).toBe(0);

    const createArgs = readFileSync(createLog, 'utf8');
    expect(createArgs).toContain(`HALO_HOME="${haloHome}"`);
    expect(createArgs).toContain(`HALO_BIN="${installBin}"`);

    const r2 = spawnSync(process.execPath, [uninstallPath, 'nightly'], {
      env: { ...process.env, PATH: `${stubDir}:${process.env['PATH'] ?? ''}`, HALO_SCHEDULER: 'schtasks' },
      encoding: 'utf8',
    });
    expect(r2.status).toBe(0);
  });
});

describe('trigger-schedule: install/uninstall backends (自動検出, 隔離環境)', () => {
  it('(a) WSL相当スタブ: install.sh が schtasks /Create (DAILY /ST 03:00, env-embedded TR) を生成する', () => {
    const root = mkTmp();
    const coreBin = buildCoreBin(root);
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const procWsl = join(root, 'proc.wsl');
    writeFileSync(procWsl, 'Linux version 6.0 (microsoft-standard-WSL2)\n');

    const wslBin = join(root, 'stub.wsl');
    mkdirSync(wslBin, { recursive: true });
    const log = join(wslBin, 'schtasks.exe.log');
    writeFileSync(
      join(wslBin, 'schtasks.exe'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`,
    );
    chmodSync(join(wslBin, 'schtasks.exe'), 0o755);

    const r = runInstallIsolated(['nightly'], {
      stubDir: wslBin,
      coreBin,
      home,
      procFile: procWsl,
      extraEnv: { HALO_HOME: '/opt/halo', HALO_BIN: '/opt/halo/bin/halo' },
    });
    expect(r.code).toBe(0);
    const create = readFileSync(log, 'utf8');
    expect(create).toContain('/TN HALO_nightly');
    expect(create).toContain('/SC DAILY /ST 03:00');
    expect(create).toContain(
      `/TR wsl.exe -e bash -lc 'HALO_HOME="/opt/halo" HALO_BIN="/opt/halo/bin/halo" ${JSON.stringify(process.execPath)} ${JSON.stringify(resolvedFireJs)} nightly'`,
    );
  });

  it('(a) HALO_SCHEDULE_TIME=04:30 -> /ST 04:30', () => {
    const root = mkTmp();
    const coreBin = buildCoreBin(root);
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const procWsl = join(root, 'proc.wsl');
    writeFileSync(procWsl, 'Linux version 6.0 (microsoft-standard-WSL2)\n');
    const wslBin = join(root, 'stub.wsl');
    mkdirSync(wslBin, { recursive: true });
    const log = join(wslBin, 'schtasks.exe.log');
    writeFileSync(
      join(wslBin, 'schtasks.exe'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`,
    );
    chmodSync(join(wslBin, 'schtasks.exe'), 0o755);

    const r = runInstallIsolated(['nightly'], {
      stubDir: wslBin,
      coreBin,
      home,
      procFile: procWsl,
      extraEnv: { HALO_SCHEDULE_TIME: '04:30' },
    });
    expect(r.code).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('/SC DAILY /ST 04:30');
  });

  it('(a) invalid profile -> nonzero', () => {
    const root = mkTmp();
    const coreBin = buildCoreBin(root);
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const procWsl = join(root, 'proc.wsl');
    writeFileSync(procWsl, 'Linux version 6.0 (microsoft-standard-WSL2)\n');
    const wslBin = join(root, 'stub.wsl');
    mkdirSync(wslBin, { recursive: true });
    writeFileSync(join(wslBin, 'schtasks.exe'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(wslBin, 'schtasks.exe'), 0o755);

    const r = runInstallIsolated(['bad name'], { stubDir: wslBin, coreBin, home, procFile: procWsl });
    expect(r.code).not.toBe(0);
  });

  it('(b) cronのみのスタブ: install.sh がマーカー行を追加し既存行を保持する', () => {
    const root = mkTmp();
    const coreBin = buildCoreBin(root);
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const procPlain = join(root, 'proc.plain');
    writeFileSync(procPlain, 'Linux version 6.0 (generic)\n');

    const cronBin = join(root, 'stub.cron');
    mkdirSync(cronBin, { recursive: true });
    const state = join(cronBin, 'crontab.state');
    writeFileSync(
      join(cronBin, 'crontab'),
      `#!/usr/bin/env bash\nif [ "\${1:-}" = "-l" ]; then\n  [ -f "${state}" ] || { echo "no crontab" >&2; exit 1; }\n  cat "${state}"\nelif [ "\${1:-}" = "-" ]; then\n  cat > "${state}"\nfi\nexit 0\n`,
    );
    chmodSync(join(cronBin, 'crontab'), 0o755);
    writeFileSync(state, '0 0 * * * /keep/me\n');

    const r = runInstallIsolated(['nightly'], {
      stubDir: cronBin,
      coreBin,
      home,
      procFile: procPlain,
      extraEnv: { HALO_BIN: '/opt/halo/bin/halo' },
    });
    expect(r.code).toBe(0);
    const stateContent = readFileSync(state, 'utf8');
    expect(stateContent).toContain(
      `00 03 * * * HALO_BIN="/opt/halo/bin/halo" ${JSON.stringify(process.execPath)} ${JSON.stringify(resolvedFireJs)} nightly # HALO:schedule:nightly`,
    );
    expect(stateContent).toContain('/keep/me');
  });

  it('(c) cron uninstall: マーカー行だけ消え他行は残る', () => {
    const root = mkTmp();
    const coreBin = buildCoreBin(root);
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const procPlain = join(root, 'proc.plain');
    writeFileSync(procPlain, 'Linux version 6.0 (generic)\n');

    const cronBin = join(root, 'stub.cron');
    mkdirSync(cronBin, { recursive: true });
    const state = join(cronBin, 'crontab.state');
    writeFileSync(
      join(cronBin, 'crontab'),
      `#!/usr/bin/env bash\nif [ "\${1:-}" = "-l" ]; then\n  [ -f "${state}" ] || { echo "no crontab" >&2; exit 1; }\n  cat "${state}"\nelif [ "\${1:-}" = "-" ]; then\n  cat > "${state}"\nfi\nexit 0\n`,
    );
    chmodSync(join(cronBin, 'crontab'), 0o755);
    writeFileSync(state, `0 0 * * * /keep/me\n00 03 * * * ${firePath} nightly # HALO:schedule:nightly\n`);

    const r = runIsolated(process.execPath, [uninstallPath, 'nightly'], { stubDir: cronBin, coreBin, home, procFile: procPlain });
    expect(r.code).toBe(0);
    const stateContent = readFileSync(state, 'utf8');
    expect(stateContent).toContain('/keep/me');
    expect(stateContent).not.toContain('HALO:schedule:nightly');
  });

  it('(c) schtasks uninstall: /Delete /TN HALO_nightly /F が呼ばれる', () => {
    const root = mkTmp();
    const coreBin = buildCoreBin(root);
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const procWsl = join(root, 'proc.wsl');
    writeFileSync(procWsl, 'Linux version 6.0 (microsoft-standard-WSL2)\n');
    const wslBin = join(root, 'stub.wsl');
    mkdirSync(wslBin, { recursive: true });
    const log = join(wslBin, 'schtasks.exe.log');
    writeFileSync(
      join(wslBin, 'schtasks.exe'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`,
    );
    chmodSync(join(wslBin, 'schtasks.exe'), 0o755);

    const r = runIsolated(process.execPath, [uninstallPath, 'nightly'], { stubDir: wslBin, coreBin, home, procFile: procWsl });
    expect(r.code).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('/Delete /TN HALO_nightly /F');
  });
});
