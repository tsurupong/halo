// `halo history` と status のコスト集計 (aggregateCost) のテスト。
import { expect, test, describe } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { aggregateCost } from './status.js';
import { selectHistory, historyCommand } from './history.js';
import { memFs, captureStreams } from '../testkit.js';
import type { IterationLog } from '@tsurupong/halo-core';

const NOW = Date.parse('2026-07-22T12:00:00Z');

function entry(partial: Partial<IterationLog> & { iter: number }): IterationLog {
  return {
    started_at: '2026-07-22T09:00:00Z',
    ended_at: '2026-07-22T09:05:00Z',
    profile: 'daytime-l1',
    autonomy: 'L1',
    task: { task_id: 'T-1', kind: 'code' },
    gates: [],
    gate_pass_rate: null,
    outcome: 'passed',
    ...partial,
  } as IterationLog;
}

describe('aggregateCost', () => {
  test('期間内の executor コストを合算し cost 欠損は 0 扱い', () => {
    const cost = aggregateCost(
      [
        entry({
          iter: 1,
          executor: { status: 'done', cost: { input_tokens: 100, output_tokens: 50, usd_estimate: 0.25 } },
        }),
        entry({
          iter: 2,
          executor: { status: 'done', cost: { input_tokens: 200, output_tokens: 10, usd_estimate: 0.5 } },
        }),
        entry({ iter: 3 }), // cost 無し (旧ログ)
        entry({
          iter: 4,
          started_at: '2026-07-01T00:00:00Z', // 期間外
          executor: { status: 'done', cost: { input_tokens: 999, output_tokens: 999, usd_estimate: 9 } },
        }),
      ],
      { windowDays: 7, now: NOW },
    );
    expect(cost).toEqual({ input_tokens: 300, output_tokens: 60, usd: 0.75 });
  });

  test('usd_estimate が null でも合算は壊れない', () => {
    const cost = aggregateCost(
      [entry({ iter: 1, executor: { status: 'done', cost: { input_tokens: 1, usd_estimate: null } } })],
      { windowDays: 7, now: NOW },
    );
    expect(cost).toEqual({ input_tokens: 1, output_tokens: 0, usd: 0 });
  });
});

describe('selectHistory', () => {
  test('期間内を started_at 昇順に整列し limit は末尾 (新しい側) から適用', () => {
    const rows = selectHistory(
      [
        entry({ iter: 3, started_at: '2026-07-22T03:00:00Z' }),
        entry({ iter: 1, started_at: '2026-07-22T01:00:00Z' }),
        entry({ iter: 2, started_at: '2026-07-22T02:00:00Z' }),
        entry({ iter: 4, started_at: 'not-a-date' }),
        entry({ iter: 5, started_at: '2026-06-01T00:00:00Z' }),
      ],
      { windowDays: 7, now: NOW, limit: 2 },
    );
    expect(rows.map((r) => r.iter)).toEqual([2, 3]);
  });

  test('失敗 iter は理由分類・コストを行へ写像する', () => {
    const rows = selectHistory(
      [
        entry({
          iter: 1,
          outcome: 'failed',
          task: { task_id: 'T-9', kind: 'code', retry_count: 2 },
          executor: { status: 'stuck', cost: { usd_estimate: 0.12 } },
        }),
        entry({ iter: 2, outcome: 'passed' }),
      ],
      { windowDays: 7, now: NOW, limit: 20 },
    );
    expect(rows[0]).toMatchObject({
      iter: 1,
      task_id: 'T-9',
      retry_count: 2,
      category: 'stuck',
      usd: 0.12,
    });
    expect(rows[1]).toMatchObject({ iter: 2, category: null, usd: null });
  });
});

describe('history command', () => {
  const files = {
    '/repo/.halo/logs/iter_1.json': JSON.stringify(
      entry({ iter: 1, started_at: '2026-07-22T01:00:00Z', outcome: 'passed' }),
    ),
    '/repo/.halo/logs/iter_2.json': JSON.stringify(
      entry({
        iter: 2,
        started_at: '2026-07-22T02:00:00Z',
        outcome: 'failed',
        executor: { status: 'timeout', cost: { usd_estimate: 0.3 } },
      }),
    ),
  };

  test('--json で行配列を返す', async () => {
    const cap = captureStreams();
    await historyCommand(
      parseArgs(['--days', '7'], { valueFlags: ['days', 'limit'] }),
      createIo(cap.streams, { cwd: '/repo', json: true, quiet: false, verbose: false }),
      { fs: memFs({ files }), now: NOW },
    );
    const out = JSON.parse(cap.out()) as { ok: boolean; rows: Array<{ iter: number }> };
    expect(out.ok).toBe(true);
    expect(out.rows.map((r) => r.iter)).toEqual([1, 2]);
  });

  test('人間向け出力は 1 行 1 iter で outcome と分類を含む', async () => {
    const cap = captureStreams();
    await historyCommand(
      parseArgs([], { valueFlags: ['days', 'limit'] }),
      createIo(cap.streams, { cwd: '/repo', json: false, quiet: false, verbose: false }),
      { fs: memFs({ files }), now: NOW },
    );
    const text = cap.out();
    expect(text).toContain('iter 1');
    expect(text).toContain('passed');
    expect(text).toContain('timeout');
    expect(text).toContain('$0.30');
  });

  test('ログ不在時は空メッセージで exit 0', async () => {
    const cap = captureStreams();
    const code = await historyCommand(
      parseArgs([], { valueFlags: ['days', 'limit'] }),
      createIo(cap.streams, { cwd: '/repo', json: false, quiet: false, verbose: false }),
      { fs: memFs(), now: NOW },
    );
    expect(code).toBe(0);
    expect(cap.out()).toContain('ありません');
  });
});
