// `halo watchdog` (D9 §2.3-§2.5) の新規テスト。fs / kill / 生存確認 / clock を全注入。
import { describe, expect, test, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { EXIT } from '../exit-codes.js';
import { memFs, captureStreams } from '../testkit.js';
import { watchdogCommand, type WatchdogDeps } from './watchdog.js';

const NOW = Date.parse('2026-07-16T12:00:00Z');
const LOCK = JSON.stringify({ pid: 4242, startedAt: '2026-07-16T10:00:00Z', host: 'wsl' });

function currentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    iter: 3,
    task_id: 'T-9',
    phase: 'gate',
    // 既定 WATCHDOG_TIMEOUT_SEC=1800 を大きく超えた 2 時間前。
    updated_at: '2026-07-16T10:00:00Z',
    ...overrides,
  });
}

function makeDeps(overrides: Partial<WatchdogDeps> & { fs: WatchdogDeps['fs'] }): WatchdogDeps {
  return {
    now: NOW,
    env: {},
    tmpdir: '/tmp',
    host: 'wsl',
    isProcessAlive: vi.fn(() => true),
    kill: vi.fn(),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

function io(cap: ReturnType<typeof captureStreams>) {
  return createIo(cap.streams, { cwd: '/repo', json: false, quiet: false, verbose: false });
}

async function run(deps: WatchdogDeps, argv: string[] = []) {
  const cap = captureStreams();
  const code = await watchdogCommand(
    parseArgs(argv, { valueFlags: ['action', 'profile'] }),
    io(cap),
    deps,
  );
  return { code, cap };
}

describe('watchdog command (D9 §2)', () => {
  test('no lock file -> exit 0, no side effects', async () => {
    const deps = makeDeps({ fs: memFs() });
    const { code } = await run(deps, ['--action', 'kill']);
    expect(code).toBe(EXIT.OK);
    expect(deps.kill).not.toHaveBeenCalled();
  });

  test('dead lock owner -> exit 0, nothing killed', async () => {
    const fs = memFs({
      files: { '/tmp/halo.lock': LOCK, '/repo/.halo/logs/current.json': currentJson() },
    });
    const deps = makeDeps({ fs, isProcessAlive: vi.fn(() => false) });
    const { code } = await run(deps, ['--action', 'kill']);
    expect(code).toBe(EXIT.OK);
    expect(deps.kill).not.toHaveBeenCalled();
    expect(fs.files.has('/repo/.halo/logs/watchdog.jsonl')).toBe(false);
  });

  test('lock from another host -> hands off (exit 0)', async () => {
    const fs = memFs({
      files: { '/tmp/halo.lock': LOCK, '/repo/.halo/logs/current.json': currentJson() },
    });
    const deps = makeDeps({ fs, host: 'other-host' });
    const { code } = await run(deps, ['--action', 'kill']);
    expect(code).toBe(EXIT.OK);
    expect(deps.kill).not.toHaveBeenCalled();
  });

  test('missing / broken current.json -> exit 0 (prefer missing a hang)', async () => {
    const noFile = makeDeps({ fs: memFs({ files: { '/tmp/halo.lock': LOCK } }) });
    expect((await run(noFile, ['--action', 'kill'])).code).toBe(EXIT.OK);
    expect(noFile.kill).not.toHaveBeenCalled();

    const broken = makeDeps({
      fs: memFs({
        files: { '/tmp/halo.lock': LOCK, '/repo/.halo/logs/current.json': '{oops' },
      }),
    });
    expect((await run(broken, ['--action', 'kill'])).code).toBe(EXIT.OK);
    expect(broken.kill).not.toHaveBeenCalled();
  });

  test('fresh phase (not stale) -> exit 0', async () => {
    const fs = memFs({
      files: {
        '/tmp/halo.lock': LOCK,
        '/repo/.halo/logs/current.json': currentJson({ updated_at: '2026-07-16T11:55:00Z' }),
      },
    });
    const deps = makeDeps({ fs });
    const { code } = await run(deps, ['--action', 'kill']);
    expect(code).toBe(EXIT.OK);
    expect(deps.kill).not.toHaveBeenCalled();
  });

  test('stale + live pid + --action kill -> SIGTERM then SIGKILL on the group', async () => {
    const fs = memFs({
      files: { '/tmp/halo.lock': LOCK, '/repo/.halo/logs/current.json': currentJson() },
    });
    const deps = makeDeps({ fs });
    const { code } = await run(deps, ['--action', 'kill']);
    expect(code).toBe(EXIT.OK);
    expect(deps.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(deps.kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(deps.sleep).toHaveBeenCalledWith(10_000);
  });

  test('default report action logs but never kills', async () => {
    const fs = memFs({
      files: { '/tmp/halo.lock': LOCK, '/repo/.halo/logs/current.json': currentJson() },
    });
    const deps = makeDeps({ fs });
    const { code, cap } = await run(deps);
    expect(code).toBe(EXIT.OK);
    expect(deps.kill).not.toHaveBeenCalled();
    expect(cap.out()).toContain('stale loop detected');
    expect(fs.files.get('/repo/.halo/logs/watchdog.jsonl')).toContain('"action":"report"');
  });

  test('--action skip kills and moves the queued task to quarantine', async () => {
    const fs = memFs({
      files: {
        '/tmp/halo.lock': LOCK,
        '/repo/.halo/logs/current.json': currentJson(),
        '/repo/.halo/tasks/queue/T-9.md': '# task body',
      },
    });
    const deps = makeDeps({ fs });
    await run(deps, ['--action', 'skip']);
    expect(deps.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(fs.files.has('/repo/.halo/tasks/queue/T-9.md')).toBe(false);
    expect(fs.files.get('/repo/.halo/tasks/quarantine/T-9.md')).toBe('# task body');
  });

  test('appends a structured record to watchdog.jsonl', async () => {
    const fs = memFs({
      files: {
        '/tmp/halo.lock': LOCK,
        '/repo/.halo/logs/current.json': currentJson(),
        '/repo/.halo/logs/watchdog.jsonl': '{"ts":"earlier"}\n',
      },
    });
    const deps = makeDeps({ fs, env: { WATCHDOG_TIMEOUT_SEC: '600' } });
    await run(deps, ['--action', 'kill']);
    const lines = fs.files.get('/repo/.halo/logs/watchdog.jsonl')!.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual({
      ts: '2026-07-16T12:00:00.000Z',
      action: 'kill',
      pid: 4242,
      task_id: 'T-9',
      phase: 'gate',
      age_sec: 7200,
      limit_sec: 600,
    });
  });
});
