import { expect, test, describe } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { doctorCommand } from './doctor.js';
import { EXIT } from '../exit-codes.js';
import { memFs, captureStreams, type MemFs } from '../testkit.js';
import type { CommandProbe, DoctorProbes } from '../core-ext/doctor.js';
import { buildExecutorSettings, serializeExecutorSettings } from '@tsurupong/halo-core';

function io(cap: ReturnType<typeof captureStreams>, json = false) {
  return createIo(cap.streams, { cwd: '/repo', json, quiet: false, verbose: false });
}

const healthyCommand: CommandProbe = {
  exists: async () => true,
  ghAuth: async () => ({ authenticated: true, overprivileged: false }),
  claudeResponds: async () => true,
  gitStatus: async () => ({ isRepo: true, hasUserName: true, hasUserEmail: true }),
};

function probes(fs: MemFs, command: CommandProbe, over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    haloDir: '/repo/.halo',
    cwd: '/repo',
    fs,
    command,
    triggerCtx: {
      haloDir: '/repo/.halo',
      cwd: '/repo',
      fs,
      spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
    orphanLock: async () => false,
    onExt4: async () => true,
    diskOk: async () => true,
    ...over,
  };
}

function healthyFs(): MemFs {
  return memFs({
    files: {
      '/repo/.harness.yml': 'kinds:\n  code:\n    runtimes: [node-pnpm]\n',
      // ADR-0019 層1 の注入 settings。健全な環境では前回 run が生成済みなので、
      // c13 が OK になる状態を「健全」の定義に含める。
      '/repo/.halo/settings/executor-settings.json':
        serializeExecutorSettings(buildExecutorSettings()),
    },
    dirs: [
      '/repo/.halo/ports/task-source.d',
      '/repo/.halo/ports/context.d',
      '/repo/.halo/ports/executor.d',
      '/repo/.halo/ports/gate.d',
      '/repo/.halo/ports/runtime.d',
      '/repo/.halo/ports/sink.d',
      '/repo/.halo/ports/on-fail.d',
      '/repo/.halo/ports/trigger.d',
      '/repo/.halo/ports/mcp.d',
      '/repo/.halo/profiles',
      '/repo/.halo/logs',
    ],
  });
}

describe('doctor (T28)', () => {
  test('all healthy → exit 0, no FAIL', async () => {
    const cap = captureStreams();
    const code = await doctorCommand(parseArgs([], {}), io(cap, true), {
      fs: healthyFs(),
      probes: probes(healthyFs(), healthyCommand),
    });
    expect(code).toBe(EXIT.OK);
    const out = JSON.parse(cap.out());
    expect(out.summary.fail).toBe(0);
    expect(out.checks).toHaveLength(11);
  });

  test('injected deny settings missing a D4 §2.2 rule → FAIL (ADR-0019 drift)', async () => {
    // 旧実装が書いていた「自己改変の Write だけ」の settings を再現する。秘匿読取と
    // 破壊的コマンドの deny が欠けている状態を doctor が見逃さないことが要点。
    const stale = healthyFs();
    stale.files.set(
      '/repo/.halo/settings/executor-settings.json',
      JSON.stringify({ permissions: { deny: ['Write(**/CLAUDE.md)'] } }),
    );
    const cap = captureStreams();
    const code = await doctorCommand(parseArgs([], {}), io(cap, true), {
      fs: stale,
      probes: probes(stale, healthyCommand),
    });
    expect(code).toBe(EXIT.RUNTIME);
    const c13 = JSON.parse(cap.out()).checks.find((c: { id: number }) => c.id === 13);
    expect(c13.status).toBe('FAIL');
    expect(c13.detail).toContain('Read(**/.env)');
  });

  test('injected deny settings not yet generated → WARN, not FAIL', async () => {
    const fresh = healthyFs();
    fresh.files.delete('/repo/.halo/settings/executor-settings.json');
    const cap = captureStreams();
    const code = await doctorCommand(parseArgs([], {}), io(cap, true), {
      fs: fresh,
      probes: probes(fresh, healthyCommand),
    });
    expect(code).toBe(EXIT.OK);
    const c13 = JSON.parse(cap.out()).checks.find((c: { id: number }) => c.id === 13);
    expect(c13.status).toBe('WARN');
  });

  test('missing gh binary → FAIL → exit 1', async () => {
    const command: CommandProbe = { ...healthyCommand, exists: async (b) => b !== 'gh' };
    const cap = captureStreams();
    const code = await doctorCommand(parseArgs([], {}), io(cap, true), {
      fs: healthyFs(),
      probes: probes(healthyFs(), command),
    });
    expect(code).toBe(EXIT.RUNTIME);
    const out = JSON.parse(cap.out());
    expect(out.summary.fail).toBeGreaterThanOrEqual(1);
  });

  test('orphan lock produces a WARN but still exit 0', async () => {
    const cap = captureStreams();
    const code = await doctorCommand(parseArgs([], {}), io(cap, true), {
      fs: healthyFs(),
      probes: probes(healthyFs(), healthyCommand, { orphanLock: async () => true }),
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(cap.out()).summary.warn).toBeGreaterThanOrEqual(1);
  });

  test('missing skeleton dir → FAIL', async () => {
    const bare = memFs({ files: { '/repo/.harness.yml': 'kinds:\n' } });
    const cap = captureStreams();
    const code = await doctorCommand(parseArgs([], {}), io(cap, true), {
      fs: bare,
      probes: probes(bare, healthyCommand),
    });
    expect(code).toBe(EXIT.RUNTIME);
    const skeleton = JSON.parse(cap.out()).checks.find((c: { id: number }) => c.id === 2);
    expect(skeleton.status).toBe('FAIL');
  });

  test('--fix repairs missing skeleton before re-checking', async () => {
    const bare = memFs({ files: { '/repo/.harness.yml': 'kinds:\n' } });
    const cap = captureStreams();
    // fix writes skeleton into the same fs the probes read.
    await doctorCommand(parseArgs(['--fix'], {}), io(cap, true), {
      fs: bare,
      probes: probes(bare, healthyCommand),
    });
    expect(bare.dirs.has('/repo/.halo/ports/trigger.d')).toBe(true);
  });
});
