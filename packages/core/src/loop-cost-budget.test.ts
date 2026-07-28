// ADR-0021 決定(2): core が executor.out.cost を launch 単位で累積し、上限到達を
// PreflightLight 段の「正当な非実行」として扱う。`max_budget_usd` は契約上任意
// フィールドなので、ランタイムがそれを無視しても止まるのはここだけ。
// 既存 loop.test.ts は変更せず、同様式の最小ハーネスをここに持つ。
import { describe, expect, it } from 'vitest';
import type { DiscoveredPlugin } from './discovery.js';
import type { RunPortResult } from './runPort.js';
import type { Logger } from './logger.js';
import { runLoop, type LoopDeps, type LoopPorts, type PortRunner } from './loop.js';

function jsonRes(value: unknown): RunPortResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify(value),
    stderr: '',
    timedOut: false,
    aborted: false,
    durationMs: 1,
  };
}

function plug(port: DiscoveredPlugin['port'], name: string): DiscoveredPlugin {
  return {
    port,
    name,
    dirName: name,
    dir: `/x/${name}`,
    entryPath: `/x/${name}/run`,
    order: 0,
    manifest: { name, version: '1.0.0', port, entry: 'run' },
  };
}

/** 毎イテレーション同じコストを報告し続ける executor。task は尽きない。 */
function makeDeps(opts: {
  maxBudgetUsd?: number;
  cost?: Record<string, unknown>;
  maxIter?: number;
}) {
  const execIns: unknown[] = [];
  const ports: LoopPorts = {
    taskSource: [plug('task-source', 'ts')],
    context: [],
    executor: [plug('executor', 'ex')],
    gate: [],
    sink: [],
    onFail: [],
  };
  let served = 0;
  const runner: PortRunner = async (plugin, stdin) => {
    if (plugin.name === 'ts') {
      const op = (stdin as { op?: string }).op;
      if (op === 'next') {
        served += 1;
        return jsonRes({ task_id: `T-${served}`, title: 't', body: 'b', kind: 'code' });
      }
      return jsonRes({});
    }
    execIns.push(stdin);
    return jsonRes({
      status: 'done',
      summary: 'ok',
      ...(opts.cost !== undefined ? { cost: opts.cost } : {}),
    });
  };
  const logger: Logger = {
    writeIteration: async (input) => ({ path: `iter_${input.iter}.json`, log: {} as never }),
  };
  let clock = 1_000;
  const deps: LoopDeps = {
    config: {
      autonomy: 'L1',
      maxIter: opts.maxIter ?? 10,
      timeoutSec: 3600,
      profileName: 'test',
      ...(opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.maxBudgetUsd } : {}),
    },
    ports,
    runner,
    logger,
    now: () => (clock += 1),
    isStopPresent: () => false,
    isBudgetOk: () => true,
    createWorktree: (task) => `/wt/${String(task.task_id)}`,
    removeWorktree: () => undefined,
  };
  return { deps, execIns };
}

describe('per-launch USD ceiling (ADR-0021)', () => {
  it('passes max_budget_usd through to executor.in.budget', async () => {
    const { deps, execIns } = makeDeps({ maxBudgetUsd: 5, cost: { usd_estimate: 10 } });
    await runLoop(deps);
    const budget = (execIns[0] as { budget: Record<string, unknown> }).budget;
    expect(budget['max_budget_usd']).toBe(5);
  });

  it('stops the launch once the accumulated cost reaches the ceiling', async () => {
    // 1 回 2.0 USD / 上限 5.0 → 3 回走った時点で 6.0 に達し、4 周目の頭で止まる。
    const { deps, execIns } = makeDeps({ maxBudgetUsd: 5, cost: { usd_estimate: 2 } });
    const result = await runLoop(deps);
    expect(result.endReason).toBe('BUDGET_EXCEEDED');
    expect(execIns).toHaveLength(3);
    expect(result.endDetail).toContain('max_budget_usd');
  });

  it('also accepts the `usd` spelling of the cost field (D1 §1.3 example)', async () => {
    const { deps, execIns } = makeDeps({ maxBudgetUsd: 1, cost: { usd: 0.6 } });
    const result = await runLoop(deps);
    expect(result.endReason).toBe('BUDGET_EXCEEDED');
    expect(execIns).toHaveLength(2);
  });

  it('runs to MAX_ITER when no ceiling is configured', async () => {
    const { deps } = makeDeps({ cost: { usd_estimate: 100 }, maxIter: 3 });
    const result = await runLoop(deps);
    expect(result.endReason).toBe('MAX_ITER');
  });

  it('degrades to count budgets when the executor reports no cost', async () => {
    // ADR-0021 の Negative: cost を出さない executor は回数/時間の予算のみになる。
    const { deps } = makeDeps({ maxBudgetUsd: 1, maxIter: 3 });
    const result = await runLoop(deps);
    expect(result.endReason).toBe('MAX_ITER');
  });
});
