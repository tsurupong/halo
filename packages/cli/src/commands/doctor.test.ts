import { expect, test, describe } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { doctorCommand } from './doctor.js';
import { EXIT } from '../exit-codes.js';
import { memFs, captureStreams, type MemFs } from '../testkit.js';
import type { CommandProbe, DoctorProbes } from '../core-ext/doctor.js';

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
    files: { '/repo/.harness.yml': 'kinds:\n  code:\n    runtimes: [node-pnpm]\n' },
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
    expect(out.checks).toHaveLength(9);
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
