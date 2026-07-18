// gate-runtime-check の delegate 契約テスト。
// dist の typecheck.js/test.js を直接 spawn し、HALO_PLUGIN_DIR + HALO_RUNTIME_DIR 経由で
// fake runtime plugin.json(entry/aux)を解決させて委譲・gate.out契約を検証する。
// ランチャー(run.sh)は本タスクのスコープ外(自身のディレクトリを export するだけ)で
// HALO_PLUGIN_DIR は与えないため、このテストでは run.sh を経由せず dist を直接叩く。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distTypecheck = join(__dirname, '..', '..', 'dist', 'gate-runtime-check', 'typecheck.js');
const distTest = join(__dirname, '..', '..', 'dist', 'gate-runtime-check', 'test.js');

if (!existsSync(distTypecheck)) {
  throw new Error(`dist not found: ${distTypecheck} — run 'pnpm build' first`);
}
if (!existsSync(distTest)) {
  throw new Error(`dist not found: ${distTest} — run 'pnpm build' first`);
}

function runDist(
  distPath: string,
  input: string,
  env: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [distPath], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

describe('gate-runtime-check (delegate contract)', () => {
  let stubRoot: string;
  let pluginDir: string;
  let runtimeDir: string;
  let workdir: string;

  beforeAll(() => {
    stubRoot = mkdtempSync(join(tmpdir(), 'halo-plugin-test-'));
    // gate 側 plugin.json(entry のみで足りるが、実運用同様に置いておく)。
    pluginDir = join(stubRoot, 'gate-runtime-check', '10-typecheck');
    mkdirSync(pluginDir, { recursive: true });

    // fake runtime: plugin.json(entry/aux) + check.js/test.js(STUB_EXIT で終了コード制御)。
    runtimeDir = join(stubRoot, 'runtime-node-pnpm');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, 'plugin.json'),
      JSON.stringify({
        name: '@halo/plugin-runtime-node-pnpm',
        version: '1.0.0',
        port: 'runtime',
        entry: 'setup.js',
        aux: { check: 'check.js', test: 'test.js' },
      }),
    );
    for (const name of ['check.js', 'test.js']) {
      writeFileSync(
        join(runtimeDir, name),
        "process.exit(process.env.STUB_EXIT ? Number(process.env.STUB_EXIT) : 0);\n",
      );
    }

    workdir = join(stubRoot, 'wt');
    mkdirSync(workdir, { recursive: true });
  });

  afterAll(() => {
    rmSync(stubRoot, { recursive: true, force: true });
  });

  function input(): string {
    return JSON.stringify({ task_id: 'T-1', workdir, changed_files: ['src/a.ts'] });
  }

  function baseEnv(stubExit: string): Record<string, string> {
    return { HALO_PLUGIN_DIR: pluginDir, HALO_RUNTIME_DIR: runtimeDir, STUB_EXIT: stubExit };
  }

  it('10-typecheck: runtime check exit 0 -> exit 0, stdout empty', () => {
    const { code, stdout } = runDist(distTypecheck, input(), baseEnv('0'));
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('10-typecheck: runtime check exit 1 -> exit 2, gate.out shape', () => {
    const { code, stdout } = runDist(distTypecheck, input(), baseEnv('1'));
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('10-typecheck');
  });

  it('10-typecheck: missing workdir -> exit 2, gate.out shape', () => {
    const missingInput = JSON.stringify({ task_id: 'T-1', changed_files: [] });
    const { code, stdout } = runDist(distTypecheck, missingInput, baseEnv('0'));
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('10-typecheck');
  });

  it('30-test: runtime test exit 0 -> exit 0, stdout empty', () => {
    const { code, stdout } = runDist(distTest, input(), baseEnv('0'));
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('30-test: runtime test exit 1 -> exit 2, gate.out shape', () => {
    const { code, stdout } = runDist(distTest, input(), baseEnv('1'));
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('30-test');
  });

  it('30-test: missing workdir -> exit 2, gate.out shape', () => {
    const missingInput = JSON.stringify({ task_id: 'T-1', changed_files: [] });
    const { code, stdout } = runDist(distTest, missingInput, baseEnv('0'));
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(typeof out.reason).toBe('string');
    expect(out.gate).toBe('30-test');
  });

  it('runtime plugin.json not found -> exit 2, gate.out shape', () => {
    const { code, stdout } = runDist(distTypecheck, input(), {
      HALO_PLUGIN_DIR: pluginDir,
      HALO_RUNTIME_DIR: join(stubRoot, 'missing-runtime'),
    });
    expect(code).toBe(2);
    const out = JSON.parse(stdout) as { reason: string; gate: string };
    expect(out.reason).toContain('runtime plugin.json not found');
    expect(out.gate).toBe('10-typecheck');
  });
});
