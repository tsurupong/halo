// gate-runtime-check の contract test(plugins/gate-runtime-check/test.contract.sh 相当)。
// 10-typecheck/run.sh, 30-test/run.sh の各ランチャー経由でspawnし、
// pnpm はPATH上のスタブに差し替えて runtime-node-pnpm への委譲・gate.out契約を検証する。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(__dirname, '..', '..', '..', '..', 'plugins', 'gate-runtime-check');
const typecheckLauncher = join(pluginRoot, '10-typecheck', 'run.sh');
const testLauncher = join(pluginRoot, '30-test', 'run.sh');
const distTypecheck = join(__dirname, '..', '..', 'dist', 'gate-runtime-check', 'typecheck.js');
const distTest = join(__dirname, '..', '..', 'dist', 'gate-runtime-check', 'test.js');

if (!existsSync(distTypecheck)) {
  throw new Error(`dist not found: ${distTypecheck} — run 'pnpm build' first`);
}
if (!existsSync(distTest)) {
  throw new Error(`dist not found: ${distTest} — run 'pnpm build' first`);
}

function runLauncher(
  launcherPath: string,
  input: string,
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('sh', [launcherPath], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

describe('gate-runtime-check (launcher contract)', () => {
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
    return JSON.stringify({ task_id: 'T-1', workdir, changed_files: ['src/a.ts'] });
  }

  function stubEnv(stubExit: string): Record<string, string> {
    return { PATH: `${stubBinDir}:${process.env['PATH'] ?? ''}`, STUB_EXIT: stubExit };
  }

  it('10-typecheck: pnpm success -> exit 0, stdout empty', () => {
    const { code, stdout } = runLauncher(typecheckLauncher, input(), stubEnv('0'));
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('10-typecheck: pnpm failure -> exit 2, gate.out shape', () => {
    const { code, stdout } = runLauncher(typecheckLauncher, input(), stubEnv('1'));
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('10-typecheck');
  });

  it('10-typecheck: missing workdir -> exit 2, gate.out shape', () => {
    const missingInput = JSON.stringify({ task_id: 'T-1', changed_files: [] });
    const { code, stdout } = runLauncher(typecheckLauncher, missingInput, stubEnv('0'));
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('10-typecheck');
  });

  it('30-test: pnpm success -> exit 0, stdout empty', () => {
    const { code, stdout } = runLauncher(testLauncher, input(), stubEnv('0'));
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('30-test: pnpm failure -> exit 2, gate.out shape', () => {
    const { code, stdout } = runLauncher(testLauncher, input(), stubEnv('1'));
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('30-test');
  });

  it('30-test: missing workdir -> exit 2, gate.out shape', () => {
    const missingInput = JSON.stringify({ task_id: 'T-1', changed_files: [] });
    const { code, stdout } = runLauncher(testLauncher, missingInput, stubEnv('0'));
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('30-test');
  });
});
