// issue #54: runtime setup の失敗が stderr 1 行に消えていた問題の回帰テスト。
// setup 失敗は非致命 (処理続行) のまま、failure-catalog (.halo/failure-catalog.jsonl) へ
// gate=setup のレコードを 1 件残すこと — そして成功時には 1 バイトも書かないこと — を固定する。
// 書式は on-fail-record が書く JSONL と同一 (ts/task_id/gate/retry_count/reason) で、
// context-recent-failures がそのまま読める必要がある (スキーマ変更なし)。
import { describe, expect, it } from 'vitest';
import { failureCatalogJsonlPath, recordSetupFailure, SETUP_FAILURE_GATE } from './run-wiring.js';

/** logsFs シームの最小メモリ実装。writeFile は全文置換なので追記の検証にそのまま使える。 */
function memFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const mkdirs: string[] = [];
  return {
    files,
    mkdirs,
    readdir: () => Promise.resolve([]),
    readFile: (path: string) => Promise.resolve(files.get(path) ?? ''),
    mkdir: (path: string) => {
      mkdirs.push(path);
      return Promise.resolve(undefined);
    },
    writeFile: (path: string, data: string) => {
      files.set(path, data);
      return Promise.resolve();
    },
    exists: (path: string) => Promise.resolve(files.has(path)),
  };
}

const CATALOG = '/repo/.halo/failure-catalog.jsonl';
const failed = { exitCode: 1, signal: null, stderr: 'pnpm ERR! ENOENT\n', timedOut: false };

describe('recordSetupFailure (issue #54)', () => {
  it('setup 失敗時に gate=setup のレコードを 1 件追記する', async () => {
    const fs = memFs();
    const warnings: string[] = [];
    await recordSetupFailure({
      result: failed,
      catalogPath: CATALOG,
      fs,
      now: Date.parse('2026-08-08T12:34:56.789Z'),
      taskId: 'T-54',
      warn: (m) => warnings.push(m),
    });

    const lines = (fs.files.get(CATALOG) ?? '').split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    // 既存レコードとキー集合が一致する (スキーマ不変)。
    expect(Object.keys(rec).sort()).toEqual(['gate', 'reason', 'retry_count', 'task_id', 'ts']);
    expect(rec['gate']).toBe(SETUP_FAILURE_GATE);
    expect(rec['gate']).toBe('setup'); // setup 由来と識別できる値
    expect(rec['task_id']).toBe('T-54');
    expect(rec['retry_count']).toBe(0);
    // reason は describeSetupFailure の結果 (exit code + stderr 末尾)。
    expect(rec['reason']).toContain('exit 1');
    expect(rec['reason']).toContain('pnpm ERR! ENOENT');
    // ts は on-fail-record と同じくミリ秒を落とした ISO8601。
    expect(rec['ts']).toBe('2026-08-08T12:34:56Z');
    // stderr への従来の 1 行は維持される (診断の後方互換)。
    expect(warnings.join('')).toContain('runtime setup failed');
  });

  it('setup 成功時には何も追記しない', async () => {
    const fs = memFs();
    const warnings: string[] = [];
    await recordSetupFailure({
      result: { exitCode: 0, signal: null, stderr: '', timedOut: false },
      catalogPath: CATALOG,
      fs,
      now: 0,
      taskId: 'T-54',
      warn: (m) => warnings.push(m),
    });

    expect(fs.files.has(CATALOG)).toBe(false);
    expect(fs.mkdirs).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('既存カタログの末尾へ追記する (既存行を壊さない)', async () => {
    const existing = `${JSON.stringify({
      ts: '2026-08-01T00:00:00Z',
      task_id: 'T-1',
      gate: '30-test',
      retry_count: 1,
      reason: 'old',
    })}\n`;
    const fs = memFs({ [CATALOG]: existing });
    await recordSetupFailure({
      result: failed,
      catalogPath: CATALOG,
      fs,
      now: 0,
      taskId: 'T-54',
      warn: () => undefined,
    });

    const body = fs.files.get(CATALOG) ?? '';
    expect(body.startsWith(existing)).toBe(true);
    const lines = body.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1]!) as { gate: string }).gate).toBe('setup');
  });

  it('signal / timeout 終了も記録される', async () => {
    const fs = memFs();
    await recordSetupFailure({
      result: { exitCode: null, signal: 'SIGKILL', stderr: '', timedOut: true },
      catalogPath: CATALOG,
      fs,
      now: 0,
      taskId: 'T-54',
      warn: () => undefined,
    });

    const line = (fs.files.get(CATALOG) ?? '').trim();
    expect((JSON.parse(line) as { reason: string }).reason).toBe('signal SIGKILL (timeout)');
  });

  it('カタログ書き込み失敗は致命化しない (記録のみ方針の維持)', async () => {
    const fs = {
      ...memFs(),
      mkdir: () => Promise.reject(new Error('EACCES')),
    };
    await expect(
      recordSetupFailure({
        result: failed,
        catalogPath: CATALOG,
        fs,
        now: 0,
        taskId: 'T-54',
        warn: () => undefined,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('failureCatalogJsonlPath', () => {
  it('既定は haloDir 直下の failure-catalog.jsonl', () => {
    const prev = process.env['HALO_CATALOG_JSONL'];
    delete process.env['HALO_CATALOG_JSONL'];
    try {
      expect(failureCatalogJsonlPath('/repo/.halo')).toBe('/repo/.halo/failure-catalog.jsonl');
    } finally {
      if (prev !== undefined) process.env['HALO_CATALOG_JSONL'] = prev;
    }
  });

  it('HALO_CATALOG_JSONL があればそれを使う (on-fail-record と同じ上書き規約)', () => {
    const prev = process.env['HALO_CATALOG_JSONL'];
    process.env['HALO_CATALOG_JSONL'] = '/tmp/custom.jsonl';
    try {
      expect(failureCatalogJsonlPath('/repo/.halo')).toBe('/tmp/custom.jsonl');
    } finally {
      if (prev === undefined) delete process.env['HALO_CATALOG_JSONL'];
      else process.env['HALO_CATALOG_JSONL'] = prev;
    }
  });
});
