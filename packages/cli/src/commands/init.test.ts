import { expect, test, describe } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { initCommand } from './init.js';
import { EXIT } from '../exit-codes.js';
import { memFs, captureStreams } from '../testkit.js';

function io(cap: ReturnType<typeof captureStreams>, opts: { json?: boolean } = {}) {
  return createIo(cap.streams, {
    cwd: '/repo',
    json: opts.json ?? false,
    quiet: false,
    verbose: false,
  });
}

const RESOLVE_PLUGINS_PKG_JSON = () => '/fake/node_modules/@tsurupong/halo-plugins/package.json';

describe('project init (T24)', () => {
  test('generates .harness.yml, skeleton, profiles, prompt, and .gitignore', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const parsed = parseArgs(['init'], {});
    const code = await initCommand(parsed, io(cap), {
      fs,
      resolvePluginsPackageJson: RESOLVE_PLUGINS_PKG_JSON,
    });
    expect(code).toBe(EXIT.OK);
    expect(fs.files.has('/repo/.harness.yml')).toBe(true);
    expect(fs.files.has('/repo/.halo/profiles/continuous.env')).toBe(true);
    expect(fs.files.has('/repo/.halo/profiles/daytime-l1.env')).toBe(true);
    expect(fs.files.has('/repo/.halo/profiles/nightly.env')).toBe(true);
    expect(fs.files.has('/repo/.halo/prompts/code.md')).toBe(true);
    expect(fs.files.has('/repo/.halo/ports/trigger.d/.gitkeep')).toBe(true);
    expect(fs.files.get('/repo/.gitignore')).toContain('.halo/');
  });

  test('is idempotent — a second run creates nothing and preserves content', async () => {
    const fs = memFs();
    const cap = captureStreams();
    await initCommand(parseArgs(['init'], {}), io(cap), {
      fs,
      resolvePluginsPackageJson: RESOLVE_PLUGINS_PKG_JSON,
    });
    fs.files.set('/repo/.harness.yml', 'CUSTOM');
    const cap2 = captureStreams();
    await initCommand(parseArgs(['init'], {}), io(cap2), {
      fs,
      resolvePluginsPackageJson: RESOLVE_PLUGINS_PKG_JSON,
    });
    expect(fs.files.get('/repo/.harness.yml')).toBe('CUSTOM');
    expect(cap2.out()).toContain('既に初期化済み');
  });

  test('ADR-0027: 既定で on-fail-record + context-recent-failures の plugin.json を生成する', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const code = await initCommand(parseArgs(['init'], {}), io(cap), {
      fs,
      resolvePluginsPackageJson: RESOLVE_PLUGINS_PKG_JSON,
    });
    expect(code).toBe(EXIT.OK);

    const recordPath = '/repo/.halo/ports/on-fail.d/on-fail-record/plugin.json';
    const contextPath = '/repo/.halo/ports/context.d/context-recent-failures/plugin.json';
    expect(fs.files.has(recordPath)).toBe(true);
    expect(fs.files.has(contextPath)).toBe(true);

    const recordManifest = JSON.parse(fs.files.get(recordPath)!);
    expect(recordManifest.entry).toBe(
      '/fake/node_modules/@tsurupong/halo-plugins/dist/on-fail-record/main.js',
    );
    const contextManifest = JSON.parse(fs.files.get(contextPath)!);
    expect(contextManifest.entry).toBe(
      '/fake/node_modules/@tsurupong/halo-plugins/dist/context-recent-failures/main.js',
    );
  });

  test('ADR-0027: 2回目の init でも既定プラグインの内容は不変 (冪等)', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const run = () =>
      initCommand(parseArgs(['init'], {}), io(cap), {
        fs,
        resolvePluginsPackageJson: RESOLVE_PLUGINS_PKG_JSON,
      });
    await run();
    const recordPath = '/repo/.halo/ports/on-fail.d/on-fail-record/plugin.json';
    const before = fs.files.get(recordPath);
    await run();
    expect(fs.files.get(recordPath)).toBe(before);
  });

  test('ADR-0027: @tsurupong/halo-plugins の解決に失敗しても scaffold 結果は返す (fatal にしない)', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const code = await initCommand(parseArgs(['init'], {}), io(cap), {
      fs,
      resolvePluginsPackageJson: () => {
        throw new Error('module not found');
      },
    });
    expect(code).toBe(EXIT.OK);
    expect(fs.files.has('/repo/.harness.yml')).toBe(true);
    expect(fs.files.has('/repo/.halo/ports/on-fail.d/on-fail-record/plugin.json')).toBe(false);
    expect(cap.out() + cap.err()).toContain('module not found');
  });

  test('--kind docs adds a docs prompt and kind', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const parsed = parseArgs(['init', '--kind', 'docs'], {
      valueFlags: ['kind'],
      repeatFlags: ['kind'],
    });
    await initCommand(parsed, io(cap), { fs });
    expect(fs.files.has('/repo/.halo/prompts/docs.md')).toBe(true);
    expect(fs.files.get('/repo/.harness.yml')).toContain('docs:');
  });

  test('--no-gitignore skips the .gitignore append', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const parsed = parseArgs(['init', '--no-gitignore'], {});
    await initCommand(parsed, io(cap), { fs });
    expect(fs.files.has('/repo/.gitignore')).toBe(false);
  });

  test('--json emits a machine-readable summary', async () => {
    const fs = memFs();
    const cap = captureStreams();
    await initCommand(parseArgs(['init'], {}), io(cap, { json: true }), { fs });
    const parsed = JSON.parse(cap.out());
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.created)).toBe(true);
  });

  test('unknown project subcommand is a usage error (exit 3)', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const code = await initCommand(parseArgs(['bogus'], {}), io(cap), { fs });
    expect(code).toBe(EXIT.USAGE);
  });
});
