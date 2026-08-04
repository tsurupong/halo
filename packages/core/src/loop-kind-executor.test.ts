// kind.executor (issue #51): runLoop の executor 選択と selectExecutor 単体テスト。
// 既存 loop.test.ts のモック様式(plug / emptyPorts / harness)に準拠する。
import { describe, expect, it } from 'vitest';
import type { DiscoveredPlugin } from './discovery.js';
import type { RunPortResult } from './runPort.js';
import type { IterationInput, Logger } from './logger.js';
import { runLoop, selectExecutor, type LoopDeps, type LoopPorts, type PortRunner } from './loop.js';

// --- fixtures (loop.test.ts と同一様式) --------------------------------------

function res(over: Partial<RunPortResult> = {}): RunPortResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
    durationMs: 1,
    ...over,
  };
}

function jsonRes(value: unknown, over: Partial<RunPortResult> = {}): RunPortResult {
  return res({ stdout: JSON.stringify(value), ...over });
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

function emptyPorts(over: Partial<LoopPorts> = {}): LoopPorts {
  return { taskSource: [], context: [], executor: [], gate: [], sink: [], onFail: [], ...over };
}

interface Harness {
  deps: LoopDeps;
  calls: Array<{ name: string; stdin: unknown }>;
  removed: string[];
}

function harness(opts: {
  ports: LoopPorts;
  respond: (name: string, stdin: unknown, callIndex: number) => RunPortResult;
  kindPrompt?: LoopDeps['kindPrompt'];
}): Harness {
  const calls: Array<{ name: string; stdin: unknown }> = [];
  const removed: string[] = [];
  const perName = new Map<string, number>();

  const runner: PortRunner = async (plugin, stdin) => {
    const n = perName.get(plugin.name) ?? 0;
    perName.set(plugin.name, n + 1);
    calls.push({ name: plugin.name, stdin });
    return opts.respond(plugin.name, stdin, n);
  };

  const logger: Logger = {
    writeIteration: async (input: IterationInput) => ({
      path: `iter_${input.iter}.json`,
      log: {} as never,
    }),
  };

  let clock = 1_000;
  const deps: LoopDeps = {
    config: { autonomy: 'L1', maxIter: 20, timeoutSec: 3600, profileName: 'test' },
    ports: opts.ports,
    runner,
    logger,
    now: () => (clock += 1),
    isStopPresent: () => false,
    isBudgetOk: () => true,
    createWorktree: (task) => `/wt/${task.task_id}`,
    removeWorktree: (workdir) => {
      removed.push(workdir);
    },
    ...(opts.kindPrompt ? { kindPrompt: opts.kindPrompt } : {}),
  };
  return { deps, calls, removed };
}

// --- pure: selectExecutor -----------------------------------------------------

describe('selectExecutor', () => {
  const plugins = [plug('executor', 'ex-1'), plug('executor', 'ex-alt')];

  it('picks the first enabled executor when no name is given', () => {
    const r = selectExecutor(plugins);
    expect(r).toEqual({ status: 'selected', executor: plugins[0] });
  });

  it('picks the plugin matching the given name', () => {
    const r = selectExecutor(plugins, 'ex-alt');
    expect(r).toEqual({ status: 'selected', executor: plugins[1] });
  });

  it('returns needs-human for a name that matches no enabled executor', () => {
    const r = selectExecutor(plugins, 'ex-unknown');
    expect(r.status).toBe('needs-human');
    if (r.status === 'needs-human') {
      expect(r.reason).toContain('ex-unknown');
      expect(r.reason).toContain('ex-1');
      expect(r.reason).toContain('ex-alt');
    }
  });
});

// --- runLoop integration -------------------------------------------------------

describe('runLoop kind.executor selection (issue #51)', () => {
  const ports = () =>
    emptyPorts({
      taskSource: [plug('task-source', 'ts')],
      executor: [plug('executor', 'ex-1'), plug('executor', 'ex-alt')],
      gate: [plug('gate', 'g')],
      onFail: [plug('on-fail', 'of')],
    });

  it('(A) routes execution to the kind-declared executor plugin', async () => {
    const h = harness({
      ports: ports(),
      kindPrompt: () => ({
        status: 'resolved',
        kind: 'code',
        runtimes: ['node-pnpm'],
        instructions: 'RULES',
        executor: 'ex-alt',
      }),
      respond: (name, stdin, i) => {
        if (name === 'ts') {
          if ((stdin as { op: string }).op !== 'next') return res();
          return i === 0 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        }
        if (name === 'ex-alt') return jsonRes({ status: 'done', summary: 'ok' });
        return res({ exitCode: 0 });
      },
    });
    const result = await runLoop(h.deps);
    expect(h.calls.some((c) => c.name === 'ex-alt')).toBe(true);
    expect(h.calls.some((c) => c.name === 'ex-1')).toBe(false);
    expect(result.iterations).toEqual([
      expect.objectContaining({ taskId: '1', outcome: 'passed' }),
    ]);
  });

  it('(B) falls back to the first enabled executor when the kind declares none', async () => {
    const h = harness({
      ports: ports(),
      kindPrompt: () => ({
        status: 'resolved',
        kind: 'code',
        runtimes: ['node-pnpm'],
        instructions: 'RULES',
      }),
      respond: (name, stdin, i) => {
        if (name === 'ts') {
          if ((stdin as { op: string }).op !== 'next') return res();
          return i === 0 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        }
        if (name === 'ex-1') return jsonRes({ status: 'done', summary: 'ok' });
        return res({ exitCode: 0 });
      },
    });
    await runLoop(h.deps);
    expect(h.calls.some((c) => c.name === 'ex-1')).toBe(true);
    expect(h.calls.some((c) => c.name === 'ex-alt')).toBe(false);
  });

  it('(C) escalates to needs-human, never calls the executor, and continues the run', async () => {
    const h = harness({
      ports: ports(),
      kindPrompt: () => ({
        status: 'resolved',
        kind: 'code',
        runtimes: ['node-pnpm'],
        instructions: 'RULES',
        executor: 'ex-unknown',
      }),
      respond: (name, stdin, i) => {
        if (name === 'ts') {
          if ((stdin as { op: string }).op !== 'next') return res();
          return i === 0 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        }
        return res();
      },
    });
    const result = await runLoop(h.deps);

    // needs-human: the task escalates, run continues to NO_TASK (does not throw / abort).
    expect(result.endReason).toBe('NO_TASK');
    expect(result.iterations).toEqual([
      expect.objectContaining({ taskId: '1', outcome: 'escalated' }),
    ]);

    // The executor was never invoked, and no worktree was created or removed.
    expect(h.calls.some((c) => c.name === 'ex-1' || c.name === 'ex-alt')).toBe(false);
    expect(h.removed).toEqual([]);

    // on-fail ran and the task-source was told to record the failure (op=fail) — the
    // same claim-release path as an undeclared-kind escalation.
    expect(h.calls.some((c) => c.name === 'of')).toBe(true);
    const failCall = h.calls.find(
      (c) => c.name === 'ts' && (c.stdin as { op: string }).op === 'fail',
    );
    expect(failCall).toBeDefined();
    expect((failCall?.stdin as { reason: string }).reason).toContain('ex-unknown');
  });
});
