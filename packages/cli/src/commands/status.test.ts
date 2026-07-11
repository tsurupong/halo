import { expect, test, describe, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { statusCommand } from './status.js';
import { EXIT } from '../exit-codes.js';
import { memFs, captureStreams } from '../testkit.js';

function io(cap: ReturnType<typeof captureStreams>, json = false) {
  return createIo(cap.streams, { cwd: '/repo', json, quiet: false, verbose: false });
}
const noSpawn = vi.fn();
const NOW = Date.parse('2026-07-11T12:00:00Z');

function iterLog(iter: number, outcome: string, at: string) {
  return JSON.stringify({ iter, outcome, started_at: at, ended_at: at });
}

describe('status (T26)', () => {
  test('--json reports budget, last run, stop, and triggers', async () => {
    const fs = memFs({
      files: {
        '/repo/.halo/logs/iter_1.json': iterLog(1, 'passed', '2026-07-11T09:00:00Z'),
        '/repo/.halo/logs/iter_2.json': iterLog(2, 'no_task', '2026-07-11T10:00:00Z'),
      },
    });
    const cap = captureStreams();
    const code = await statusCommand(parseArgs([], {}), io(cap, true), {
      fs,
      now: NOW,
      spawn: noSpawn,
      limits: { dailyMaxIterations: 10 },
    });
    expect(code).toBe(EXIT.OK);
    const out = JSON.parse(cap.out());
    expect(out.budget.usedIterations).toBe(2);
    expect(out.budget.remainingIterations).toBe(8);
    expect(out.lastRun).toMatchObject({ iter: 2, outcome: 'no_task' });
    expect(out.stop).toBe(false);
  });

  test('human-readable output shows budget remaining and last run', async () => {
    const fs = memFs({
      files: { '/repo/.halo/logs/iter_5.json': iterLog(5, 'passed', '2026-07-11T11:00:00Z') },
    });
    const cap = captureStreams();
    await statusCommand(parseArgs([], {}), io(cap), {
      fs,
      now: NOW,
      spawn: noSpawn,
      limits: { dailyMaxIterations: 20 },
    });
    expect(cap.out()).toContain('直近ループ: iter 5 — passed');
    expect(cap.out()).toContain('残 19');
  });

  test('no logs yields zero usage and no last run', async () => {
    const fs = memFs();
    const cap = captureStreams();
    await statusCommand(parseArgs([], {}), io(cap, true), { fs, now: NOW, spawn: noSpawn });
    const out = JSON.parse(cap.out());
    expect(out.budget.usedIterations).toBe(0);
    expect(out.lastRun).toBeNull();
  });

  test('reflects a present STOP file', async () => {
    const fs = memFs({ files: { '/repo/.halo/STOP': 'x' } });
    const cap = captureStreams();
    await statusCommand(parseArgs([], {}), io(cap, true), { fs, now: NOW, spawn: noSpawn });
    expect(JSON.parse(cap.out()).stop).toBe(true);
  });

  test('--profile resolves budget limits from the profile env file', async () => {
    const fs = memFs({
      files: {
        '/repo/.halo/logs/iter_1.json': iterLog(1, 'passed', '2026-07-11T09:00:00Z'),
        '/repo/.halo/profiles/nightly.env': 'DAILY_MAX_ITERATIONS=80\nDAILY_MAX_COST_USD=12\n',
      },
    });
    const cap = captureStreams();
    // limits を注入せず、--profile 経由でプロファイル env から解決させる。
    await statusCommand(parseArgs(['--profile', 'nightly'], { valueFlags: ['profile'] }), io(cap, true), {
      fs,
      now: NOW,
      spawn: noSpawn,
    });
    const out = JSON.parse(cap.out());
    expect(out.budget.dailyMaxIterations).toBe(80);
    expect(out.budget.dailyMaxCostUsd).toBe(12);
    expect(out.budget.remainingIterations).toBe(79);
  });

  test('different --profile selects a different budget', async () => {
    const fs = memFs({
      files: {
        '/repo/.halo/profiles/daytime-l1.env': 'DAILY_MAX_ITERATIONS=30\n',
        '/repo/.halo/profiles/nightly.env': 'DAILY_MAX_ITERATIONS=80\n',
      },
    });
    const cap = captureStreams();
    await statusCommand(parseArgs(['--profile', 'daytime-l1'], { valueFlags: ['profile'] }), io(cap, true), {
      fs,
      now: NOW,
      spawn: noSpawn,
    });
    expect(JSON.parse(cap.out()).budget.dailyMaxIterations).toBe(30);
  });

  test('missing profile file degrades gracefully to unlimited with a warning', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const code = await statusCommand(
      parseArgs(['--profile', 'ghost'], { valueFlags: ['profile'] }),
      io(cap, true),
      { fs, now: NOW, spawn: noSpawn },
    );
    expect(code).toBe(EXIT.OK);
    const out = JSON.parse(cap.out());
    expect(out.budget.remainingIterations).toBeNull();
    expect(cap.err()).toContain("profile 'ghost' not found");
  });

  test('no --profile leaves the budget unlimited', async () => {
    const fs = memFs({
      files: { '/repo/.halo/logs/iter_1.json': iterLog(1, 'passed', '2026-07-11T09:00:00Z') },
    });
    const cap = captureStreams();
    await statusCommand(parseArgs([], {}), io(cap, true), { fs, now: NOW, spawn: noSpawn });
    expect(JSON.parse(cap.out()).budget.remainingIterations).toBeNull();
  });
});
