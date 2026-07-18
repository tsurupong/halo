// runtime-node-pnpm の contract test(plugins/runtime-node-pnpm/test.contract.sh 相当)。
// setup.sh / check.sh / test.sh の各ランチャー経由でspawnし、
// pnpm はPATH上のスタブに差し替えて exit 0=pass / exit 2=fail の契約(stdout空)を検証する。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
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
      '#!/usr/bin/env bash\necho "pnpm stub: $*" >&2\nexit "${STUB_EXIT:-0}"\n',
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

  it('missing workdir -> exit 2', () => {
    const { code } = runLauncher(checkLauncher, '{}', stubEnv('0'));
    expect(code).toBe(2);
  });
});
