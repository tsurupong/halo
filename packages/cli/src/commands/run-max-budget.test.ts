// H1: D3 §2.1 / Appendix A が規定する `--max-budget-usd` が値フラグとして登録されて
// いなかったため、`halo run nightly --max-budget-usd 5` の 5 は positional に落ちて
// 黙って捨てられていた (args.ts は未知フラグを bool 扱いにし、余剰 positional も検証
// しない)。無人運転のコスト上限が無言で効かないのが問題の本体なので、
// 「パーサが値として受ける」と「config まで届く」を両方固定する。
import { describe, expect, test } from 'vitest';
import { parseArgs } from '../args.js';
import { VALUE_FLAGS } from '../index.js';
import { buildOverrides, RUN_VALUE_FLAGS } from './run.js';
import { resolveConfig } from '@tsurupong/halo-core';

function parse(argv: string[]) {
  return parseArgs(argv, { valueFlags: VALUE_FLAGS });
}

describe('--max-budget-usd wiring (ADR-0021 / D3 §2.1)', () => {
  test('is registered as a value flag in both flag tables', () => {
    expect(VALUE_FLAGS).toContain('max-budget-usd');
    expect(RUN_VALUE_FLAGS).toContain('max-budget-usd');
  });

  test('the value is parsed as a flag, not dropped into positionals', () => {
    const parsed = parse(['nightly', '--max-budget-usd', '5']);
    expect(parsed.positionals).toEqual(['nightly']);
    expect(parsed.flags['max-budget-usd']).toBe('5');
  });

  test('the = form works too', () => {
    expect(parse(['nightly', '--max-budget-usd=2.5']).flags['max-budget-usd']).toBe('2.5');
  });

  test('buildOverrides forwards it', () => {
    expect(buildOverrides(parse(['nightly', '--max-budget-usd', '5'])).maxBudgetUsd).toBe('5');
  });

  test('the flag beats the profile value (CLI > profile > defaults)', () => {
    const config = resolveConfig({
      profileEnv: { AUTONOMY: 'L1', MAX_ITER: '5', TIMEOUT: '1h', MAX_BUDGET_USD: '20' },
      cli: buildOverrides(parse(['nightly', '--max-budget-usd', '3'])),
    });
    expect(config.maxBudgetUsd).toBe(3);
  });

  test('the profile value still applies when the flag is absent', () => {
    const config = resolveConfig({
      profileEnv: { AUTONOMY: 'L1', MAX_ITER: '5', TIMEOUT: '1h', MAX_BUDGET_USD: '20' },
      cli: buildOverrides(parse(['nightly'])),
    });
    expect(config.maxBudgetUsd).toBe(20);
  });

  test('a non-positive value is a configuration error, not silently ignored', () => {
    expect(() =>
      resolveConfig({
        profileEnv: { AUTONOMY: 'L1', MAX_ITER: '5', TIMEOUT: '1h' },
        cli: buildOverrides(parse(['nightly', '--max-budget-usd', '0'])),
      }),
    ).toThrow(/MAX_BUDGET_USD/);
  });
});
