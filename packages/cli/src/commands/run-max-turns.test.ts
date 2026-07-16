// `halo run --max-turns` フラグの写像 (fix/executor-max-turns) の新規テスト。
import { describe, expect, test } from 'vitest';
import { parseArgs } from '../args.js';
import { buildOverrides, RUN_VALUE_FLAGS } from './run.js';

describe('run --max-turns override', () => {
  test('flag is declared and mapped into CliOverrides.maxTurns', () => {
    expect(RUN_VALUE_FLAGS).toContain('max-turns');
    const parsed = parseArgs(['nightly', '--max-turns', '150'], {
      valueFlags: [...RUN_VALUE_FLAGS],
    });
    expect(buildOverrides(parsed).maxTurns).toBe('150');
  });

  test('absent flag leaves maxTurns undefined (loop default 40 applies)', () => {
    const parsed = parseArgs(['nightly'], { valueFlags: [...RUN_VALUE_FLAGS] });
    expect(buildOverrides(parsed).maxTurns).toBeUndefined();
  });
});
