// entry契約化 (Task 6 Step C) のリグレッション: listTriggers は `.halo/ports/trigger.d/<name>/fire`
// ではなく plugin.json の `aux.fire` (halo enable が絶対パス化済み) の実在で生存判定する。
import { expect, test, describe, vi } from 'vitest';
import {
  installTrigger,
  uninstallTrigger,
  listTriggers,
  type TriggerContext,
  type SpawnAdapter,
} from './triggers.js';
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

describe('installTrigger/uninstallTrigger (entry契約化)', () => {
  function pluginJson(aux: Record<string, string>): string {
    return JSON.stringify({
      name: '@halo/plugin-trigger-polling',
      version: '1.0.0',
      port: 'trigger',
      entry: aux['fire'] ?? './fire.js',
      aux,
    });
  }

  test('install: argv は process.execPath + aux.install の解決パス + profile', async () => {
    const fs = memFs({
      files: {
        '/repo/.halo/ports/trigger.d/trigger-polling/plugin.json': pluginJson({
          fire: './fire.js',
          install: './install.js',
          uninstall: './uninstall.js',
        }),
      },
    });
    const spawn = vi.fn<SpawnAdapter>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const c: TriggerContext = { haloDir: '/repo/.halo', cwd: '/repo', fs, spawn };

    await installTrigger(c, 'trigger-polling', 'smoke');

    expect(spawn).toHaveBeenCalledTimes(1);
    const [script, args] = spawn.mock.calls[0]!;
    expect(script).toBe(process.execPath);
    expect(args).toEqual([
      '/repo/.halo/ports/trigger.d/trigger-polling/install.js',
      'smoke',
    ]);
  });

  test('install: env に HALO_PLUGIN_DIR がアダプタディレクトリの絶対パスで入る', async () => {
    const fs = memFs({
      files: {
        '/repo/.halo/ports/trigger.d/trigger-polling/plugin.json': pluginJson({
          fire: './fire.js',
          install: './install.js',
        }),
      },
    });
    const spawn = vi.fn<SpawnAdapter>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const c: TriggerContext = { haloDir: '/repo/.halo', cwd: '/repo', fs, spawn };

    await installTrigger(c, 'trigger-polling', 'smoke');

    const [, , env] = spawn.mock.calls[0]!;
    expect(env).toMatchObject({
      HALO_PLUGIN_DIR: '/repo/.halo/ports/trigger.d/trigger-polling',
    });
  });

  test('uninstall: argv は process.execPath + aux.uninstall の解決パス + profile', async () => {
    const fs = memFs({
      files: {
        '/repo/.halo/ports/trigger.d/trigger-polling/plugin.json': pluginJson({
          fire: './fire.js',
          uninstall: './uninstall.js',
        }),
      },
    });
    const spawn = vi.fn<SpawnAdapter>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const c: TriggerContext = { haloDir: '/repo/.halo', cwd: '/repo', fs, spawn };

    await uninstallTrigger(c, 'trigger-polling', 'smoke');

    const [script, args] = spawn.mock.calls[0]!;
    expect(script).toBe(process.execPath);
    expect(args).toEqual([
      '/repo/.halo/ports/trigger.d/trigger-polling/uninstall.js',
      'smoke',
    ]);
  });

  test('install: plugin.json に aux.install が無ければ fail-fast', async () => {
    const fs = memFs({
      files: {
        '/repo/.halo/ports/trigger.d/trigger-polling/plugin.json': pluginJson({
          fire: './fire.js',
        }),
      },
    });
    const spawn = vi.fn<SpawnAdapter>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const c: TriggerContext = { haloDir: '/repo/.halo', cwd: '/repo', fs, spawn };

    await expect(installTrigger(c, 'trigger-polling', 'smoke')).rejects.toThrow(/aux\.install/);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('install: plugin.json 自体が無ければ fail-fast', async () => {
    const fs = memFs({ dirs: ['/repo/.halo/ports/trigger.d/trigger-polling'] });
    const spawn = vi.fn<SpawnAdapter>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const c: TriggerContext = { haloDir: '/repo/.halo', cwd: '/repo', fs, spawn };

    await expect(installTrigger(c, 'trigger-polling', 'smoke')).rejects.toThrow(
      /plugin\.json not found/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  test('install: 未知のアダプタ名は fail-fast', async () => {
    const fs = memFs();
    const spawn = vi.fn<SpawnAdapter>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const c: TriggerContext = { haloDir: '/repo/.halo', cwd: '/repo', fs, spawn };

    await expect(installTrigger(c, 'no-such-trigger', 'smoke')).rejects.toThrow(
      /unknown trigger adapter/,
    );
  });

  test('install: 実FSで .sh が存在しない前提(halo enable 後の絶対パス aux)でも entry 契約のみで解決成功する', async () => {
    // halo enable 後の実配置相当の fixture (D11 §3): aux はいずれも dist ルート起点の絶対パス。
    // .sh ランチャーは一切登場しない。
    const fs = memFs({
      files: {
        '/repo/.halo/ports/trigger.d/trigger-polling/plugin.json': JSON.stringify({
          name: '@halo/plugin-trigger-polling',
          version: '1.0.0',
          port: 'trigger',
          entry: '/opt/halo/packages/plugins/dist/trigger-polling/fire.js',
          aux: {
            fire: '/opt/halo/packages/plugins/dist/trigger-polling/fire.js',
            install: '/opt/halo/packages/plugins/dist/trigger-polling/install.js',
            uninstall: '/opt/halo/packages/plugins/dist/trigger-polling/uninstall.js',
          },
        }),
      },
    });
    const spawn = vi.fn<SpawnAdapter>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const c: TriggerContext = { haloDir: '/repo/.halo', cwd: '/repo', fs, spawn };

    const result = await installTrigger(c, 'trigger-polling', 'smoke');

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    const [script, args] = spawn.mock.calls[0]!;
    expect(script).toBe(process.execPath);
    expect(args).toEqual([
      '/opt/halo/packages/plugins/dist/trigger-polling/install.js',
      'smoke',
    ]);
  });
});
