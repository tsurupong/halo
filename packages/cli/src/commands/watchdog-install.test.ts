// `halo watchdog install/uninstall` と heartbeat (ADR-0023, D9 §2.6-§2.7)。
// 既存 watchdog.test.ts には触れず追加分をここに置く (gate-loop-audit の既存テスト保護)。
// スケジューラは実 schtasks/systemd/cron を叩くのでシームを必ず差し替える。
import { describe, expect, test, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { EXIT, CliError } from '../exit-codes.js';
import { memFs, captureStreams } from '../testkit.js';
import {
  watchdogCommand,
  watchdogSchedulerKey,
  parseEveryMinutes,
  WATCHDOG_TRIGGER,
  type WatchdogDeps,
  type SchedulerSeam,
} from './watchdog.js';

const NOW = Date.parse('2026-07-28T12:00:00Z');
const LOCK = JSON.stringify({ pid: 4242, startedAt: '2026-07-28T10:00:00Z', host: 'wsl' });

function currentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    iter: 3,
    task_id: 'T-9',
    phase: 'gate',
    updated_at: '2026-07-28T10:00:00Z',
    ...overrides,
  });
}

function fakeScheduler() {
  const installed: Array<{
    trigger: string;
    profile: string;
    spec: string;
    fireArgv: readonly string[];
  }> = [];
  const uninstalled: Array<{ trigger: string; profile: string }> = [];
  const seam: SchedulerSeam = {
    install: (trigger, profile, spec, fireArgv) =>
      void installed.push({ trigger, profile, spec, fireArgv }),
    uninstall: (trigger, profile) => void uninstalled.push({ trigger, profile }),
  };
  return { seam, installed, uninstalled };
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
    cliArgv: ['/usr/bin/node', '/opt/halo/dist/index.js'],
    ...overrides,
  };
}

async function run(deps: WatchdogDeps, argv: string[]) {
  const cap = captureStreams();
  const io = createIo(cap.streams, { cwd: '/repo', json: false, quiet: false, verbose: false });
  try {
    const code = await watchdogCommand(
      parseArgs(argv, { valueFlags: ['action', 'profile', 'every'] }),
      io,
      deps,
    );
    return { code, cap, error: undefined as CliError | undefined };
  } catch (err) {
    if (err instanceof CliError) return { code: err.exitCode, cap, error: err };
    throw err;
  }
}

describe('parseEveryMinutes', () => {
  test('accepts <N>m and bare <N>, defaults to 5', () => {
    expect(parseEveryMinutes(undefined)).toBe(5);
    expect(parseEveryMinutes('15m')).toBe(15);
    expect(parseEveryMinutes('30')).toBe(30);
  });

  test('rejects out-of-range and garbage', () => {
    for (const bad of ['0', '0m', '1441', 'abc', '5h', '-1']) {
      expect(() => parseEveryMinutes(bad)).toThrow(CliError);
    }
  });
});

describe('watchdogSchedulerKey', () => {
  test('suffixes the profile so schtasks does not collide with the run trigger', () => {
    // schtasks はタスク名を HALO_<profile> と profile だけで決め、install 時に同名を
    // 消すので、素の profile で登録すると run トリガーが消える (ADR-0023)。
    expect(watchdogSchedulerKey('nightly')).toBe('nightly-watchdog');
    expect(watchdogSchedulerKey(undefined)).toBe('default-watchdog');
  });
});

describe('watchdog install (ADR-0023, D9 §2.6)', () => {
  test('refuses to register without an explicit --action', async () => {
    const sched = fakeScheduler();
    const deps = makeDeps({ fs: memFs(), scheduler: sched.seam });
    const { code, error } = await run(deps, ['install', '--profile', 'nightly']);
    expect(code).toBe(EXIT.USAGE);
    expect(error?.message).toContain('missing --action');
    // 「存在するが何もしない監督」を再生産しないため、登録は一切行わない。
    expect(sched.installed).toEqual([]);
  });

  test('registers under the suffixed key but passes the real profile in the command', async () => {
    const sched = fakeScheduler();
    const fs = memFs();
    const deps = makeDeps({ fs, scheduler: sched.seam });
    const { code } = await run(deps, [
      'install',
      '--action',
      'kill',
      '--profile',
      'nightly',
      '--every',
      '10m',
    ]);
    expect(code).toBe(EXIT.OK);
    expect(sched.installed).toHaveLength(1);
    const entry = sched.installed[0]!;
    expect(entry.trigger).toBe(WATCHDOG_TRIGGER);
    expect(entry.profile).toBe('nightly-watchdog');
    expect(entry.spec).toBe('interval:10');
    // 登録コマンドが持つ --profile は接尾辞なしの実 profile: lock パス解決に使われる。
    expect(entry.fireArgv).toEqual([
      '/usr/bin/node',
      '/opt/halo/dist/index.js',
      'watchdog',
      '--action',
      'kill',
      '--cwd',
      '/repo',
      '--profile',
      'nightly',
    ]);
  });

  test('writes the schedule marker doctor c14 reads for the interval', async () => {
    const sched = fakeScheduler();
    const fs = memFs();
    const deps = makeDeps({ fs, scheduler: sched.seam });
    await run(deps, ['install', '--action', 'report', '--profile', 'nightly', '--every', '15m']);
    const marker = JSON.parse(fs.files.get('/repo/.halo/logs/watchdog-schedule.json')!) as Record<
      string,
      unknown
    >;
    expect(marker).toEqual({
      every_minutes: 15,
      action: 'report',
      profile: 'nightly',
      installed_at: '2026-07-28T12:00:00.000Z',
    });
  });

  test('warns that report-mode registration does not recover anything', async () => {
    const sched = fakeScheduler();
    const deps = makeDeps({ fs: memFs(), scheduler: sched.seam });
    const { cap } = await run(deps, ['install', '--action', 'report']);
    expect(cap.err()).toContain('回収しません');
  });

  test('a scheduler backend failure surfaces as exit 1, not a silent success', async () => {
    const seam: SchedulerSeam = {
      install: () => {
        throw new Error('scheduler: no backend available');
      },
      uninstall: () => undefined,
    };
    const deps = makeDeps({ fs: memFs(), scheduler: seam });
    const { code, error } = await run(deps, ['install', '--action', 'kill']);
    expect(code).toBe(EXIT.RUNTIME);
    expect(error?.message).toContain('no backend available');
  });

  test('uninstall targets the same suffixed key', async () => {
    const sched = fakeScheduler();
    const deps = makeDeps({ fs: memFs(), scheduler: sched.seam });
    const { code } = await run(deps, ['uninstall', '--profile', 'nightly']);
    expect(code).toBe(EXIT.OK);
    expect(sched.uninstalled).toEqual([{ trigger: 'watchdog', profile: 'nightly-watchdog' }]);
  });
});

describe('watchdog subcommand dispatch', () => {
  test('ignores the profile key schedulerInstall appends to the registered command', async () => {
    // scheduler.ts:123 は cmd 末尾へ profile キーを 1 つ足す。登録された watchdog は
    // それを位置引数として受け取るので、検知パスがそこで落ちてはならない。
    const fs = memFs({ files: { '/tmp/halo-nightly.lock': LOCK } });
    const deps = makeDeps({ fs });
    const { code } = await run(deps, ['nightly-watchdog', '--profile', 'nightly']);
    expect(code).toBe(EXIT.OK);
  });

  test('a typo in the subcommand is a usage error, not a silent detection pass', async () => {
    const deps = makeDeps({ fs: memFs() });
    const { code, error } = await run(deps, ['instal', '--action', 'kill']);
    expect(code).toBe(EXIT.USAGE);
    expect(error?.message).toContain('unknown watchdog subcommand');
  });
});

describe('watchdog heartbeat (D9 §2.7)', () => {
  const heartbeat = (fs: ReturnType<typeof memFs>) =>
    JSON.parse(fs.files.get('/repo/.halo/logs/watchdog-last.json')!) as Record<string, unknown>;

  test('written even when there is nothing to supervise (no lock)', async () => {
    // 「未登録」と「登録済みで異常なし」を区別できる唯一の材料なので、
    // 監督対象が無い回でも必ず残す。
    const fs = memFs();
    await run(makeDeps({ fs }), ['--action', 'kill']);
    expect(heartbeat(fs)).toEqual({
      ts: '2026-07-28T12:00:00.000Z',
      stale: false,
      phase: null,
      age_sec: null,
      limit_sec: null,
      action: 'kill',
      acted: false,
    });
  });

  test('written when the lock owner is dead', async () => {
    const fs = memFs({ files: { '/tmp/halo.lock': LOCK } });
    await run(makeDeps({ fs, isProcessAlive: vi.fn(() => false) }), []);
    expect(heartbeat(fs).stale).toBe(false);
    // watchdog.jsonl は検知時のみ: 正常時に肥大化させない。
    expect(fs.files.has('/repo/.halo/logs/watchdog.jsonl')).toBe(false);
  });

  test('carries the verdict numbers when the phase is fresh', async () => {
    const fs = memFs({
      files: {
        '/tmp/halo.lock': LOCK,
        '/repo/.halo/logs/current.json': currentJson({ updated_at: '2026-07-28T11:55:00Z' }),
      },
    });
    await run(makeDeps({ fs }), []);
    expect(heartbeat(fs)).toMatchObject({
      stale: false,
      phase: 'gate',
      age_sec: 300,
      limit_sec: 1800,
      acted: false,
    });
  });

  test('records acted=false for report and acted=true for kill on a stale run', async () => {
    const seed = () => ({
      '/tmp/halo.lock': LOCK,
      '/repo/.halo/logs/current.json': currentJson(),
    });
    const reportFs = memFs({ files: seed() });
    await run(makeDeps({ fs: reportFs }), ['--action', 'report']);
    expect(heartbeat(reportFs)).toMatchObject({ stale: true, action: 'report', acted: false });

    const killFs = memFs({ files: seed() });
    await run(makeDeps({ fs: killFs }), ['--action', 'kill']);
    expect(heartbeat(killFs)).toMatchObject({ stale: true, action: 'kill', acted: true });
  });
});
