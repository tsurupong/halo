import { describe, it, expect, vi } from 'vitest';
import { formatPhaseState, buildCurrentPath, createPhaseTracker, type LoopPhase } from './phase.js';

describe('formatPhaseState', () => {
  it('builds the current.json document from loop state', () => {
    const doc = formatPhaseState({
      iter: 3,
      taskId: 'issue-42',
      phase: 'execute',
      nowMs: 1_752_500_000_000,
    });
    expect(doc).toEqual({
      iter: 3,
      task_id: 'issue-42',
      phase: 'execute',
      updated_at: new Date(1_752_500_000_000).toISOString(),
    });
  });

  it('serialises a missing task as task_id null (idle between tasks)', () => {
    const doc = formatPhaseState({ iter: 1, taskId: null, phase: 'idle', nowMs: 0 });
    expect(doc.task_id).toBeNull();
    expect(doc.phase).toBe('idle');
  });
});

describe('buildCurrentPath', () => {
  it('joins baseDir and current.json regardless of trailing slash', () => {
    expect(buildCurrentPath('.halo/logs')).toBe('.halo/logs/current.json');
    expect(buildCurrentPath('.halo/logs/')).toBe('.halo/logs/current.json');
  });
});

describe('createPhaseTracker', () => {
  const makeFs = () => ({
    mkdir: vi.fn<(path: string, opts: { recursive: true }) => Promise<unknown>>(
      async () => undefined,
    ),
    writeFile: vi.fn<(path: string, data: string) => Promise<void>>(async () => undefined),
  });

  it('overwrites current.json at every set() call', async () => {
    const fs = makeFs();
    const tracker = createPhaseTracker({ logDir: '.halo/logs', fs, now: () => 1000 });
    await tracker.set(1, 'issue-1', 'next');
    await tracker.set(1, 'issue-1', 'execute');
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
    const [path, data] = fs.writeFile.mock.calls[1] as [string, string];
    expect(path).toBe('.halo/logs/current.json');
    const parsed = JSON.parse(data) as Record<string, unknown>;
    expect(parsed).toEqual({
      iter: 1,
      task_id: 'issue-1',
      phase: 'execute',
      updated_at: new Date(1000).toISOString(),
    });
  });

  it('creates the log directory before writing', async () => {
    const fs = makeFs();
    const tracker = createPhaseTracker({ logDir: '.halo/logs', fs, now: () => 0 });
    await tracker.set(1, null, 'idle');
    expect(fs.mkdir).toHaveBeenCalledWith('.halo/logs', { recursive: true });
  });

  it('swallows fs failures (best-effort — a broken disk must not kill the loop)', async () => {
    const fs = makeFs();
    fs.writeFile.mockRejectedValueOnce(new Error('ENOSPC'));
    const tracker = createPhaseTracker({ logDir: '.halo/logs', fs, now: () => 0 });
    await expect(tracker.set(2, 'issue-2', 'gate')).resolves.toBeUndefined();
  });

  it('accepts every defined loop phase', async () => {
    const fs = makeFs();
    const tracker = createPhaseTracker({ logDir: 'logs', fs, now: () => 0 });
    const phases: LoopPhase[] = [
      'next',
      'preflight_heavy',
      'context',
      'execute',
      'gate',
      'sink',
      'on_fail',
      'idle',
    ];
    for (const p of phases) await tracker.set(1, 't', p);
    expect(fs.writeFile).toHaveBeenCalledTimes(phases.length);
  });
});
