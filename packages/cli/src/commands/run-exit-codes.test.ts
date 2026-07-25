// `halo run` の終了コード写像 (D3 §5.1)。ポーリング運用では「ready 0 件で即終了」が
// 常態なので正当な非実行は exit 0 だが、task-source の故障と重量プリフライト不通過まで
// 0 に丸めると、監視から見て失敗し続ける夜が正常終了と区別できなくなる。
import { describe, expect, test } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { runCommand, loopReasonToExit, type RunHooks } from './run.js';
import { EXIT, CliError } from '../exit-codes.js';
import { memFs, captureStreams } from '../testkit.js';
import type { LoopResult } from '@tsurupong/halo-core';

function hooks(result: LoopResult): RunHooks {
  return {
    preflightLight: async () => ({ proceed: true }),
    preflightHeavy: async () => ({ proceed: true }),
    runLoop: async () => result,
  };
}

function fs() {
  return memFs({ files: { '/repo/.halo/profiles/nightly.env': 'AUTONOMY=L1\nMAX_ITER=5\n' } });
}

async function run(result: LoopResult): Promise<{ code: number; err: string }> {
  const cap = captureStreams();
  const io = createIo(cap.streams, { cwd: '/repo', json: false, quiet: false, verbose: false });
  try {
    const code = await runCommand(parseArgs(['nightly'], {}), io, {
      fs: fs(),
      now: 0,
      hooks: hooks(result),
    });
    return { code, err: cap.err() };
  } catch (err) {
    if (err instanceof CliError) return { code: err.exitCode, err: err.message };
    throw err;
  }
}

describe('loopReasonToExit (D3 §5.1)', () => {
  test('legitimate non-execution maps to exit 0', () => {
    for (const reason of ['STOP', 'NO_TASK', 'MAX_ITER', 'BUDGET_EXCEEDED', 'TIMEOUT'] as const) {
      expect(loopReasonToExit(reason)).toBe(EXIT.OK);
    }
  });

  test('a broken task source and a global environment fault map to exit 1', () => {
    expect(loopReasonToExit('TASK_SOURCE_ERROR')).toBe(EXIT.RUNTIME);
    expect(loopReasonToExit('ABORTED_ENV')).toBe(EXIT.RUNTIME);
  });
});

describe('runCommand end-reason handling', () => {
  test('NO_TASK stays exit 0 (polling fires mostly land here)', async () => {
    const { code } = await run({ endReason: 'NO_TASK', iterations: [] });
    expect(code).toBe(EXIT.OK);
  });

  test('TASK_SOURCE_ERROR surfaces endDetail on the error line and exits 1', async () => {
    const { code, err } = await run({
      endReason: 'TASK_SOURCE_ERROR',
      iterations: [],
      endDetail: 'task-source exited non-pass (exit 2): gh: authentication failed',
    });
    expect(code).toBe(EXIT.RUNTIME);
    expect(err).toContain('TASK_SOURCE_ERROR');
    expect(err).toContain('gh: authentication failed');
  });

  test('ABORTED_ENV exits 1 even without a detail', async () => {
    const { code } = await run({ endReason: 'ABORTED_ENV', iterations: [] });
    expect(code).toBe(EXIT.RUNTIME);
  });
});
