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

describe('project init (T24)', () => {
  test('generates .harness.yml, skeleton, profiles, prompt, and .gitignore', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const parsed = parseArgs(['init'], {});
    const code = await initCommand(parsed, io(cap), { fs });
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
    await initCommand(parseArgs(['init'], {}), io(cap), { fs });
    fs.files.set('/repo/.harness.yml', 'CUSTOM');
    const cap2 = captureStreams();
    await initCommand(parseArgs(['init'], {}), io(cap2), { fs });
    expect(fs.files.get('/repo/.harness.yml')).toBe('CUSTOM');
    expect(cap2.out()).toContain('既に初期化済み');
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
