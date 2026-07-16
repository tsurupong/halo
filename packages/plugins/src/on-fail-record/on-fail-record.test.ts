import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(__dirname, '..', '..', '..', '..', 'plugins', 'on-fail-record');
const launcherPath = join(pluginDir, 'record.sh');
const distPath = join(__dirname, '..', '..', 'dist', 'on-fail-record', 'main.js');

function runLauncher(input: string, env: Record<string, string> = {}) {
  const r = spawnSync('sh', [launcherPath], { input, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'halo-plugin-test-'));
  tmpDirs.push(d);
  return d;
}

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(`${distPath} が見つかりません。先に pnpm build を実行してください。`);
  }
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('on-fail-record メタデータ', () => {
  it('main.ts の先頭に // min-autonomy: L1 コメントがある', () => {
    const src = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(/^\/\/ min-autonomy:\s*L1/m.test(src)).toBe(true);
  });
});

describe('on-fail-record 正常系', () => {
  it('日時/タスク/gate/理由/対処 形式で追記し stdout は空', () => {
    const tmp = makeTmpDir();
    const catalog = join(tmp, '.halo', 'failure-catalog.md');
    const input = JSON.stringify({
      task_id: 'T-12',
      reason: 'coverage 87% < 90%',
      retry_count: 2,
      gate: '30-test',
      workdir: '/tmp/wt',
    });
    const result = runLauncher(input, { HALO_CATALOG: catalog });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(catalog)).toBe(true);
    const content = readFileSync(catalog, 'utf8');
    expect(content).toContain('タスク: T-12');
    expect(content).toContain('失敗ゲート: 30-test');
    expect(content).toContain('coverage 87% < 90%');
    expect(content).toContain('対処:');
  });

  it('複数回実行で ## 見出しが2件に累積する', () => {
    const tmp = makeTmpDir();
    const catalog = join(tmp, '.halo', 'failure-catalog.md');
    const input = JSON.stringify({
      task_id: 'T-12',
      reason: 'coverage 87% < 90%',
      retry_count: 2,
      gate: '30-test',
      workdir: '/tmp/wt',
    });
    runLauncher(input, { HALO_CATALOG: catalog });
    runLauncher(input, { HALO_CATALOG: catalog });
    const content = readFileSync(catalog, 'utf8');
    const count = (content.match(/^## /gm) ?? []).length;
    expect(count).toBe(2);
  });

  it('gate 欠落時は失敗ゲート: unknown となる', () => {
    const tmp = makeTmpDir();
    const catalog = join(tmp, '.halo', 'failure-catalog.md');
    runLauncher(JSON.stringify({ task_id: 'T-13', reason: 'stuck', retry_count: 0 }), {
      HALO_CATALOG: catalog,
    });
    const content = readFileSync(catalog, 'utf8');
    expect(content).toContain('失敗ゲート: unknown');
  });

  it('task_id 欠落は exit 0・stdout 空でスキップ', () => {
    const tmp = makeTmpDir();
    const catalog = join(tmp, '.halo', 'failure-catalog.md');
    const result = runLauncher(JSON.stringify({ reason: 'x', retry_count: 0 }), { HALO_CATALOG: catalog });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(catalog)).toBe(false);
  });

  it('HALO_CATALOG 未指定時は cwd の .halo/failure-catalog.md が既定', () => {
    const tmp = makeTmpDir();
    const repo = join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    const input = JSON.stringify({
      task_id: 'T-12',
      reason: 'coverage 87% < 90%',
      retry_count: 2,
      gate: '30-test',
      workdir: '/tmp/wt',
    });
    const env = { ...process.env };
    delete env['HALO_CATALOG'];
    const r = spawnSync('sh', [launcherPath], { input, cwd: repo, encoding: 'utf8', env });
    const status = r.status ?? 1;
    expect(status).toBe(0);
    expect(r.stdout).toBe('');
    const defCatalog = join(repo, '.halo', 'failure-catalog.md');
    expect(existsSync(defCatalog)).toBe(true);
    expect(readFileSync(defCatalog, 'utf8')).toContain('タスク: T-12');
  });
});
