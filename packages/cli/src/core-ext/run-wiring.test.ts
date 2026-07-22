// run-wiring の makeRunner 単体テスト (entry 契約, ADR-0018)。プラグイン子プロセスが
// 常に `spawn(process.execPath, [entryPath], …)` で起動され、env に HALO_PLUGIN_DIR が
// 注入されることを、runPort が使う node:child_process.spawn シームをモックして検証する
// (実プロセスを起動せず、渡された引数だけを確認する)。
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DiscoveredPlugin } from '@tsurupong/halo-core';
import type { RunContext } from '../commands/run.js';

const spawnCalls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter & { end: (data: string) => void };
    };
    child.stdout = new EventEmitter();
    (child.stdout as unknown as { setEncoding: (enc: string) => void }).setEncoding = () => undefined;
    child.stderr = new EventEmitter();
    (child.stderr as unknown as { setEncoding: (enc: string) => void }).setEncoding = () => undefined;
    child.stdin = Object.assign(new EventEmitter(), { end: () => undefined });
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  },
}));

const { makeRunner } = await import('./run-wiring.js');

function plugin(overrides: Partial<DiscoveredPlugin> = {}): DiscoveredPlugin {
  return {
    port: 'gate',
    name: 'g1',
    dirName: 'g1',
    dir: '/repo/.halo/ports/gate.d/g1',
    entryPath: '/repo/.halo/ports/gate.d/g1/dist/main.js',
    order: 0,
    manifest: { name: 'g1', version: '1.0.0', port: 'gate', entry: 'dist/main.js' },
    ...overrides,
  };
}

function ctx(): RunContext {
  return {
    config: { autonomy: 'L1', maxIter: 20, timeoutSec: 3600 },
    haloDir: '/repo/.halo',
    cwd: '/repo',
    now: 0,
  } as unknown as RunContext;
}

describe('makeRunner (entry contract, ADR-0018)', () => {
  it('spawns process.execPath with [entryPath] and injects HALO_PLUGIN_DIR', async () => {
    spawnCalls.length = 0;
    const runner = makeRunner(ctx());
    const p = plugin();
    await runner(p, { hello: 'world' });

    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.command).toBe(process.execPath);
    expect(call.args).toEqual([p.entryPath]);
    const env = call.options['env'] as Record<string, string>;
    expect(env['HALO_PLUGIN_DIR']).toBe(p.dir);
  });

  it('injects HALO_SETTINGS_FILE only for the executor port (ADR-0019)', async () => {
    spawnCalls.length = 0;
    const runner = makeRunner(ctx(), { executorSettingsFile: '/repo/.halo/settings/executor-settings.json' });
    await runner(plugin({ port: 'executor' }), {});
    await runner(plugin({ port: 'gate' }), {});

    expect(spawnCalls).toHaveLength(2);
    const execEnv = spawnCalls[0]!.options['env'] as Record<string, string>;
    const gateEnv = spawnCalls[1]!.options['env'] as Record<string, string>;
    expect(execEnv['HALO_SETTINGS_FILE']).toBe('/repo/.halo/settings/executor-settings.json');
    expect(gateEnv['HALO_SETTINGS_FILE']).toBeUndefined();
  });
});
