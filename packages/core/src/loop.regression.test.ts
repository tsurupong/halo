// loop regression tests (D8 §2): drive the real state machine end-to-end with
// fixture plugins (Node ESM scripts that echo canned JSON — test/mocks/*.mjs). Real
// process boundary through runPort, zero network, zero claude billing. Covers the
// five executor/gate/task paths (§2.2) and the five terminal conditions (§2.3).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiscoveredPlugin } from './discovery.js';
import type { Port } from '@tsurupong/halo-contracts';
import type { IterationInput, Logger } from './logger.js';
import { runPort } from './runPort.js';
import { runLoop, type LoopConfig, type LoopDeps, type LoopPorts, type PortRunner } from './loop.js';

const MOCK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'mocks');

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'halo-loop-reg-'));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

/** A DiscoveredPlugin pointing at a fixture script, carrying per-scenario env. */
function mock(port: Port, name: string, script: string, env: Record<string, string> = {}, minAutonomy?: DiscoveredPlugin['manifest']['minAutonomy']): DiscoveredPlugin {
  return {
    port,
    name,
    dirName: name,
    dir: MOCK_DIR,
    entryPath: join(MOCK_DIR, script),
    order: 0,
    manifest: { name, version: '1.0.0', port, entry: script, ...(minAutonomy ? { minAutonomy } : {}), env },
  };
}

/** Filter process.env down to defined string values so runPort gets a clean env. */
function baseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
  return out;
}

interface Rig {
  deps: LoopDeps;
  logs: IterationInput[];
}

function rig(ports: Partial<LoopPorts>, over: Omit<Partial<LoopDeps>, 'config'> & { config?: Partial<LoopConfig> } = {}): Rig {
  const logs: IterationInput[] = [];
  const logger: Logger = {
    writeIteration: async (input) => {
      logs.push(input);
      return { path: '', log: {} as never };
    },
  };
  const runner: PortRunner = (plugin, stdin, opts) =>
    runPort({
      execPath: process.execPath,
      args: [plugin.entryPath],
      stdin,
      timeoutMs: (opts?.timeoutSec ?? 5) * 1000,
      env: { ...baseEnv(), STATE_DIR: stateDir, PLUGIN_NAME: plugin.name, ...(plugin.manifest.env ?? {}) },
    });
  const full: LoopPorts = { taskSource: [], context: [], executor: [], gate: [], sink: [], onFail: [], ...ports };
  const deps: LoopDeps = {
    config: { autonomy: 'L1', maxIter: 20, timeoutSec: 3600, profileName: 'reg', ...over.config },
    ports: full,
    runner,
    logger,
    now: () => Date.now(),
    isStopPresent: over.isStopPresent ?? (() => false),
    isBudgetOk: over.isBudgetOk ?? (() => true),
    createWorktree: (task) => `/wt/${task.task_id}`,
    removeWorktree: () => undefined,
    ...(over.preflightHeavy ? { preflightHeavy: over.preflightHeavy } : {}),
    ...(over.resolvePrUrl ? { resolvePrUrl: over.resolvePrUrl } : {}),
  };
  return { deps, logs };
}

describe('loop regression (fixture plugins, zero billing)', () => {
  it('happy path: task → execute → gate pass → sink → complete → NO_TASK', async () => {
    const { deps, logs } = rig(
      {
        taskSource: [mock('task-source', 'ts', 'task-source.mjs', { TS_REPEAT: '1' })],
        executor: [mock('executor', 'ex', 'executor.mjs', { EXEC_STATUS: 'done' })],
        gate: [mock('gate', 'g', 'gate.mjs', { GATE_MODE: 'pass' })],
        sink: [mock('sink', 'log', 'sink.mjs', {}, 'L1')],
      },
      // A PR url is produced → op=complete fires (M4/L1: complete gated on a real PR url).
      { resolvePrUrl: () => 'https://example/pr/1' },
    );
    const result = await runLoop(deps);
    expect(result.endReason).toBe('NO_TASK');
    expect(result.iterations).toEqual([expect.objectContaining({ taskId: '1', outcome: 'passed' })]);
    expect(existsSync(join(stateDir, 'sink_log'))).toBe(true);
    expect(existsSync(join(stateDir, 'ts_complete'))).toBe(true);
    expect(logs).toHaveLength(1);
  });

  it('gate fail → on-fail → retry with re-injected reason → success', async () => {
    const { deps } = rig({
      taskSource: [mock('task-source', 'ts', 'task-source.mjs', { TS_REPEAT: '2' })],
      executor: [mock('executor', 'ex', 'executor.mjs', { EXEC_STATUS: 'done' })],
      gate: [mock('gate', 'g', 'gate.mjs', { GATE_MODE: 'fail_then_pass' })],
      onFail: [mock('on-fail', 'rec', 'on-fail.mjs')],
    });
    const result = await runLoop(deps);
    expect(result.iterations[0]?.outcome).toBe('failed');
    expect(result.iterations[1]?.outcome).toBe('passed');
    expect(result.iterations[1]?.prompt).toContain('coverage 87% < 90%');
    const onfail = readFileSync(join(stateDir, 'onfail'), 'utf8');
    expect(onfail).toContain('"retry_count":1');
  });

  it('retry exhaustion: same task fails to threshold, then task-source stops paying it out', async () => {
    const { deps } = rig(
      {
        taskSource: [mock('task-source', 'ts', 'task-source.mjs', { TS_REPEAT: '3' })],
        executor: [mock('executor', 'ex', 'executor.mjs', { EXEC_STATUS: 'done' })],
        gate: [mock('gate', 'g', 'gate.mjs', { GATE_MODE: 'fail' })],
        onFail: [mock('on-fail', 'rec', 'on-fail.mjs')],
      },
      { config: { retryThreshold: 3 } },
    );
    const result = await runLoop(deps);
    expect(result.endReason).toBe('NO_TASK');
    expect(result.iterations.map((i) => i.outcome)).toEqual(['failed', 'failed', 'escalated']);
    expect(result.iterations[2]?.retryCount).toBe(3);
    const onfail = readFileSync(join(stateDir, 'onfail'), 'utf8').trim().split('\n');
    expect(onfail).toHaveLength(3);
  });

  it('stuck executor routes to the failure path without running the gate', async () => {
    const { deps } = rig({
      taskSource: [mock('task-source', 'ts', 'task-source.mjs', { TS_REPEAT: '1' })],
      executor: [mock('executor', 'ex', 'executor.mjs', { EXEC_STATUS: 'stuck' })],
      gate: [mock('gate', 'g', 'gate.mjs', { GATE_MODE: 'pass' })],
      onFail: [mock('on-fail', 'rec', 'on-fail.mjs')],
    });
    const result = await runLoop(deps);
    expect(result.iterations[0]).toEqual(expect.objectContaining({ executorStatus: 'stuck', outcome: 'failed' }));
    expect(existsSync(join(stateDir, 'gate'))).toBe(false); // gate never invoked
    expect(existsSync(join(stateDir, 'onfail'))).toBe(true);
  });

  it('budget exhaustion mid-run stops the loop', async () => {
    let iters = 0;
    const { deps } = rig(
      {
        taskSource: [mock('task-source', 'ts', 'task-source.mjs', { TS_REPEAT: '99' })],
        executor: [mock('executor', 'ex', 'executor.mjs', { EXEC_STATUS: 'done' })],
        gate: [mock('gate', 'g', 'gate.mjs', { GATE_MODE: 'pass' })],
      },
      { isBudgetOk: () => iters++ < 2 },
    );
    const result = await runLoop(deps);
    expect(result.endReason).toBe('BUDGET_EXCEEDED');
    expect(result.iterations.length).toBe(2);
  });

  it('STOP kill-switch appearing mid-run stops the loop', async () => {
    let seen = 0;
    const { deps } = rig(
      {
        taskSource: [mock('task-source', 'ts', 'task-source.mjs', { TS_REPEAT: '99' })],
        executor: [mock('executor', 'ex', 'executor.mjs', { EXEC_STATUS: 'done' })],
        gate: [mock('gate', 'g', 'gate.mjs', { GATE_MODE: 'pass' })],
      },
      { isStopPresent: () => seen++ >= 1 },
    );
    const result = await runLoop(deps);
    expect(result.endReason).toBe('STOP');
    expect(result.iterations).toHaveLength(1);
  });

  it('MAX_ITER caps the number of iterations', async () => {
    const { deps } = rig(
      {
        taskSource: [mock('task-source', 'ts', 'task-source.mjs', { TS_REPEAT: '99' })],
        executor: [mock('executor', 'ex', 'executor.mjs', { EXEC_STATUS: 'done' })],
        gate: [mock('gate', 'g', 'gate.mjs', { GATE_MODE: 'pass' })],
        sink: [mock('sink', 'log', 'sink.mjs', {}, 'L1')],
      },
      { config: { maxIter: 3 } },
    );
    const result = await runLoop(deps);
    expect(result.endReason).toBe('MAX_ITER');
    expect(result.iterations).toHaveLength(3);
  });
});
