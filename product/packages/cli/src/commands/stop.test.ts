import { expect, test, describe } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { stopCommand, resumeCommand } from './stop.js';
import { EXIT } from '../exit-codes.js';
import { memFs, captureStreams } from '../testkit.js';

function io(cap: ReturnType<typeof captureStreams>, json = false) {
  return createIo(cap.streams, { cwd: '/repo', json, quiet: false, verbose: false });
}

describe('stop / resume (T25)', () => {
  test('stop creates .halo/STOP and records the reason', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const parsed = parseArgs(['--reason', 'maintenance'], { valueFlags: ['reason'] });
    const code = await stopCommand(parsed, io(cap), { fs, now: 1_700_000_000_000 });
    expect(code).toBe(EXIT.OK);
    const body = fs.files.get('/repo/.halo/STOP');
    expect(body).toContain('reason: maintenance');
  });

  test('stop is idempotent — a second call updates and still exits 0', async () => {
    const fs = memFs();
    const cap = captureStreams();
    await stopCommand(parseArgs([], {}), io(cap), { fs, now: 1 });
    const cap2 = captureStreams();
    const code = await stopCommand(parseArgs([], {}), io(cap2), { fs, now: 2 });
    expect(code).toBe(EXIT.OK);
    expect(cap2.out()).toContain('更新');
  });

  test('resume removes STOP', async () => {
    const fs = memFs({ files: { '/repo/.halo/STOP': 'x' } });
    const cap = captureStreams();
    const code = await resumeCommand(parseArgs([], {}), io(cap), { fs, now: 0 });
    expect(code).toBe(EXIT.OK);
    expect(fs.files.has('/repo/.halo/STOP')).toBe(false);
  });

  test('resume is idempotent when STOP is absent', async () => {
    const fs = memFs();
    const cap = captureStreams();
    const code = await resumeCommand(parseArgs([], {}), io(cap), { fs, now: 0 });
    expect(code).toBe(EXIT.OK);
    expect(cap.out()).toContain('STOP はありません');
  });
});
