// `halo run` の協調シャットダウン (ADR-0022, D3 §2.1, D9 §5)。シグナルハンドラは
// シームで注入する — テストランナー自身へ SIGTERM を送らずに「2 回目で即時終了」まで
// 検証するため。1 回目で AbortSignal が loop へ届くこと、run 終了時にリスナーが必ず
// 解除されること、ABORTED_SIGNAL が exit 0 に写ることを見る。
import { describe, expect, test } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import {
  runCommand,
  loopReasonToExit,
  signalExitCode,
  type RunHooks,
  type RunContext,
  type SignalSeam,
} from './run.js';
import { EXIT, CliError } from '../exit-codes.js';
import { memFs, captureStreams } from '../testkit.js';
import type { LoopResult } from '@tsurupong/halo-core';

function fs() {
  return memFs({ files: { '/repo/.halo/profiles/nightly.env': 'AUTONOMY=L1\nMAX_ITER=5\n' } });
}

/** 記録付きシグナルシーム。`fire` でハンドラを任意回数叩ける。 */
function fakeSignals() {
  let handler: ((signal: NodeJS.Signals) => void) | undefined;
  const exits: number[] = [];
  let disposed = 0;
  const seam: SignalSeam = {
    on(h) {
      handler = h;
      return () => {
        disposed += 1;
        handler = undefined;
      };
    },
    exit(code) {
      exits.push(code);
    },
  };
  return {
    seam,
    exits,
    fire: (sig: NodeJS.Signals = 'SIGTERM') => handler?.(sig),
    get installed() {
      return handler !== undefined;
    },
    get disposed() {
      return disposed;
    },
  };
}

async function runWith(
  hooks: RunHooks,
  signals: SignalSeam,
): Promise<{ code: number; err: string }> {
  const cap = captureStreams();
  const io = createIo(cap.streams, { cwd: '/repo', json: false, quiet: false, verbose: false });
  try {
    const code = await runCommand(parseArgs(['nightly'], {}), io, {
      fs: fs(),
      now: 0,
      hooks,
      signals,
    });
    return { code, err: cap.err() };
  } catch (err) {
    if (err instanceof CliError) return { code: err.exitCode, err: cap.err() + err.message };
    throw err;
  }
}

describe('signalExitCode (POSIX 128+signum)', () => {
  test('SIGINT is 130 and SIGTERM is 143', () => {
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
  });
});

describe('loopReasonToExit', () => {
  test('ABORTED_SIGNAL is a legitimate stop, not an anomaly (D9 §5.4)', () => {
    // systemctl stop がユニット失敗として記録されないことがこの写像の目的。
    expect(loopReasonToExit('ABORTED_SIGNAL')).toBe(EXIT.OK);
  });
});

describe('runCommand signal handling', () => {
  test('the first signal aborts the AbortSignal handed to the loop', async () => {
    const signals = fakeSignals();
    let seen: AbortSignal | undefined;
    const hooks: RunHooks = {
      preflightLight: async () => ({ proceed: true }),
      preflightHeavy: async () => ({ proceed: true }),
      runLoop: async (ctx: RunContext) => {
        seen = ctx.abort;
        expect(seen?.aborted).toBe(false);
        signals.fire('SIGTERM');
        expect(seen?.aborted).toBe(true);
        return { endReason: 'ABORTED_SIGNAL', iterations: [] } satisfies LoopResult;
      },
    };
    const { code, err } = await runWith(hooks, signals.seam);
    expect(code).toBe(EXIT.OK);
    expect(err).toContain('SIGTERM');
    // 1 回目は即時終了しない — 後片付けは通常の巻き戻し経路に任せる。
    expect(signals.exits).toEqual([]);
  });

  test('the second signal exits immediately with 128+signum', async () => {
    const signals = fakeSignals();
    const hooks: RunHooks = {
      preflightLight: async () => ({ proceed: true }),
      preflightHeavy: async () => ({ proceed: true }),
      runLoop: async () => {
        signals.fire('SIGINT');
        signals.fire('SIGINT');
        return { endReason: 'ABORTED_SIGNAL', iterations: [] } satisfies LoopResult;
      },
    };
    await runWith(hooks, signals.seam);
    expect(signals.exits).toEqual([130]);
  });

  test('handlers are removed when the run ends normally', async () => {
    const signals = fakeSignals();
    const hooks: RunHooks = {
      preflightLight: async () => ({ proceed: true }),
      preflightHeavy: async () => ({ proceed: true }),
      runLoop: async () => ({ endReason: 'NO_TASK', iterations: [] }),
    };
    await runWith(hooks, signals.seam);
    expect(signals.disposed).toBe(1);
    expect(signals.installed).toBe(false);
  });

  test('handlers are removed even when preflight throws', async () => {
    const signals = fakeSignals();
    const hooks: RunHooks = {
      preflightLight: async () => ({ proceed: true }),
      preflightHeavy: async () => ({ proceed: false, reason: 'DIRTY_WORKTREE' }),
      runLoop: async () => ({ endReason: 'NO_TASK', iterations: [] }),
    };
    const { code } = await runWith(hooks, signals.seam);
    expect(code).toBe(EXIT.RUNTIME);
    expect(signals.disposed).toBe(1);
  });

  test('handlers are removed when preflight light declines (exit 0 path)', async () => {
    const signals = fakeSignals();
    const hooks: RunHooks = {
      preflightLight: async () => ({ proceed: false, reason: 'STOP' }),
      preflightHeavy: async () => ({ proceed: true }),
      runLoop: async () => ({ endReason: 'NO_TASK', iterations: [] }),
    };
    const { code } = await runWith(hooks, signals.seam);
    expect(code).toBe(EXIT.OK);
    expect(signals.disposed).toBe(1);
  });

  test('without a signals seam the run still works (handlers are optional)', async () => {
    const cap = captureStreams();
    const io = createIo(cap.streams, { cwd: '/repo', json: false, quiet: false, verbose: false });
    const code = await runCommand(parseArgs(['nightly'], {}), io, {
      fs: fs(),
      now: 0,
      hooks: {
        preflightLight: async () => ({ proceed: true }),
        preflightHeavy: async () => ({ proceed: true }),
        runLoop: async (ctx: RunContext) => {
          // シームが無くても abort は渡る (発火させる者が居ないだけ)。
          expect(ctx.abort?.aborted).toBe(false);
          return { endReason: 'NO_TASK', iterations: [] };
        },
      },
    });
    expect(code).toBe(EXIT.OK);
  });
});
