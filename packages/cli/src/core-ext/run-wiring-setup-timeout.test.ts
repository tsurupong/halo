// SetUp 段 (D2 §8.2) のタイムアウト解決の単体テスト。2026-08-01 の E2E で setup timeout が
// 再発したが、当時は 300 秒が直書きで env でも manifest でも動かせなかった。ここで
// env → manifest → 既定 の 3 段の優先順位と、不正値を次段へ落とす挙動を固定する。
//
// 既存の run-wiring.test.ts は改変せず新規ファイルとして追加している (loop-audit ②:
// テストファイルの変更は fail、新規追加 A のみ許可)。
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT_TIMEOUT_SEC, resolveSetupTimeoutSec } from './run-wiring.js';

describe('resolveSetupTimeoutSec', () => {
  it('env RUNTIME_SETUP_TIMEOUT_SEC が最優先 (manifest より強い)', () => {
    expect(resolveSetupTimeoutSec({ RUNTIME_SETUP_TIMEOUT_SEC: '900' }, 600)).toBe(900);
  });

  it('env が無ければ manifest の timeoutSec を使う', () => {
    expect(resolveSetupTimeoutSec({}, 600)).toBe(600);
  });

  it('env も manifest も無ければ既定値', () => {
    expect(resolveSetupTimeoutSec({})).toBe(DEFAULT_PORT_TIMEOUT_SEC);
    expect(resolveSetupTimeoutSec({})).toBe(300);
  });

  it('env が未定義扱い (キー有り value undefined) でも manifest へ落ちる', () => {
    expect(resolveSetupTimeoutSec({ RUNTIME_SETUP_TIMEOUT_SEC: undefined }, 600)).toBe(600);
  });

  for (const bad of ['', ' ', 'abc', '0', '-1', 'NaN', 'Infinity']) {
    it(`env の不正値 ${JSON.stringify(bad)} は無視して manifest へ落ちる`, () => {
      expect(resolveSetupTimeoutSec({ RUNTIME_SETUP_TIMEOUT_SEC: bad }, 600)).toBe(600);
    });

    it(`env の不正値 ${JSON.stringify(bad)} は manifest 不在なら既定値へ落ちる`, () => {
      expect(resolveSetupTimeoutSec({ RUNTIME_SETUP_TIMEOUT_SEC: bad })).toBe(
        DEFAULT_PORT_TIMEOUT_SEC,
      );
    });
  }

  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`manifest の不正値 ${String(bad)} は無視して既定値へ落ちる`, () => {
      expect(resolveSetupTimeoutSec({}, bad)).toBe(DEFAULT_PORT_TIMEOUT_SEC);
    });
  }

  it('既定値より短い上書きも尊重する (上書きは短縮方向にも効く)', () => {
    expect(resolveSetupTimeoutSec({ RUNTIME_SETUP_TIMEOUT_SEC: '30' })).toBe(30);
  });
});
