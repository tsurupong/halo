// status の実行結果サマリ集計 (D9 §3) の新規テスト。既存 status.test.ts には触れない
// (gate-loop-audit が既存テストファイル変更を fail にするため、追加分は本ファイルに置く)。
import { expect, test, describe, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { aggregateRuns, loadRuns, statusCommand } from './status.js';
import { memFs, captureStreams } from '../testkit.js';
import type { IterationLog } from '@tsurupong/halo-core';

const NOW = Date.parse('2026-07-16T12:00:00Z');
const noSpawn = vi.fn();

function entry(partial: Partial<IterationLog> & { iter: number }): IterationLog {
  return {
    started_at: '2026-07-16T09:00:00Z',
    ended_at: '2026-07-16T09:05:00Z',
    profile: 'daytime-l1',
    autonomy: 'L1',
    task: { task_id: 'T-1', kind: 'code' },
    gates: [],
    gate_pass_rate: null,
    outcome: 'passed',
    ...partial,
  } as IterationLog;
}

describe('aggregateRuns (D9 §3)', () => {
  test('counts totals and outcomes inside the window', () => {
    const summary = aggregateRuns(
      [
        entry({ iter: 1, outcome: 'passed' }),
        entry({ iter: 2, outcome: 'passed' }),
        entry({ iter: 3, outcome: 'no_task' }),
      ],
      { windowDays: 7, now: NOW },
    );
    expect(summary.total).toBe(3);
    expect(summary.byOutcome).toEqual({ passed: 2, no_task: 1 });
    expect(summary.failureCategories).toEqual({});
    expect(summary.windowDays).toBe(7);
  });

  test('classifies executor timeout/stuck ahead of gate reasons', () => {
    const summary = aggregateRuns(
      [
        entry({
          iter: 1,
          outcome: 'failed',
          executor: { status: 'timeout' },
          gates: [{ name: '30-test', result: 'fail', reason: 'rate limit hit' }],
        }),
        entry({ iter: 2, outcome: 'failed', executor: { status: 'stuck' } }),
      ],
      { windowDays: 7, now: NOW },
    );
    expect(summary.failureCategories).toEqual({ timeout: 1, stuck: 1 });
  });

  test('classifies transient gate reasons into named categories', () => {
    const gateFail = (reason: string, iter: number): IterationLog =>
      entry({
        iter,
        outcome: 'failed',
        gates: [{ name: '30-test', result: 'fail', reason }],
      });
    const summary = aggregateRuns(
      [
        gateFail('HTTP 429 too many requests', 1),
        gateFail('detected flaky test retry', 2),
        gateFail('fetch failed: ECONNRESET', 3),
        gateFail('step timed out after 90s', 4),
      ],
      { windowDays: 7, now: NOW },
    );
    expect(summary.failureCategories).toEqual({
      rate_limit: 1,
      flaky_test: 1,
      network: 1,
      timeout: 1,
    });
  });

  test('non-transient gate failure maps to gate:<name>, otherwise other', () => {
    const summary = aggregateRuns(
      [
        entry({
          iter: 1,
          outcome: 'failed',
          gates: [{ name: '20-lint', result: 'fail', reason: 'eslint errors: 3' }],
        }),
        entry({ iter: 2, outcome: 'escalated' }),
      ],
      { windowDays: 7, now: NOW },
    );
    expect(summary.failureCategories).toEqual({ 'gate:20-lint': 1, other: 1 });
  });

  test('--days window excludes older and unparsable timestamps', () => {
    const summary = aggregateRuns(
      [
        entry({ iter: 1, started_at: '2026-07-15T12:00:00Z' }),
        entry({ iter: 2, started_at: '2026-07-01T12:00:00Z' }),
        entry({ iter: 3, started_at: 'not-a-date' }),
      ],
      { windowDays: 3, now: NOW },
    );
    expect(summary.total).toBe(1);
    expect(summary.byOutcome).toEqual({ passed: 1 });
  });
});

describe('loadRuns', () => {
  test('reads every iter_N.json and skips broken documents', async () => {
    const fs = memFs({
      files: {
        '/repo/.halo/logs/iter_1.json': JSON.stringify(entry({ iter: 1 })),
        '/repo/.halo/logs/iter_2.json': '{broken',
        '/repo/.halo/logs/current.json': '{}',
      },
    });
    const runs = await loadRuns('/repo/.halo/logs', fs);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.iter).toBe(1);
  });

  test('missing log dir yields an empty list', async () => {
    expect(await loadRuns('/repo/.halo/logs', memFs())).toEqual([]);
  });
});

describe('status command summary output', () => {
  const files = {
    '/repo/.halo/logs/iter_1.json': JSON.stringify(entry({ iter: 1, outcome: 'passed' })),
    '/repo/.halo/logs/iter_2.json': JSON.stringify(
      entry({ iter: 2, outcome: 'failed', executor: { status: 'stuck' } }),
    ),
    '/repo/.halo/logs/iter_3.json': JSON.stringify(
      entry({ iter: 3, outcome: 'passed', started_at: '2026-07-01T00:00:00Z' }),
    ),
  };

  test('--json exposes the summary block without changing existing keys', async () => {
    const cap = captureStreams();
    await statusCommand(
      parseArgs(['--days', '7'], { valueFlags: ['days'] }),
      createIo(cap.streams, { cwd: '/repo', json: true, quiet: false, verbose: false }),
      { fs: memFs({ files }), now: NOW, spawn: noSpawn },
    );
    const out = JSON.parse(cap.out());
    expect(out.summary).toEqual({
      total: 2,
      byOutcome: { passed: 1, failed: 1 },
      failureCategories: { stuck: 1 },
      windowDays: 7,
    });
    expect(out.lastRun).toMatchObject({ iter: 3 });
    expect(out.budget).toBeDefined();
  });

  test('human-readable output shows the window summary and failure breakdown', async () => {
    const cap = captureStreams();
    await statusCommand(
      parseArgs(['--days', '30'], { valueFlags: ['days'] }),
      createIo(cap.streams, { cwd: '/repo', json: false, quiet: false, verbose: false }),
      { fs: memFs({ files }), now: NOW, spawn: noSpawn },
    );
    expect(cap.out()).toContain('直近30日の実績: 3 件');
    expect(cap.out()).toContain('失敗内訳: stuck 1');
  });

  test('invalid --days falls back to the 7-day default', async () => {
    const cap = captureStreams();
    await statusCommand(
      parseArgs(['--days', 'abc'], { valueFlags: ['days'] }),
      createIo(cap.streams, { cwd: '/repo', json: true, quiet: false, verbose: false }),
      { fs: memFs({ files }), now: NOW, spawn: noSpawn },
    );
    expect(JSON.parse(cap.out()).summary.windowDays).toBe(7);
  });
});
