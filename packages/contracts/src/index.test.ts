// Type-level conformance (T06/T07) + export wiring (T10). The `@ts-expect-error`
// assertions are validated by `tsc -b` (which type-checks test files); a missing
// required field must be a compile error. The JSON subpath imports prove the
// generated schemas are reachable via the `@halo/contracts/<port>.<io>.json`
// export (D1 §6.2).

import { expect, test } from 'vitest';
import type {
  ContextOut,
  ExecutorIn,
  ExecutorOut,
  GateOut,
  OnFailIn,
  PluginManifest,
  TaskSourceIn,
  TaskSourceOut,
} from './index.js';

// Generated schemas, imported through the public JSON subpath export.
import gateOutSchema from '@halo/contracts/gate.out.json' with { type: 'json' };
import pluginSchema from '@halo/contracts/plugin.json' with { type: 'json' };
import taskSourceInSchema from '@halo/contracts/task-source.in.json' with { type: 'json' };

test('valid port I/O values type-check', () => {
  const nextTask: TaskSourceOut = { task_id: 'T-012', title: 'x', kind: 'code' };
  const noTask: TaskSourceOut = { task_id: null };
  const input: TaskSourceIn = { op: 'complete', task_id: 'T-1', pr_url: 'https://x/pr/1' };
  const ctx: ContextOut = { fragments: [{ source: 'codegraph', content: 'c', priority: 10 }] };
  const exIn: ExecutorIn = { prompt: 'p', workdir: '/w', budget: { max_turns: 40, timeout_sec: 900 } };
  const exOut: ExecutorOut = { status: 'done', summary: 's' };
  const gate: GateOut = { reason: 'coverage 87% < 90%' };
  const onFail: OnFailIn = { task_id: 'T-1', reason: 'r', retry_count: 0 };
  const manifest: PluginManifest = {
    name: '@halo/plugin-sink-progress-log',
    version: '1.0.0',
    port: 'sink',
    exec: './20-progress-log.sh',
    minAutonomy: 'L1',
  };

  expect(nextTask.task_id).toBe('T-012');
  expect(noTask.task_id).toBeNull();
  expect(input.op).toBe('complete');
  expect(ctx.fragments[0]?.priority).toBe(10);
  expect(exIn.budget.timeout_sec).toBe(900);
  expect(exOut.status).toBe('done');
  expect(gate.reason).toContain('coverage');
  expect(onFail.retry_count).toBe(0);
  expect(manifest.port).toBe('sink');
});

test('missing required fields are compile errors', () => {
  // @ts-expect-error task_id is required on TaskSourceOut
  const missingTaskId: TaskSourceOut = { title: 'no id' };
  // @ts-expect-error status is required on ExecutorOut
  const missingStatus: ExecutorOut = { summary: 'no status' };
  // @ts-expect-error port is required on PluginManifest
  const missingPort: PluginManifest = { name: 'x', version: '1.0.0', exec: './x.sh' };
  // @ts-expect-error 'L4' is not a valid MinAutonomy
  const badAutonomy: PluginManifest['minAutonomy'] = 'L4';

  expect(missingTaskId).toBeDefined();
  expect(missingStatus).toBeDefined();
  expect(missingPort).toBeDefined();
  expect(badAutonomy).toBe('L4');
});

test('generated schemas are reachable via the JSON subpath export', () => {
  expect(gateOutSchema.$id).toBe('https://halo.dev/contracts/gate.out.json');
  expect(pluginSchema.$id).toBe('https://halo.dev/contracts/plugin.json');
  expect(taskSourceInSchema.$id).toBe('https://halo.dev/contracts/task-source.in.json');

  // The plugin.json schema carries D1's port enum (8 values) and semver pattern.
  expect(pluginSchema.properties.port.enum).toHaveLength(8);
  expect(pluginSchema.required).toContain('exec');
});
