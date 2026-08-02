// runtime-node-pnpm の contract test(plugins/runtime-node-pnpm/test.contract.sh 相当)。
// setup.sh / check.sh / test.sh の各ランチャー経由でspawnし、
// pnpm はPATH上のスタブに差し替えて exit 0=pass / exit 2=fail の契約(stdout空)を検証する。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', '..', 'dist', 'runtime-node-pnpm');
const setupLauncher = join(distDir, 'setup.js');
const checkLauncher = join(distDir, 'check.js');
const testLauncher = join(distDir, 'test.js');

for (const f of ['setup.js', 'check.js', 'test.js']) {
  const p = join(distDir, f);
  if (!existsSync(p)) {
    throw new Error(`dist not found: ${p} — run 'pnpm build' first`);
  }
}

function runLauncher(
  launcherPath: string,
  input: string,
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [launcherPath], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

describe('runtime-node-pnpm (launcher contract)', () => {
  let stubRoot: string;
  let stubBinDir: string;
  let workdir: string;

  beforeAll(() => {
    stubRoot = mkdtempSync(join(tmpdir(), 'halo-plugin-test-'));
    stubBinDir = join(stubRoot, 'bin');
    mkdirSync(stubBinDir, { recursive: true });
    writeFileSync(
      join(stubBinDir, 'pnpm'),
      '#!/usr/bin/env bash\necho "pnpm stub: $*" >&2\nif [ -n "${STUB_SIGNAL:-}" ]; then kill -s "$STUB_SIGNAL" $$; sleep 5; fi\nexit "${STUB_EXIT:-0}"\n',
    );
    chmodSync(join(stubBinDir, 'pnpm'), 0o755);
    workdir = join(stubRoot, 'wt');
    mkdirSync(workdir, { recursive: true });
  });

  afterAll(() => {
    rmSync(stubRoot, { recursive: true, force: true });
  });

  function input(): string {
    return JSON.stringify({ workdir, changed_files: ['src/a.ts'] });
  }

  function stubEnv(stubExit: string): Record<string, string> {
    return { PATH: `${stubBinDir}:${process.env['PATH'] ?? ''}`, STUB_EXIT: stubExit };
  }

  it('setup: pnpm success -> exit 0, stdout empty', () => {
    const { code, stdout } = runLauncher(setupLauncher, input(), stubEnv('0'));
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('setup: pnpm failure -> exit 2, stdout empty', () => {
    const { code, stdout } = runLauncher(setupLauncher, input(), stubEnv('1'));
    expect(code).toBe(2);
    expect(stdout).toBe('');
  });

  it('check: pnpm success -> exit 0, stdout empty', () => {
    const { code, stdout } = runLauncher(checkLauncher, input(), stubEnv('0'));
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('check: pnpm failure -> exit 2, stdout empty', () => {
    const { code, stdout } = runLauncher(checkLauncher, input(), stubEnv('1'));
    expect(code).toBe(2);
    expect(stdout).toBe('');
  });

  it('test: pnpm success -> exit 0, stdout empty', () => {
    const { code, stdout } = runLauncher(testLauncher, input(), stubEnv('0'));
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('test: pnpm failure -> exit 2, stdout empty', () => {
    const { code, stdout } = runLauncher(testLauncher, input(), stubEnv('1'));
    expect(code).toBe(2);
    expect(stdout).toBe('');
  });

  it('setup: pnpm killed by signal -> exit 2, 理由が stderr に残る (issue #27)', () => {
    const { code, stdout, stderr } = runLauncher(setupLauncher, input(), {
      ...stubEnv('0'),
      STUB_SIGNAL: 'TERM',
    });
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('signal 終了: SIGTERM');
  });

  it('setup: node_modules の bin 実行ビットを復元する (issue #42)', () => {
    const statMode = (p: string): number => statSync(p).mode & 0o111;
    const binDir = join(workdir, 'node_modules', '.bin');
    const esbuildBin = join(workdir, 'node_modules', '@esbuild', 'linux-x64', 'bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(esbuildBin, { recursive: true });
    writeFileSync(join(binDir, 'vitest'), '#!/usr/bin/env node\n');
    writeFileSync(join(esbuildBin, 'esbuild'), 'binary');
    chmodSync(join(binDir, 'vitest'), 0o644);
    chmodSync(join(esbuildBin, 'esbuild'), 0o644);

    const { code } = runLauncher(setupLauncher, input(), stubEnv('0'));
    expect(code).toBe(0);
    expect(statMode(join(binDir, 'vitest'))).not.toBe(0);
    expect(statMode(join(esbuildBin, 'esbuild'))).not.toBe(0);
  });

  it('setup: pnpm の symlink 構造でも非スコープパッケージの bin を復元する (issue #42)', () => {
    // pnpm では node_modules/<pkg> は .pnpm 配下実体への symlink。
    const pnpmImpl = join(workdir, 'node_modules', '.pnpm', 'tsx@1.0.0', 'node_modules', 'tsx');
    mkdirSync(join(pnpmImpl, 'bin'), { recursive: true });
    writeFileSync(join(pnpmImpl, 'bin', 'tsx'), '#!/usr/bin/env node\n');
    chmodSync(join(pnpmImpl, 'bin', 'tsx'), 0o644);
    const link = join(workdir, 'node_modules', 'tsx');
    rmSync(link, { recursive: true, force: true });
    symlinkSync(pnpmImpl, link);

    const { code } = runLauncher(setupLauncher, input(), stubEnv('0'));
    expect(code).toBe(0);
    expect(statSync(join(pnpmImpl, 'bin', 'tsx')).mode & 0o111).not.toBe(0);
  });

  it('setup: pnpm 失敗時は実行ビット復元を行わない', () => {
    const binDir = join(workdir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'tsc'), '#!/usr/bin/env node\n');
    chmodSync(join(binDir, 'tsc'), 0o644);

    const { code } = runLauncher(setupLauncher, input(), stubEnv('1'));
    expect(code).toBe(2);
    expect(statSync(join(binDir, 'tsc')).mode & 0o111).toBe(0);
  });

  it('missing workdir -> exit 2', () => {
    const { code } = runLauncher(checkLauncher, '{}', stubEnv('0'));
    expect(code).toBe(2);
  });
});
