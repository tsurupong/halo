import { expect, test, describe, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { runCommand, type RunHooks, type RunContext } from './run.js';
import { EXIT } from '../exit-codes.js';
import { memFs, captureStreams } from '../testkit.js';

function io(cap: ReturnType<typeof captureStreams>) {
  return createIo(cap.streams, { cwd: '/repo', json: false, quiet: false, verbose: false });
}

const RUN_FLAGS = {
  valueFlags: ['max-iter', 'autonomy', 'timeout', 'daily-budget', 'profiles-dir'],
};

function proceedingHooks(over: Partial<RunHooks> = {}): RunHooks {
  return {
    preflightLight: async () => ({ proceed: true }),
    preflightHeavy: async () => ({ proceed: true }),
    runLoop: async () => ({ endReason: 'MAX_ITER', iterations: [] }),
    ...over,
  };
}

function fsWithProfile(body = 'AUTONOMY=L1\nMAX_ITER=20\nTIMEOUT=3h\n') {
  return memFs({ files: { '/repo/.halo/profiles/nightly.env': body } });
}

describe('run <profile> (T23)', () => {
  test('resolves profile + flag overrides and passes final config to core (mocked)', async () => {
    const fs = fsWithProfile();
    const cap = captureStreams();
    const runLoop = vi.fn<(ctx: RunContext) => Promise<{ endReason: 'MAX_ITER'; iterations: [] }>>(
      async () => ({
        endReason: 'MAX_ITER',
        iterations: [],
      }),
    );
    const code = await runCommand(parseArgs(['nightly', '--max-iter', '5'], RUN_FLAGS), io(cap), {
      fs,
      now: 0,
      hooks: proceedingHooks({ runLoop }),
    });
    expect(code).toBe(EXIT.OK);
    const ctx = runLoop.mock.calls[0]![0];
    expect(ctx.config.maxIter).toBe(5); // CLI flag overrides profile MAX_ITER=20
    expect(ctx.config.profileName).toBe('nightly');
  });

  test('--dry-run forces max-iter to 1', async () => {
    const fs = fsWithProfile();
    const cap = captureStreams();
    let seen = -1;
    const hooks = proceedingHooks({
      runLoop: async (ctx) => {
        seen = ctx.config.maxIter;
        return { endReason: 'MAX_ITER', iterations: [] };
      },
    });
    await runCommand(parseArgs(['nightly', '--dry-run'], RUN_FLAGS), io(cap), {
      fs,
      now: 0,
      hooks,
    });
    expect(seen).toBe(1);
  });

  test('preflight light stop → exit 0 (正当な即終了) and never runs loop', async () => {
    const fs = fsWithProfile();
    const cap = captureStreams();
    const runLoop = vi.fn();
    const code = await runCommand(parseArgs(['nightly'], RUN_FLAGS), io(cap), {
      fs,
      now: 0,
      hooks: proceedingHooks({
        preflightLight: async () => ({ proceed: false, reason: 'STOP' }),
        runLoop,
      }),
    });
    expect(code).toBe(EXIT.OK);
    expect(runLoop).not.toHaveBeenCalled();
  });

  test('heavy preflight failure → exit 1', async () => {
    const fs = fsWithProfile();
    const cap = captureStreams();
    await expect(
      runCommand(parseArgs(['nightly'], RUN_FLAGS), io(cap), {
        fs,
        now: 0,
        hooks: proceedingHooks({
          preflightHeavy: async () => ({ proceed: false, reason: 'DIRTY_WORKTREE' }),
        }),
      }),
    ).rejects.toMatchObject({ exitCode: EXIT.RUNTIME });
  });

  test('unknown profile → exit 3', async () => {
    const fs = memFs();
    const cap = captureStreams();
    await expect(
      runCommand(parseArgs(['ghost'], RUN_FLAGS), io(cap), {
        fs,
        now: 0,
        hooks: proceedingHooks(),
      }),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });

  test('--autonomy L3 on an L1 profile warns but proceeds', async () => {
    const fs = fsWithProfile();
    const cap = captureStreams();
    const code = await runCommand(parseArgs(['nightly', '--autonomy', 'L3'], RUN_FLAGS), io(cap), {
      fs,
      now: 0,
      hooks: proceedingHooks(),
    });
    expect(code).toBe(EXIT.OK);
    expect(cap.err()).toContain('--autonomy L3');
  });

  test('invalid config value (bad autonomy) → exit 3', async () => {
    const fs = fsWithProfile();
    const cap = captureStreams();
    await expect(
      runCommand(parseArgs(['nightly', '--autonomy', 'L9'], RUN_FLAGS), io(cap), {
        fs,
        now: 0,
        hooks: proceedingHooks(),
      }),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });
});

describe('run — .harness.yml autonomy ceiling (ADR-0004)', () => {
  const captured = () =>
    vi.fn<(ctx: RunContext) => Promise<{ endReason: 'MAX_ITER'; iterations: [] }>>(async () => ({
      endReason: 'MAX_ITER',
      iterations: [],
    }));

  test('caps a --autonomy override at the declared maxAutonomy and warns', async () => {
    const cap = captureStreams();
    const runLoop = captured();
    const code = await runCommand(parseArgs(['nightly', '--autonomy', 'L3'], RUN_FLAGS), io(cap), {
      fs: fsWithProfile(),
      now: 0,
      hooks: proceedingHooks({ runLoop }),
      loadHarness: async () => ({
        path: '/repo/.harness.yml',
        harness: { kinds: { code: { runtimes: ['n'], prompt: 'p.md' } }, maxAutonomy: 'L2' },
      }),
    });
    expect(code).toBe(EXIT.OK);
    expect(runLoop.mock.calls[0]![0].config.autonomy).toBe('L2');
    expect(cap.err()).toMatch(/caps autonomy at L2/);
  });

  test('leaves autonomy untouched when the repository declares no ceiling', async () => {
    const cap = captureStreams();
    const runLoop = captured();
    await runCommand(parseArgs(['nightly', '--autonomy', 'L3'], RUN_FLAGS), io(cap), {
      fs: fsWithProfile(),
      now: 0,
      hooks: proceedingHooks({ runLoop }),
      loadHarness: async () => ({
        path: '/repo/.harness.yml',
        harness: { kinds: { code: { runtimes: ['n'], prompt: 'p.md' } } },
      }),
    });
    expect(runLoop.mock.calls[0]![0].config.autonomy).toBe('L3');
    expect(cap.err()).not.toMatch(/caps autonomy/);
  });

  test('refuses to start when the declaration cannot be read', async () => {
    const cap = captureStreams();
    const { ConfigError } = await import('@tsurupong/halo-core');
    await expect(
      runCommand(parseArgs(['nightly'], RUN_FLAGS), io(cap), {
        fs: fsWithProfile(),
        now: 0,
        hooks: proceedingHooks(),
        loadHarness: () => Promise.reject(new ConfigError('.harness.yml:2: broken')),
      }),
    ).rejects.toThrow(/broken/);
  });
});
