// on-fail-record の JSONL 併記の新規テスト。既存 on-fail-record.test.ts には触れない
// (gate-loop-audit が既存テストファイル変更を fail にするため、追加分は本ファイルに置く)。
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', '..', 'dist', 'on-fail-record', 'main.js');

function run(input: string, env: Record<string, string> = {}) {
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

describe('on-fail-record JSONL 併記', () => {
  it('HALO_CATALOG_JSONL へ構造化レコードを 1 行追記する', () => {
    const tmp = makeTmpDir();
    const catalog = join(tmp, '.halo', 'failure-catalog.md');
    const jsonl = join(tmp, '.halo', 'failure-catalog.jsonl');
    const result = run(
      JSON.stringify({
        task_id: 'T-12',
        reason: 'coverage 87% < 90%',
        retry_count: 2,
        gate: '30-test',
        workdir: '/tmp/wt',
      }),
      { HALO_CATALOG: catalog, HALO_CATALOG_JSONL: jsonl },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    const lines = readFileSync(jsonl, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec).toMatchObject({
      task_id: 'T-12',
      gate: '30-test',
      retry_count: 2,
      reason: 'coverage 87% < 90%',
    });
    expect(typeof rec.ts).toBe('string');
  });

  it('複数回実行で行が累積する', () => {
    const tmp = makeTmpDir();
    const catalog = join(tmp, '.halo', 'failure-catalog.md');
    const jsonl = join(tmp, '.halo', 'failure-catalog.jsonl');
    const input = JSON.stringify({ task_id: 'T-12', reason: 'x', retry_count: 1 });
    run(input, { HALO_CATALOG: catalog, HALO_CATALOG_JSONL: jsonl });
    run(input, { HALO_CATALOG: catalog, HALO_CATALOG_JSONL: jsonl });
    expect(readFileSync(jsonl, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('task_id 欠落時は JSONL も書かない', () => {
    const tmp = makeTmpDir();
    const jsonl = join(tmp, '.halo', 'failure-catalog.jsonl');
    const result = run(JSON.stringify({ reason: 'x', retry_count: 0 }), {
      HALO_CATALOG: join(tmp, '.halo', 'failure-catalog.md'),
      HALO_CATALOG_JSONL: jsonl,
    });
    expect(result.code).toBe(0);
    expect(existsSync(jsonl)).toBe(false);
  });
});
