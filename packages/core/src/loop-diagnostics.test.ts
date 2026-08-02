// D1 §3.3 / D2 §3.4: core はプラグインの stderr を捕捉して iter_N.json へ退避する。
// 以前は捨てられており、とくに best-effort な sink / on-fail の失敗は痕跡ゼロだった。
// 既存 loop.test.ts は変更せず、同様式の最小ハーネスをここに持つ。
import { describe, expect, it } from 'vitest';
import type { DiscoveredPlugin } from './discovery.js';
import type { RunPortResult } from './runPort.js';
import type { IterationInput, Logger } from './logger.js';
import { runLoop, type LoopDeps, type LoopPorts, type PortRunner } from './loop.js';

function jsonRes(value: unknown, stderr = '', exitCode = 0): RunPortResult {
  return {
    exitCode,
    signal: null,
    stdout: JSON.stringify(value),
    stderr,
    timedOut: false,
    aborted: false,
    durationMs: 1,
  };
}

/** A timed-out variant of {@link jsonRes} (runPort.ts:66-81 の RunPortResult 形状)。 */
function timedOutRes(value: unknown, stderr = '', durationMs = 5_000): RunPortResult {
  return {
    exitCode: null,
    signal: null,
    stdout: JSON.stringify(value),
    stderr,
    timedOut: true,
    aborted: false,
    durationMs,
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

/**
 * 1 タスクを払い出し、gate pass → sink まで進む最小ループ。stderr は差し替え可能。
 * `timedOutPlugins` に挙げたプラグインは、その呼び出し結果を timedOut:true にする
 * (ts の op=complete のように同一プラグインが複数回呼ばれる場合は最後の呼び出しのみ)。
 */
function makeDeps(
  stderrByPlugin: Record<string, string>,
  timedOutPlugins: Record<string, boolean> = {},
  failGates: Record<string, boolean> = {},
) {
  const logs: IterationInput[] = [];
  let paidOut = false;
  const ports: LoopPorts = {
    taskSource: [plug('task-source', 'ts')],
    context: [plug('context', 'c1')],
    executor: [plug('executor', 'ex')],
    gate: [plug('gate', 'g1')],
    sink: [plug('sink', 's1')],
    onFail: [plug('on-fail', 'of1')],
  };
  const runner: PortRunner = async (plugin, stdin) => {
    const stderr = stderrByPlugin[plugin.name] ?? '';
    const mk = timedOutPlugins[plugin.name] ? timedOutRes : jsonRes;
    if (plugin.name === 'ts') {
      const op = (stdin as { op?: string }).op;
      if (op === 'next') {
        if (paidOut) return jsonRes({ task_id: null });
        paidOut = true;
        return jsonRes({ task_id: 'T-1', title: 't', body: 'b', kind: 'code' });
      }
      if (op === 'complete') return mk({}, stderr);
      return jsonRes({});
    }
    if (plugin.name === 'c1') return mk({ fragments: [] }, stderr);
    if (plugin.name === 'ex') return mk({ status: 'done', summary: 'ok' }, stderr);
    if (plugin.name === 'g1' && failGates['g1'])
      return jsonRes({ reason: stderr || 'gate failed' }, stderr, 1);
    return mk({}, stderr);
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
    resolvePrUrl: () => 'https://example.test/pr/1',
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

describe('timeout diagnostics (#48)', () => {
  it('synthesizes a "timeout after Ns" line for a silent timed-out gate', async () => {
    const { deps, logs } = makeDeps({}, { g1: true });
    await runLoop(deps);

    const iteration = logs.find((l) => (l.diagnostics ?? []).length > 0)!;
    const diagnostics = iteration.diagnostics ?? [];
    const gate = diagnostics.find((d) => d.port === 'gate');
    expect(gate?.plugin).toBe('g1');
    expect(gate?.stderr).toBe('timeout after 5s');
  });

  it('appends "(timeout after Ns)" to existing stderr when both are present', async () => {
    const { deps, logs } = makeDeps({ ex: 'claude: hung' }, { ex: true });
    await runLoop(deps);

    const diagnostics = logs.find((l) => (l.diagnostics ?? []).length > 0)!.diagnostics ?? [];
    const executor = diagnostics.find((d) => d.port === 'executor');
    expect(executor?.stderr).toBe('claude: hung (timeout after 5s)');
  });

  it('records op=complete timeout on the task-source port (previously left no trace)', async () => {
    const { deps, logs } = makeDeps({}, { ts: true });
    await runLoop(deps);

    const diagnostics = logs.find((l) => l.outcome === 'passed')!.diagnostics ?? [];
    const taskSource = diagnostics.find((d) => d.port === 'task-source');
    expect(taskSource?.plugin).toBe('ts');
    expect(taskSource?.stderr).toBe('timeout after 5s');
  });

  it('records a silent timed-out context plugin', async () => {
    const { deps, logs } = makeDeps({}, { c1: true });
    await runLoop(deps);

    const diagnostics = logs.find((l) => (l.diagnostics ?? []).length > 0)!.diagnostics ?? [];
    const ctx = diagnostics.find((d) => d.port === 'context');
    expect(ctx?.plugin).toBe('c1');
    expect(ctx?.stderr).toBe('timeout after 5s');
  });

  it('records a silent timed-out on-fail plugin on the gate-fail path', async () => {
    const { deps, logs } = makeDeps({ g1: 'coverage below limit' }, { of1: true }, { g1: true });
    await runLoop(deps);

    const diagnostics = logs.find((l) => (l.diagnostics ?? []).length > 0)!.diagnostics ?? [];
    const onFail = diagnostics.find((d) => d.port === 'on-fail');
    expect(onFail?.plugin).toBe('of1');
    expect(onFail?.stderr).toBe('timeout after 5s');
  });
});
