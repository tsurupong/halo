// entry契約化 (Task 6 Step C) のリグレッション: listTriggers は `.halo/ports/trigger.d/<name>/fire`
// ではなく plugin.json の `aux.fire` (halo enable が絶対パス化済み) の実在で生存判定する。
import { expect, test, describe } from 'vitest';
import { listTriggers, type TriggerContext } from './triggers.js';
import { memFs } from './testkit.js';

function ctx(fs: ReturnType<typeof memFs>): TriggerContext {
  return {
    haloDir: '/repo/.halo',
    cwd: '/repo',
    fs,
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  };
}

describe('listTriggers (entry契約化後)', () => {
  test('aux.fire が絶対パスで実在 → alive', async () => {
    const fs = memFs({
      files: {
        '/repo/.halo/ports/trigger.d/trigger-polling/plugin.json': JSON.stringify({
          name: '@halo/plugin-trigger-polling',
          version: '1.0.0',
          port: 'trigger',
          entry: '/dist/trigger-polling/fire.js',
          aux: {
            fire: '/dist/trigger-polling/fire.js',
            install: '/dist/trigger-polling/install.js',
            uninstall: '/dist/trigger-polling/uninstall.js',
          },
        }),
        '/dist/trigger-polling/fire.js': '// stub',
      },
    });
    const entries = await listTriggers(ctx(fs));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      name: 'trigger-polling',
      fire: '/dist/trigger-polling/fire.js',
      alive: true,
    });
  });

  test('aux.fire が絶対パスだが実体が存在しない → dead', async () => {
    const fs = memFs({
      files: {
        '/repo/.halo/ports/trigger.d/trigger-schedule/plugin.json': JSON.stringify({
          name: '@halo/plugin-trigger-schedule',
          version: '1.0.0',
          port: 'trigger',
          entry: '/dist/trigger-schedule/fire.js',
          aux: { fire: '/dist/trigger-schedule/fire.js' },
        }),
      },
    });
    const entries = await listTriggers(ctx(fs));
    expect(entries).toEqual([
      { name: 'trigger-schedule', fire: '/dist/trigger-schedule/fire.js', alive: false },
    ]);
  });

  test('aux.fire が plugin.json 相対パス → アダプタディレクトリ起点で解決', async () => {
    const fs = memFs({
      files: {
        '/repo/.halo/ports/trigger.d/trigger-polling/plugin.json': JSON.stringify({
          name: '@halo/plugin-trigger-polling',
          version: '1.0.0',
          port: 'trigger',
          entry: './fire.js',
          aux: { fire: './fire.js' },
        }),
        '/repo/.halo/ports/trigger.d/trigger-polling/fire.js': '// stub',
      },
    });
    const entries = await listTriggers(ctx(fs));
    expect(entries).toEqual([
      {
        name: 'trigger-polling',
        fire: '/repo/.halo/ports/trigger.d/trigger-polling/fire.js',
        alive: true,
      },
    ]);
  });

  test('plugin.json が存在しない/壊れている → dead', async () => {
    const fs = memFs({
      dirs: ['/repo/.halo/ports/trigger.d/trigger-broken'],
      files: {
        '/repo/.halo/ports/trigger.d/trigger-invalid-json/plugin.json': 'not json',
      },
    });
    const entries = await listTriggers(ctx(fs));
    expect(entries.every((e) => e.alive === false)).toBe(true);
    expect(entries.map((e) => e.name).sort()).toEqual(['trigger-broken', 'trigger-invalid-json']);
  });

  test('trigger.d が存在しない → 空配列', async () => {
    const fs = memFs();
    expect(await listTriggers(ctx(fs))).toEqual([]);
  });
});
