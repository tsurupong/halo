import { expect, test, describe } from 'vitest';
import { run, CLI_VERSION } from './index.js';
import { EXIT } from './exit-codes.js';
import type { Streams } from './io.js';

function capture(): { streams: Streams; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    streams: { out: (t) => (out += t), err: (t) => (err += t) },
    out: () => out,
    err: () => err,
  };
}

describe('top-level dispatch (T22)', () => {
  test('--version prints version to stdout and exits 0', async () => {
    const cap = capture();
    const code = await run(['--version'], { streams: cap.streams, now: 0 });
    expect(code).toBe(EXIT.OK);
    expect(cap.out()).toBe(`halo ${CLI_VERSION}\n`);
    expect(cap.err()).toBe('');
  });

  test('--help prints usage to stdout and exits 0', async () => {
    const cap = capture();
    const code = await run(['--help'], { streams: cap.streams, now: 0 });
    expect(code).toBe(EXIT.OK);
    expect(cap.out()).toContain('usage: halo <command>');
  });

  test('no command prints help and exits 0', async () => {
    const cap = capture();
    const code = await run([], { streams: cap.streams, now: 0 });
    expect(code).toBe(EXIT.OK);
    expect(cap.out()).toContain('commands:');
  });

  test('unknown command maps to exit 3 with error on stderr', async () => {
    const cap = capture();
    const code = await run(['frobnicate'], { streams: cap.streams, now: 0 });
    expect(code).toBe(EXIT.USAGE);
    expect(cap.err()).toContain("unknown command 'frobnicate'");
    expect(cap.out()).toBe('');
  });

  test('stdout and stderr are separated (help never touches stderr)', async () => {
    const cap = capture();
    await run(['--help'], { streams: cap.streams, now: 0 });
    expect(cap.err()).toBe('');
  });
});
