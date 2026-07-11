import { expect, test, describe } from 'vitest';
import { parseArgs, stringFlag, boolFlag, arrayFlag } from './args.js';

describe('parseArgs (T22)', () => {
  test('separates positionals from flags', () => {
    const p = parseArgs(['run', 'nightly', '--max-iter', '5'], { valueFlags: ['max-iter'] });
    expect(p.positionals).toEqual(['run', 'nightly']);
    expect(p.flags['max-iter']).toBe('5');
  });

  test('supports --flag=value form', () => {
    const p = parseArgs(['--cwd=/repo'], { valueFlags: ['cwd'] });
    expect(p.flags.cwd).toBe('/repo');
  });

  test('bool flags default to true', () => {
    const p = parseArgs(['--json']);
    expect(p.flags.json).toBe(true);
  });

  test('short aliases map to canonical names', () => {
    const p = parseArgs(['-q', '-v', '-h']);
    expect(p.flags.quiet).toBe(true);
    expect(p.flags.verbose).toBe(true);
    expect(p.flags.help).toBe(true);
  });

  test('--no-<flag> sets it false', () => {
    const p = parseArgs(['--no-gitignore']);
    expect(p.flags.gitignore).toBe(false);
    expect(boolFlag(p, 'gitignore', true)).toBe(false);
  });

  test('repeat flags collect into an array', () => {
    const p = parseArgs(['--kind', 'code', '--kind', 'docs'], {
      valueFlags: ['kind'],
      repeatFlags: ['kind'],
    });
    expect(arrayFlag(p, 'kind')).toEqual(['code', 'docs']);
  });

  test('value flag missing its value is a usage error', () => {
    expect(() => parseArgs(['--max-iter'], { valueFlags: ['max-iter'] })).toThrow(
      /requires a value/,
    );
  });

  test('-- ends flag parsing', () => {
    const p = parseArgs(['a', '--', '--not-a-flag'], {});
    expect(p.positionals).toEqual(['a', '--not-a-flag']);
  });

  test('stringFlag returns undefined for bool/absent', () => {
    const p = parseArgs(['--json']);
    expect(stringFlag(p, 'json')).toBeUndefined();
    expect(stringFlag(p, 'missing')).toBeUndefined();
  });
});
