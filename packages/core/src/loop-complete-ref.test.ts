// ADR-0016: 完了参照の一般化 — resolvePrUrl が async で `commit:<sha>` を返す経路の
// 新規テスト。既存 loop.test.ts は変更しない（ハーネスは同様式の最小版をここに持つ）。
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

/** task を1回払い出し、executor done / gate 無しで pass する最小ループを組む。 */
function makeDeps(resolvePrUrl: LoopDeps['resolvePrUrl']) {
  const calls: Array<{ name: string; stdin: unknown }> = [];
  let paidOut = false;
  const ports: LoopPorts = {
    taskSource: [plug('task-source', 'ts')],
    context: [],
    executor: [plug('executor', 'ex')],
    gate: [],
    sink: [],
    onFail: [],
  };
  const runner: PortRunner = async (plugin, stdin) => {
    calls.push({ name: plugin.name, stdin });
    if (plugin.name === 'ts') {
      const op = (stdin as { op?: string }).op;
      if (op === 'next') {
        if (paidOut) return jsonRes({ task_id: null });
        paidOut = true;
        return jsonRes({ task_id: 'T-1', title: 't', body: 'b', kind: 'code' });
      }
      return jsonRes({});
    }
    return jsonRes({ status: 'done', summary: 'ok' });
  };
  const logger: Logger = {
    writeIteration: async (input) => ({ path: `iter_${input.iter}.json`, log: {} as never }),
  };
  let clock = 1_000;
  const deps: LoopDeps = {
    config: { autonomy: 'L1', maxIter: 5, timeoutSec: 3600, profileName: 'test' },
    ports,
    runner,
    logger,
    now: () => (clock += 1),
    isStopPresent: () => false,
    isBudgetOk: () => true,
    createWorktree: (task) => `/wt/${String(task.task_id)}`,
    removeWorktree: () => undefined,
    ...(resolvePrUrl ? { resolvePrUrl } : {}),
  };
  return { deps, calls };
}

describe('completion reference (ADR-0016)', () => {
  it('awaits an async resolvePrUrl and fires op=complete with commit:<sha>', async () => {
    const { deps, calls } = makeDeps(async () => 'commit:abc123');
    const result = await runLoop(deps);
    expect(result.iterations[0]!.outcome).toBe('passed');
    const complete = calls.find(
      (c) => c.name === 'ts' && (c.stdin as { op?: string }).op === 'complete',
    );
    expect(complete).toBeDefined();
    expect((complete!.stdin as { pr_url: string }).pr_url).toBe('commit:abc123');
  });

  it('does not fire complete when the async reference resolves empty', async () => {
    const { deps, calls } = makeDeps(async () => '');
    await runLoop(deps);
    expect(
      calls.some((c) => c.name === 'ts' && (c.stdin as { op?: string }).op === 'complete'),
    ).toBe(false);
  });
});
