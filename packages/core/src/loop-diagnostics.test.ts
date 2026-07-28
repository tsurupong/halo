// D1 §3.3 / D2 §3.4: core はプラグインの stderr を捕捉して iter_N.json へ退避する。
// 以前は捨てられており、とくに best-effort な sink / on-fail の失敗は痕跡ゼロだった。
// 既存 loop.test.ts は変更せず、同様式の最小ハーネスをここに持つ。
import { describe, expect, it } from 'vitest';
import type { DiscoveredPlugin } from './discovery.js';
import type { RunPortResult } from './runPort.js';
import type { IterationInput, Logger } from './logger.js';
import { runLoop, type LoopDeps, type LoopPorts, type PortRunner } from './loop.js';

function jsonRes(value: unknown, stderr = ''): RunPortResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify(value),
    stderr,
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
    manifest: { name, version: '1.0.0', port, entry: 'run', minAutonomy: 'L1' },
  };
}

/** 1 タスクを払い出し、gate pass → sink まで進む最小ループ。stderr は差し替え可能。 */
function makeDeps(stderrByPlugin: Record<string, string>) {
  const logs: IterationInput[] = [];
  let paidOut = false;
  const ports: LoopPorts = {
    taskSource: [plug('task-source', 'ts')],
    context: [],
    executor: [plug('executor', 'ex')],
    gate: [plug('gate', 'g1')],
    sink: [plug('sink', 's1')],
    onFail: [],
  };
  const runner: PortRunner = async (plugin, stdin) => {
    const stderr = stderrByPlugin[plugin.name] ?? '';
    if (plugin.name === 'ts') {
      const op = (stdin as { op?: string }).op;
      if (op === 'next') {
        if (paidOut) return jsonRes({ task_id: null });
        paidOut = true;
        return jsonRes({ task_id: 'T-1', title: 't', body: 'b', kind: 'code' });
      }
      return jsonRes({});
    }
    if (plugin.name === 'ex') return jsonRes({ status: 'done', summary: 'ok' }, stderr);
    return jsonRes({}, stderr);
  };
  const logger: Logger = {
    writeIteration: async (input) => {
      logs.push(input);
      return { path: `iter_${input.iter}.json`, log: {} as never };
    },
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
  };
  return { deps, logs };
}

describe('plugin stderr capture (D1 §3.3)', () => {
  it('records gate and sink stderr against their port and plugin name', async () => {
    const { deps, logs } = makeDeps({ g1: 'gate warning: coverage close to limit', s1: '' });
    await runLoop(deps);

    const iteration = logs.find((l) => l.outcome === 'passed');
    expect(iteration).toBeDefined();
    const diagnostics = iteration!.diagnostics ?? [];
    expect(diagnostics).toContainEqual({
      port: 'gate',
      plugin: 'g1',
      stderr: 'gate warning: coverage close to limit',
    });
  });

  it('captures a best-effort sink failure that would otherwise leave no trace', async () => {
    const { deps, logs } = makeDeps({ s1: 'sink-git-commit: コミット失敗: T-1' });
    await runLoop(deps);

    const diagnostics = logs.find((l) => l.outcome === 'passed')!.diagnostics ?? [];
    const sink = diagnostics.find((d) => d.port === 'sink');
    expect(sink?.plugin).toBe('s1');
    expect(sink?.stderr).toContain('コミット失敗');
  });

  it('captures executor stderr on the success path too', async () => {
    const { deps, logs } = makeDeps({ ex: 'claude: rate limited, retrying' });
    await runLoop(deps);

    const diagnostics = logs.find((l) => l.outcome === 'passed')!.diagnostics ?? [];
    expect(
      diagnostics.some((d) => d.port === 'executor' && d.stderr.includes('rate limited')),
    ).toBe(true);
  });

  it('omits diagnostics entirely when every plugin was quiet', async () => {
    const { deps, logs } = makeDeps({});
    await runLoop(deps);

    const iteration = logs.find((l) => l.outcome === 'passed')!;
    expect(iteration.diagnostics ?? []).toEqual([]);
  });
});
