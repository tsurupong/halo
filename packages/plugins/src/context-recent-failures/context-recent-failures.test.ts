import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', '..', 'dist', 'context-recent-failures', 'main.js');

function run(input: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [distPath], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

interface Fragment {
  source: string;
  content: string;
  priority: number;
}
function fragmentsOf(stdout: string): Fragment[] {
  return (JSON.parse(stdout) as { fragments: Fragment[] }).fragments;
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'halo-plugin-test-'));
  tmpDirs.push(d);
  return d;
}

function writeCatalog(lines: string[]): string {
  const tmp = makeTmpDir();
  const path = join(tmp, '.halo', 'failure-catalog.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function rec(taskId: string, reason: string, retry = 1): string {
  return JSON.stringify({
    ts: '2026-07-22T00:00:00Z',
    task_id: taskId,
    gate: '30-test',
    retry_count: retry,
    reason,
  });
}

const TASK = JSON.stringify({ task_id: 'T-12', title: 'Fix bug', kind: 'code' });

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

describe('context-recent-failures メタデータ', () => {
  it('main.ts の先頭に // min-autonomy: L1 コメントがある', () => {
    const src = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(/^\/\/ min-autonomy:\s*L1/m.test(src)).toBe(true);
  });
});

describe('context-recent-failures', () => {
  it('カタログ不在時は空 fragments で exit 0', () => {
    const tmp = makeTmpDir();
    const result = run(TASK, { HALO_CATALOG_JSONL: join(tmp, 'none.jsonl') });
    expect(result.code).toBe(0);
    expect(fragmentsOf(result.stdout)).toEqual([]);
  });

  it('task_id 一致行のみを fragment 化する', () => {
    const catalog = writeCatalog([rec('T-12', 'coverage 87% < 90%'), rec('T-99', 'other task')]);
    const result = run(TASK, { HALO_CATALOG_JSONL: catalog });
    expect(result.code).toBe(0);
    const frags = fragmentsOf(result.stdout);
    expect(frags).toHaveLength(1);
    expect(frags[0]).toMatchObject({ source: 'recent-failures', priority: 50 });
    expect(frags[0]!.content).toContain('coverage 87% < 90%');
    expect(frags[0]!.content).not.toContain('other task');
  });

  it('HALO_RECENT_FAILURES_MAX で直近 N 件に丸める (末尾優先)', () => {
    const catalog = writeCatalog([
      rec('T-12', 'oldest', 1),
      rec('T-12', 'middle', 2),
      rec('T-12', 'newest', 3),
    ]);
    const result = run(TASK, { HALO_CATALOG_JSONL: catalog, HALO_RECENT_FAILURES_MAX: '2' });
    const content = fragmentsOf(result.stdout)[0]!.content;
    expect(content).toContain('middle');
    expect(content).toContain('newest');
    expect(content).not.toContain('oldest');
  });

  it('不正 JSON 行はスキップして残りを処理する', () => {
    const catalog = writeCatalog(['{broken', rec('T-12', 'valid entry')]);
    const result = run(TASK, { HALO_CATALOG_JSONL: catalog });
    expect(result.code).toBe(0);
    expect(fragmentsOf(result.stdout)[0]!.content).toContain('valid entry');
  });

  it('task_id 欠落 (op=next で task 無し) は空 fragments', () => {
    const catalog = writeCatalog([rec('T-12', 'x')]);
    const result = run(JSON.stringify({ task_id: null }), { HALO_CATALOG_JSONL: catalog });
    expect(result.code).toBe(0);
    expect(fragmentsOf(result.stdout)).toEqual([]);
  });
});
