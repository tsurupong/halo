// MAX_TURNS / --max-turns の設定経路 (fix/executor-max-turns) の新規テスト。
// 従来は LOOP_DEFAULTS.maxTurns=40 を上書きする経路が無く、実装系タスクが
// 常に max turns 到達で失敗していた。既存 config.test.ts は変更しない。
import { describe, expect, test } from 'vitest';
import { resolveConfig, ConfigError } from './config.js';

describe('resolveConfig MAX_TURNS (executor turn budget)', () => {
  test('unset -> maxTurns is absent so the loop default applies', () => {
    expect(resolveConfig({}).maxTurns).toBeUndefined();
  });

  test('profile env MAX_TURNS is picked up', () => {
    expect(resolveConfig({ profileEnv: { MAX_TURNS: '120' } }).maxTurns).toBe(120);
  });

  test('CLI --max-turns overrides the profile env', () => {
    const config = resolveConfig({
      profileEnv: { MAX_TURNS: '120' },
      cli: { maxTurns: '200' },
    });
    expect(config.maxTurns).toBe(200);
  });

  test('non-integer / non-positive values are rejected loudly', () => {
    expect(() => resolveConfig({ profileEnv: { MAX_TURNS: 'many' } })).toThrow(ConfigError);
    expect(() => resolveConfig({ profileEnv: { MAX_TURNS: '0' } })).toThrow(ConfigError);
  });
});
