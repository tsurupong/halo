import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, test, describe, afterEach } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { createNodeCliFs } from '../core-ext/fs.js';
import { enableCommand } from './enable.js';
import { EXIT } from '../exit-codes.js';
import { memFs, captureStreams } from '../testkit.js';

function io(cap: ReturnType<typeof captureStreams>, cwd: string) {
  return createIo(cap.streams, { cwd, json: false, quiet: false, verbose: false });
}

// テスト用に固定した @tsurupong/halo-plugins の package.json 絶対パス (repo 実 dist を指す)。
const REPO_PLUGINS_PKG_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'plugins',
  'package.json',
);

describe('halo enable (entry契約化 Task 6)', () => {
  test('unknown plugin name is a usage error and lists available plugins', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const code = await enableCommand(parseArgs(['bogus'], {}), io(cap, '/repo'), {
      fs,
      resolvePluginsPackageJson: () => '/fake/node_modules/@tsurupong/halo-plugins/package.json',
    });
    expect(code).toBe(EXIT.USAGE);
    expect(cap.err()).toContain("unknown plugin 'bogus'");
    expect(cap.err()).toContain('sink-progress-log');
  });

  test('no args lists available plugins and exits 0', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const code = await enableCommand(parseArgs([], {}), io(cap, '/repo'), {
      fs,
      resolvePluginsPackageJson: () => '/fake/node_modules/@tsurupong/halo-plugins/package.json',
    });
    expect(code).toBe(EXIT.OK);
    expect(cap.err()).toContain('sink-progress-log');
  });

  test('generates plugin.json only, with entry/aux rewritten to absolute dist paths', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const code = await enableCommand(parseArgs(['sink-progress-log'], {}), io(cap, '/repo'), {
      fs,
      resolvePluginsPackageJson: () => '/fake/node_modules/@tsurupong/halo-plugins/package.json',
    });
    expect(code).toBe(EXIT.OK);

    const dir = '/repo/.halo/ports/sink.d/sink-progress-log';
    expect(fs.files.has(`${dir}/plugin.json`)).toBe(true);
    const manifest = JSON.parse(fs.files.get(`${dir}/plugin.json`)!);
    expect(manifest.name).toBe('@halo/plugin-sink-progress-log');
    expect(manifest.env).toBeUndefined();
    expect(manifest.entry).toBe(
      '/fake/node_modules/@tsurupong/halo-plugins/dist/sink-progress-log/main.js',
    );

    // .sh ファイルは一切生成されない。
    const generated = [...fs.files.keys()].filter((p) => p.startsWith(dir));
    expect(generated).toEqual([`${dir}/plugin.json`]);
    expect(generated.some((p) => p.endsWith('.sh'))).toBe(false);

    expect(cap.err()).toContain(`enabled sink-progress-log -> ${dir}`);
  });

  test('gate-runtime-check-typecheck resolves HALO_RUNTIME_DIR to an absolute .halo/ports path', async () => {
    const fs = memFs();
    const cap = captureStreams();
    await enableCommand(parseArgs(['gate-runtime-check-typecheck'], {}), io(cap, '/repo'), {
      fs,
      resolvePluginsPackageJson: () => '/fake/node_modules/@tsurupong/halo-plugins/package.json',
    });
    const dir = '/repo/.halo/ports/gate.d/gate-runtime-check-typecheck';
    const manifest = JSON.parse(fs.files.get(`${dir}/plugin.json`)!);
    expect(manifest.env).toEqual({
      HALO_RUNTIME_DIR: '/repo/.halo/ports/runtime.d/runtime-node-pnpm',
    });
  });

  test('aux entries (e.g. trigger fire/install/uninstall) are also absolutized', async () => {
    const fs = memFs();
    const cap = captureStreams();
    await enableCommand(parseArgs(['trigger-polling'], {}), io(cap, '/repo'), {
      fs,
      resolvePluginsPackageJson: () => '/fake/node_modules/@tsurupong/halo-plugins/package.json',
    });
    const dir = '/repo/.halo/ports/trigger.d/trigger-polling';
    const manifest = JSON.parse(fs.files.get(`${dir}/plugin.json`)!);
    expect(manifest.aux.fire).toBe(
      '/fake/node_modules/@tsurupong/halo-plugins/dist/trigger-polling/fire.js',
    );
    expect(manifest.aux.install).toBe(
      '/fake/node_modules/@tsurupong/halo-plugins/dist/trigger-polling/install.js',
    );
    expect(manifest.aux.uninstall).toBe(
      '/fake/node_modules/@tsurupong/halo-plugins/dist/trigger-polling/uninstall.js',
    );
  });

  test('is idempotent — re-running overwrites the same plugin.json without duplication', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const run = () =>
      enableCommand(parseArgs(['runtime-node-pnpm'], {}), io(cap, '/repo'), {
        fs,
        resolvePluginsPackageJson: () => '/fake/node_modules/@tsurupong/halo-plugins/package.json',
      });
    await run();
    const dir = '/repo/.halo/ports/runtime.d/runtime-node-pnpm';
    const before = fs.files.get(`${dir}/plugin.json`);
    await run();
    const after = fs.files.get(`${dir}/plugin.json`);
    expect(after).toBe(before);
    const generated = [...fs.files.keys()].filter((p) => p.startsWith(dir));
    expect(generated).toEqual([`${dir}/plugin.json`]);
  });

  describe('generated plugin.json entry actually runs (real fs + node)', () => {
    let tmp: string | undefined;

    afterEach(async () => {
      if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    test('sink-progress-log entry executes via node and writes a log line', async () => {
      tmp = await mkdtemp(join(tmpdir(), 'halo-enable-'));
      const cap = captureStreams();
      const code = await enableCommand(parseArgs(['sink-progress-log'], {}), io(cap, tmp), {
        fs: createNodeCliFs(),
        resolvePluginsPackageJson: () => REPO_PLUGINS_PKG_JSON,
      });
      expect(code).toBe(EXIT.OK);

      const manifestPath = join(
        tmp,
        '.halo',
        'ports',
        'sink.d',
        'sink-progress-log',
        'plugin.json',
      );
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const logsDir = join(tmp, 'logs');
      const input = JSON.stringify({ task_id: 't-1', workdir: tmp, summary: 'hello from test' });

      execFileSync(process.execPath, [manifest.entry], {
        input,
        encoding: 'utf8',
        env: { ...process.env, HALO_LOGS_DIR: logsDir },
      });

      const { readdir } = await import('node:fs/promises');
      const files = await readdir(logsDir).catch(() => []);
      expect(files.length).toBeGreaterThan(0);
      const entries = await readFile(join(logsDir, files[0]!), 'utf8');
      expect(entries).toContain('hello from test');
    });
  });
});
