// loop unit tests (D2 §2, D8 §1.2 module 4): the pure decision pieces plus the
// driver exercised with fake runners (no process, no billing).
import { describe, expect, it } from 'vitest';
import type { ContextOut } from '@tsurupong/halo-contracts';
import type { DiscoveredPlugin } from './discovery.js';
import { RunPortError, type RunPortResult } from './runPort.js';
import type { IterationInput, Logger } from './logger.js';
import {
  buildPrompt,
  classifyExecutor,
  evaluateGates,
  exceededTimeout,
  mergeFragments,
  reachedMaxIter,
  runLoop,
  LoopError,
  type LoopDeps,
  type LoopPorts,
  type PortRunner,
} from './loop.js';

// --- fixtures ----------------------------------------------------------------

function res(over: Partial<RunPortResult> = {}): RunPortResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, ...over };
}

function jsonRes(value: unknown, over: Partial<RunPortResult> = {}): RunPortResult {
  return res({ stdout: JSON.stringify(value), ...over });
}

function plug(port: DiscoveredPlugin['port'], name: string, minAutonomy?: DiscoveredPlugin['manifest']['minAutonomy']): DiscoveredPlugin {
  return {
    port,
    name,
    dirName: name,
    dir: `/x/${name}`,
    execPath: `/x/${name}/run`,
    order: 0,
    manifest: { name, version: '1.0.0', port, exec: 'run', ...(minAutonomy ? { minAutonomy } : {}) },
  };
}

function emptyPorts(over: Partial<LoopPorts> = {}): LoopPorts {
  return { taskSource: [], context: [], executor: [], gate: [], sink: [], onFail: [], ...over };
}

interface Harness {
  deps: LoopDeps;
  logs: IterationInput[];
  calls: Array<{ name: string; stdin: unknown }>;
  removed: string[];
}

/** Build a driver harness whose runner dispatches by plugin name to a responder. */
function harness(opts: {
  ports: LoopPorts;
  respond: (name: string, stdin: unknown, callIndex: number) => RunPortResult;
  config?: Partial<LoopDeps['config']>;
  isStopPresent?: LoopDeps['isStopPresent'];
  isBudgetOk?: LoopDeps['isBudgetOk'];
  preflightHeavy?: LoopDeps['preflightHeavy'];
  resolvePrUrl?: LoopDeps['resolvePrUrl'];
}): Harness {
  const logs: IterationInput[] = [];
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
    writeIteration: async (input) => {
      logs.push(input);
      return { path: `iter_${input.iter}.json`, log: {} as never };
    },
  };

  let clock = 1_000;
  const deps: LoopDeps = {
    config: { autonomy: 'L1', maxIter: 20, timeoutSec: 3600, profileName: 'test', ...opts.config },
    ports: opts.ports,
    runner,
    logger,
    now: () => (clock += 1),
    isStopPresent: opts.isStopPresent ?? (() => false),
    isBudgetOk: opts.isBudgetOk ?? (() => true),
    createWorktree: (task) => `/wt/${task.task_id}`,
    removeWorktree: (workdir) => {
      removed.push(workdir);
    },
    ...(opts.preflightHeavy ? { preflightHeavy: opts.preflightHeavy } : {}),
    ...(opts.resolvePrUrl ? { resolvePrUrl: opts.resolvePrUrl } : {}),
  };
  return { deps, logs, calls, removed };
}

// --- pure: mergeFragments ----------------------------------------------------

describe('mergeFragments', () => {
  it('concatenates all plugins descending by priority, stable on ties (D2 §2.6)', () => {
    const lists: ContextOut[] = [
      { fragments: [{ source: 'a', content: 'A', priority: 10 }, { source: 'b', content: 'B', priority: 30 }] },
      { fragments: [{ source: 'c', content: 'C', priority: 10 }, { source: 'd', content: 'D', priority: 20 }] },
    ];
    expect(mergeFragments(lists).map((f) => f.source)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('drops malformed fragments without throwing', () => {
    const lists = [{ fragments: [{ source: 'ok', content: 'x', priority: 1 }, { bad: true }] }] as unknown as ContextOut[];
    expect(mergeFragments(lists).map((f) => f.source)).toEqual(['ok']);
  });

  it('truncates at the token limit, slicing the crossing fragment', () => {
    const lists: ContextOut[] = [
      { fragments: [{ source: 'big', content: 'x'.repeat(40), priority: 5 }, { source: 'next', content: 'y'.repeat(40), priority: 1 }] },
    ];
    // limit 10 tokens ≈ 40 chars: first fragment fills it, second is dropped.
    const merged = mergeFragments(lists, 10);
    expect(merged.map((f) => f.source)).toEqual(['big']);
  });
});

// --- pure: buildPrompt -------------------------------------------------------

describe('buildPrompt', () => {
  it('includes task, context, and no failure section on the first attempt', () => {
    const prompt = buildPrompt({ task_id: '7', title: 'Add X', body: 'do X' }, [{ source: 'kg', content: 'ctx', priority: 1 }]);
    expect(prompt).toContain('Add X');
    expect(prompt).toContain('ctx');
    expect(prompt).not.toContain('前回の失敗');
  });

  it('re-injects the previous failure reason and hint (D2 §2.4)', () => {
    const prompt = buildPrompt({ task_id: '7' }, [], { reason: 'coverage 87% < 90%', hint: 'add tests', gate: '30-test' });
    expect(prompt).toContain('前回の失敗');
    expect(prompt).toContain('coverage 87% < 90%');
    expect(prompt).toContain('add tests');
  });
});

// --- pure: classifyExecutor --------------------------------------------------

describe('classifyExecutor', () => {
  it('maps stdout status done/stuck/timeout', () => {
    expect(classifyExecutor(jsonRes({ status: 'done', summary: 'ok' })).outcome).toBe('done');
    expect(classifyExecutor(jsonRes({ status: 'stuck', summary: '' })).outcome).toBe('stuck');
    expect(classifyExecutor(jsonRes({ status: 'timeout', summary: '' })).outcome).toBe('timeout');
  });

  it('folds a process timeout, non-zero exit, or bad JSON to error', () => {
    expect(classifyExecutor(res({ timedOut: true })).outcome).toBe('error');
    expect(classifyExecutor(res({ exitCode: 1, stdout: '{"status":"done","summary":"x"}' })).outcome).toBe('error');
    expect(classifyExecutor(res({ stdout: 'not json' })).outcome).toBe('error');
    expect(classifyExecutor(jsonRes({ status: 'bogus', summary: '' })).outcome).toBe('error');
  });
});

// --- pure: evaluateGates -----------------------------------------------------

describe('evaluateGates', () => {
  it('passes only when every gate exits 0', () => {
    const verdict = evaluateGates([
      { name: '10-a', result: res({ exitCode: 0 }) },
      { name: '20-b', result: res({ exitCode: 0 }) },
    ]);
    expect(verdict.passed).toBe(true);
    expect(verdict.results.every((r) => r.result === 'pass')).toBe(true);
  });

  it('fails on the first exit-2 gate and keeps its reason (D2 §2.2)', () => {
    const verdict = evaluateGates([
      { name: '10-a', result: res({ exitCode: 0 }) },
      { name: '30-test', result: jsonRes({ reason: 'coverage low', hint: 'tests', gate: '30-test' }, { exitCode: 2 }) },
      { name: '40-c', result: jsonRes({ reason: 'other', gate: '40-c' }, { exitCode: 2 }) },
    ]);
    expect(verdict.passed).toBe(false);
    expect(verdict.failure).toEqual({ reason: 'coverage low', hint: 'tests', gate: '30-test' });
  });

  it('folds a non-0/2 exit to a safe-side fail with a synthesized reason', () => {
    const verdict = evaluateGates([{ name: '10-a', result: res({ exitCode: 1 }) }]);
    expect(verdict.passed).toBe(false);
    expect(verdict.failure?.reason).toContain("gate '10-a' errored");
  });
});

// --- pure: termination predicates -------------------------------------------

describe('termination predicates', () => {
  it('reachedMaxIter fires when the next iteration exceeds the cap', () => {
    expect(reachedMaxIter(20, 20)).toBe(false);
    expect(reachedMaxIter(21, 20)).toBe(true);
  });
  it('exceededTimeout compares elapsed ms against timeoutSec', () => {
    expect(exceededTimeout(0, 900_000, 900)).toBe(false);
    expect(exceededTimeout(0, 900_001, 900)).toBe(true);
  });
});

// --- driver (fake runner) ----------------------------------------------------

describe('runLoop', () => {
  it('throws LoopError when a single port has no plugin', async () => {
    const h = harness({ ports: emptyPorts({ taskSource: [plug('task-source', 'ts')] }), respond: () => res() });
    await expect(runLoop(h.deps)).rejects.toBeInstanceOf(LoopError);
  });

  it('ends NO_TASK immediately when task-source returns null', async () => {
    const ports = emptyPorts({ taskSource: [plug('task-source', 'ts')], executor: [plug('executor', 'ex')] });
    const h = harness({ ports, respond: () => jsonRes({ task_id: null }) });
    const result = await runLoop(h.deps);
    expect(result.endReason).toBe('NO_TASK');
    expect(result.iterations).toHaveLength(0);
  });

  it('runs happy path: task → execute → gate pass → sink → complete', async () => {
    const ports = emptyPorts({
      taskSource: [plug('task-source', 'ts')],
      executor: [plug('executor', 'ex')],
      gate: [plug('gate', 'g')],
      sink: [plug('sink', 'log', 'L1')],
    });
    const h = harness({
      ports,
      // A PR url was produced → op=complete is expected to fire (see L1 test below).
      resolvePrUrl: () => 'https://example/pr/1',
      respond: (name, stdin, i) => {
        if (name === 'ts') {
          if ((stdin as { op: string }).op === 'complete') return res();
          return i === 0 ? jsonRes({ task_id: '1', title: 'T' }) : jsonRes({ task_id: null });
        }
        if (name === 'ex') return jsonRes({ status: 'done', summary: 'ok' });
        if (name === 'g') return res({ exitCode: 0 });
        return res();
      },
    });
    const result = await runLoop(h.deps);
    expect(result.endReason).toBe('NO_TASK');
    expect(result.iterations).toEqual([expect.objectContaining({ taskId: '1', outcome: 'passed' })]);
    // sink + complete both fired; worktree removed.
    expect(h.calls.filter((c) => c.name === 'log')).toHaveLength(1);
    expect(h.calls.some((c) => c.name === 'ts' && (c.stdin as { op: string }).op === 'complete')).toBe(true);
    expect(h.removed).toEqual(['/wt/1']);
  });

  it('skips an L3 sink at L1 autonomy (D2 §2.5)', async () => {
    const ports = emptyPorts({
      taskSource: [plug('task-source', 'ts')],
      executor: [plug('executor', 'ex')],
      gate: [],
      sink: [plug('sink', 'pr', 'L3'), plug('sink', 'log', 'L1')],
    });
    const h = harness({
      ports,
      config: { autonomy: 'L1' },
      respond: (name, stdin, i) => {
        if (name === 'ts') return (stdin as { op?: string }).op === 'complete' ? res() : i === 0 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        if (name === 'ex') return jsonRes({ status: 'done', summary: 'ok' });
        return res();
      },
    });
    await runLoop(h.deps);
    expect(h.calls.some((c) => c.name === 'pr')).toBe(false);
    expect(h.calls.some((c) => c.name === 'log')).toBe(true);
  });

  it('re-injects the gate failure into the next prompt, then succeeds (D2 §2.4)', async () => {
    const ports = emptyPorts({
      taskSource: [plug('task-source', 'ts')],
      executor: [plug('executor', 'ex')],
      gate: [plug('gate', 'g')],
      onFail: [plug('on-fail', 'rec')],
    });
    const h = harness({
      ports,
      respond: (name, stdin, i) => {
        if (name === 'ts') return (stdin as { op?: string }).op === 'complete' ? res() : i < 2 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        if (name === 'ex') return jsonRes({ status: 'done', summary: 'ok' });
        if (name === 'g') return i === 0 ? jsonRes({ reason: 'coverage 87% < 90%', gate: '30-test' }, { exitCode: 2 }) : res({ exitCode: 0 });
        return res();
      },
    });
    const result = await runLoop(h.deps);
    expect(result.iterations[0]?.outcome).toBe('failed');
    expect(result.iterations[1]?.outcome).toBe('passed');
    expect(result.iterations[1]?.prompt).toContain('coverage 87% < 90%');
    expect(h.calls.some((c) => c.name === 'rec')).toBe(true);
  });

  it('routes a stuck executor to the failure path (D2 §2.3)', async () => {
    const ports = emptyPorts({
      taskSource: [plug('task-source', 'ts')],
      executor: [plug('executor', 'ex')],
      gate: [plug('gate', 'g')],
      onFail: [plug('on-fail', 'rec')],
    });
    const h = harness({
      ports,
      respond: (name, _stdin, i) => {
        if (name === 'ts') return i === 0 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        if (name === 'ex') return jsonRes({ status: 'stuck', summary: 'blocked' });
        return res();
      },
    });
    const result = await runLoop(h.deps);
    expect(result.iterations[0]).toEqual(expect.objectContaining({ executorStatus: 'stuck', outcome: 'failed' }));
    // Gate never runs when the executor did not finish.
    expect(h.calls.some((c) => c.name === 'g')).toBe(false);
    expect(h.calls.some((c) => c.name === 'rec')).toBe(true);
  });

  it('stops with BUDGET_EXCEEDED mid-run', async () => {
    let iters = 0;
    const ports = emptyPorts({ taskSource: [plug('task-source', 'ts')], executor: [plug('executor', 'ex')], gate: [] });
    const h = harness({
      ports,
      isBudgetOk: () => iters < 2,
      respond: (name) => {
        if (name === 'ts') return jsonRes({ task_id: `${++iters}` });
        return jsonRes({ status: 'done', summary: 'ok' });
      },
    });
    const result = await runLoop(h.deps);
    expect(result.endReason).toBe('BUDGET_EXCEEDED');
  });

  it('stops with STOP when the kill-switch appears mid-run', async () => {
    let seen = 0;
    const ports = emptyPorts({ taskSource: [plug('task-source', 'ts')], executor: [plug('executor', 'ex')], gate: [] });
    const h = harness({
      ports,
      isStopPresent: () => seen++ >= 1,
      respond: (name) => (name === 'ts' ? jsonRes({ task_id: '1' }) : jsonRes({ status: 'done', summary: 'ok' })),
    });
    const result = await runLoop(h.deps);
    expect(result.endReason).toBe('STOP');
    expect(result.iterations).toHaveLength(1);
  });

  it('stops with MAX_ITER after the configured number of iterations', async () => {
    const ports = emptyPorts({ taskSource: [plug('task-source', 'ts')], executor: [plug('executor', 'ex')], gate: [] });
    const h = harness({
      ports,
      config: { maxIter: 3 },
      respond: (name, _stdin, i) => (name === 'ts' ? jsonRes({ task_id: `${i}` }) : jsonRes({ status: 'done', summary: 'ok' })),
    });
    const result = await runLoop(h.deps);
    expect(result.endReason).toBe('MAX_ITER');
    expect(result.iterations).toHaveLength(3);
  });

  it('stops with TIMEOUT at an iteration boundary', async () => {
    const ports = emptyPorts({ taskSource: [plug('task-source', 'ts')], executor: [plug('executor', 'ex')], gate: [] });
    const h = harness({
      ports,
      config: { timeoutSec: 0 },
      respond: (name) => (name === 'ts' ? jsonRes({ task_id: '1' }) : jsonRes({ status: 'done', summary: 'ok' })),
    });
    const result = await runLoop(h.deps);
    expect(result.endReason).toBe('TIMEOUT');
  });

  // H1: a RunPortError from the executor must not escape and crash the loop.
  it('folds an executor spawn failure to the failure path instead of crashing (H1)', async () => {
    const ports = emptyPorts({
      taskSource: [plug('task-source', 'ts')],
      executor: [plug('executor', 'ex')],
      gate: [plug('gate', 'g')],
      onFail: [plug('on-fail', 'rec')],
    });
    const h = harness({
      ports,
      respond: (name, _stdin, i) => {
        if (name === 'ts') return i === 0 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        if (name === 'ex') throw new RunPortError('spawn ENOENT');
        return res();
      },
    });
    const result = await runLoop(h.deps);
    expect(result.endReason).toBe('NO_TASK');
    expect(result.iterations[0]).toEqual(expect.objectContaining({ executorStatus: 'error', outcome: 'failed' }));
    expect(h.calls.some((c) => c.name === 'rec')).toBe(true); // on-fail still recorded
    expect(h.removed).toEqual(['/wt/1']); // worktree cleaned up
  });

  // H1: a gate spawn failure folds to a safe-side failing gate (logical-AND fails closed).
  it('folds a gate spawn failure to a failing gate without crashing (H1)', async () => {
    const ports = emptyPorts({
      taskSource: [plug('task-source', 'ts')],
      executor: [plug('executor', 'ex')],
      gate: [plug('gate', 'g')],
      onFail: [plug('on-fail', 'rec')],
    });
    const h = harness({
      ports,
      respond: (name, _stdin, i) => {
        if (name === 'ts') return i === 0 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        if (name === 'ex') return jsonRes({ status: 'done', summary: 'ok' });
        if (name === 'g') throw new RunPortError('spawn ENOENT');
        return res();
      },
    });
    const result = await runLoop(h.deps);
    expect(result.endReason).toBe('NO_TASK');
    expect(result.iterations[0]).toEqual(expect.objectContaining({ outcome: 'failed' }));
    expect(result.iterations[0]?.gateFailure?.reason).toContain("gate 'g' failed to run");
  });

  // M1: each plugin's manifest timeoutSec is forwarded to the runner opts.
  it('forwards each plugin manifest timeoutSec to the runner (M1)', async () => {
    const ts = plug('task-source', 'ts');
    ts.manifest.timeoutSec = 12;
    const gate = plug('gate', 'g');
    gate.manifest.timeoutSec = 34;
    const ports = emptyPorts({ taskSource: [ts], executor: [plug('executor', 'ex')], gate: [gate] });
    const seen = new Map<string, number | undefined>();
    const h = harness({
      ports,
      respond: (name, _stdin, i) => {
        if (name === 'ts') return i === 0 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        if (name === 'ex') return jsonRes({ status: 'done', summary: 'ok' });
        return res({ exitCode: 0 });
      },
    });
    const inner = h.deps.runner;
    h.deps.runner = async (plugin, stdin, opts) => {
      if (!seen.has(plugin.name)) seen.set(plugin.name, opts?.timeoutSec);
      return inner(plugin, stdin, opts);
    };
    await runLoop(h.deps);
    expect(seen.get('ts')).toBe(12);
    expect(seen.get('g')).toBe(34);
  });

  // M2: the executor process wall sits a grace margin past the budget timeout.
  it('gives the executor process timeout a grace margin over the budget (M2)', async () => {
    const ports = emptyPorts({ taskSource: [plug('task-source', 'ts')], executor: [plug('executor', 'ex')], gate: [] });
    let execTimeoutSec: number | undefined;
    const h = harness({
      ports,
      config: { executorTimeoutSec: 900, executorTimeoutGraceSec: 30 },
      respond: (name, _stdin, i) => {
        if (name === 'ts') return i === 0 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        return jsonRes({ status: 'done', summary: 'ok' });
      },
    });
    const inner = h.deps.runner;
    h.deps.runner = async (plugin, stdin, opts) => {
      if (plugin.name === 'ex') execTimeoutSec = opts?.timeoutSec;
      return inner(plugin, stdin, opts);
    };
    await runLoop(h.deps);
    expect(execTimeoutSec).toBe(930); // 900 budget + 30 grace
  });

  // M3: a global heavy-preflight failure ends the loop as ABORTED_ENV, not escalated.
  it('ends the loop with ABORTED_ENV when heavy preflight fails globally (M3)', async () => {
    const ports = emptyPorts({
      taskSource: [plug('task-source', 'ts')],
      executor: [plug('executor', 'ex')],
      onFail: [plug('on-fail', 'rec')],
    });
    const h = harness({
      ports,
      preflightHeavy: () => ({ proceed: false, reason: 'DIRTY_WORKTREE' }),
      respond: (name) => (name === 'ts' ? jsonRes({ task_id: '1' }) : res()),
    });
    const result = await runLoop(h.deps);
    expect(result.endReason).toBe('ABORTED_ENV');
    expect(result.endDetail).toContain('DIRTY_WORKTREE');
    expect(result.iterations).toEqual([expect.objectContaining({ outcome: 'aborted_env' })]);
    // Env fault is not a task failure: no on-fail, no executor run.
    expect(h.calls.some((c) => c.name === 'rec')).toBe(false);
    expect(h.calls.some((c) => c.name === 'ex')).toBe(false);
  });

  // M4: a broken task-source ends TASK_SOURCE_ERROR, distinct from a healthy NO_TASK.
  it('ends TASK_SOURCE_ERROR on a non-pass task-source exit (M4)', async () => {
    const ports = emptyPorts({ taskSource: [plug('task-source', 'ts')], executor: [plug('executor', 'ex')] });
    const h = harness({ ports, respond: () => res({ exitCode: 1, stdout: 'garbage' }) });
    const result = await runLoop(h.deps);
    expect(result.endReason).toBe('TASK_SOURCE_ERROR');
    expect(result.endDetail).toContain('task-source');
  });

  it('ends TASK_SOURCE_ERROR when the task-source spawn throws (M4)', async () => {
    const ports = emptyPorts({ taskSource: [plug('task-source', 'ts')], executor: [plug('executor', 'ex')] });
    const h = harness({
      ports,
      respond: (name) => {
        if (name === 'ts') throw new RunPortError('spawn ENOENT');
        return res();
      },
    });
    const result = await runLoop(h.deps);
    expect(result.endReason).toBe('TASK_SOURCE_ERROR');
  });

  // L1: at L1 (report-only, empty pr_url) op=complete is NOT called; task left in-progress.
  it('does not call op=complete at L1 when no PR url was produced (L1)', async () => {
    const ports = emptyPorts({
      taskSource: [plug('task-source', 'ts')],
      executor: [plug('executor', 'ex')],
      gate: [],
      sink: [plug('sink', 'log', 'L1')],
    });
    const h = harness({
      ports,
      config: { autonomy: 'L1' },
      respond: (name, _stdin, i) => {
        if (name === 'ts') return i === 0 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        if (name === 'ex') return jsonRes({ status: 'done', summary: 'ok' });
        return res();
      },
    });
    const result = await runLoop(h.deps);
    expect(result.iterations[0]?.outcome).toBe('passed');
    expect(h.calls.some((c) => c.name === 'ts' && (c.stdin as { op?: string }).op === 'complete')).toBe(false);
    expect(h.calls.some((c) => c.name === 'log')).toBe(true); // sink still fired
  });

  // L2: a stuck executor's reason is re-injected into the next attempt's prompt.
  it('re-injects the executor failure reason into the next prompt (L2)', async () => {
    const ports = emptyPorts({
      taskSource: [plug('task-source', 'ts')],
      executor: [plug('executor', 'ex')],
      gate: [plug('gate', 'g')],
    });
    const h = harness({
      ports,
      respond: (name, _stdin, i) => {
        if (name === 'ts') return i < 2 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null });
        if (name === 'ex') return i === 0 ? jsonRes({ status: 'stuck', summary: 'blocked on X' }) : jsonRes({ status: 'done', summary: 'ok' });
        return res({ exitCode: 0 });
      },
    });
    const result = await runLoop(h.deps);
    expect(result.iterations[0]?.outcome).toBe('failed');
    expect(result.iterations[1]?.prompt).toContain('executor stuck');
    expect(result.iterations[1]?.prompt).toContain('blocked on X');
  });

  it('writes one iteration log per executed iteration', async () => {
    const ports = emptyPorts({ taskSource: [plug('task-source', 'ts')], executor: [plug('executor', 'ex')], gate: [] });
    const h = harness({
      ports,
      respond: (name, _stdin, i) => (name === 'ts' ? (i === 0 ? jsonRes({ task_id: '1' }) : jsonRes({ task_id: null })) : jsonRes({ status: 'done', summary: 'ok' })),
    });
    await runLoop(h.deps);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toEqual(expect.objectContaining({ iter: 1, outcome: 'passed' }));
  });
});
