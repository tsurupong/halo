import { describe, it, expect } from 'vitest';
import {
  parseEnvFile,
  parseDuration,
  resolveConfig,
  validateHarnessYml,
  resolveKind,
  ConfigError,
  CORE_DEFAULTS,
} from './config.js';
import type { HarnessYml } from '@tsurupong/halo-contracts';

describe('parseEnvFile', () => {
  it('parses KEY=VALUE, ignoring comments and blank lines', () => {
    const env = parseEnvFile(
      ['# header', '', 'AUTONOMY=L3', 'MAX_ITER=20  # inline', 'export TIMEOUT=3h'].join('\n'),
    );
    expect(env).toEqual({ AUTONOMY: 'L3', MAX_ITER: '20', TIMEOUT: '3h' });
  });

  it('unquotes single and double quoted values and preserves inner spaces', () => {
    const env = parseEnvFile(
      ['TASK_FILTER="label:ready state:open"', "KIND_FILTER='code'"].join('\n'),
    );
    expect(env.TASK_FILTER).toBe('label:ready state:open');
    expect(env.KIND_FILTER).toBe('code');
  });
});

describe('parseDuration', () => {
  it('accepts bare seconds and n<unit> forms', () => {
    expect(parseDuration('900')).toBe(900);
    expect(parseDuration('90m')).toBe(5400);
    expect(parseDuration('3h')).toBe(10800);
    expect(parseDuration('1d')).toBe(86400);
  });

  it('throws ConfigError on garbage', () => {
    expect(() => parseDuration('soon')).toThrow(ConfigError);
  });
});

describe('resolveConfig precedence (CLI > profile > defaults)', () => {
  it('falls back to core defaults with no profile/CLI', () => {
    const cfg = resolveConfig();
    expect(cfg.autonomy).toBe(CORE_DEFAULTS.AUTONOMY);
    expect(cfg.maxIter).toBe(Number(CORE_DEFAULTS.MAX_ITER));
    expect(cfg.timeoutSec).toBe(parseDuration(CORE_DEFAULTS.TIMEOUT));
  });

  it('profile env overrides defaults', () => {
    const cfg = resolveConfig({
      profileEnv: { AUTONOMY: 'L3', MAX_ITER: '5', TIMEOUT: '15m' },
      profileName: 'continuous',
    });
    expect(cfg.autonomy).toBe('L3');
    expect(cfg.maxIter).toBe(5);
    expect(cfg.timeoutSec).toBe(900);
    expect(cfg.profileName).toBe('continuous');
  });

  it('CLI overrides both profile and defaults', () => {
    const cfg = resolveConfig({
      profileEnv: { AUTONOMY: 'L3', MAX_ITER: '5', TIMEOUT: '15m' },
      cli: { autonomy: 'L2', maxIter: 99, timeout: '1h', dailyBudget: 40 },
    });
    expect(cfg.autonomy).toBe('L2');
    expect(cfg.maxIter).toBe(99);
    expect(cfg.timeoutSec).toBe(3600);
    expect(cfg.dailyMaxIterations).toBe(40);
  });

  it('carries optional filters and daily cost only when present', () => {
    const cfg = resolveConfig({
      profileEnv: { TASK_FILTER: 'label:ready', DAILY_MAX_COST_USD: '12.5' },
    });
    expect(cfg.taskFilter).toBe('label:ready');
    expect(cfg.dailyMaxCostUsd).toBe(12.5);
    expect(cfg.kindFilter).toBeUndefined();
    expect(cfg.dailyMaxIterations).toBeUndefined();
  });
});

describe('resolveConfig validation', () => {
  it('throws when a required key resolves to nothing', () => {
    expect(() => resolveConfig({ defaults: { AUTONOMY: 'L1', MAX_ITER: '1' } })).toThrow(/TIMEOUT/);
  });

  it('rejects an unknown autonomy value', () => {
    expect(() => resolveConfig({ cli: { autonomy: 'L9' } })).toThrow(ConfigError);
  });

  it('rejects a non-positive / non-integer MAX_ITER', () => {
    expect(() => resolveConfig({ cli: { maxIter: '0' } })).toThrow(/MAX_ITER/);
    expect(() => resolveConfig({ cli: { maxIter: 'lots' } })).toThrow(/MAX_ITER/);
  });
});

describe('validateHarnessYml', () => {
  const good: HarnessYml = {
    kinds: { code: { runtimes: ['node-pnpm'], prompt: 'prompts/code.md' } },
  };

  it('accepts a well-formed harness and returns it typed', () => {
    expect(validateHarnessYml(good)).toBe(good);
  });

  it('rejects non-object root and empty kinds', () => {
    expect(() => validateHarnessYml(null)).toThrow(ConfigError);
    expect(() => validateHarnessYml({ kinds: {} })).toThrow(/at least one/);
  });

  it('rejects a kind missing runtimes or prompt', () => {
    expect(() => validateHarnessYml({ kinds: { code: { prompt: 'p' } } })).toThrow(/runtimes/);
    expect(() => validateHarnessYml({ kinds: { code: { runtimes: [] } } })).toThrow(/runtimes/);
    expect(() => validateHarnessYml({ kinds: { code: { runtimes: ['x'] } } })).toThrow(/prompt/);
  });
});

describe('resolveKind', () => {
  const harness: HarnessYml = {
    kinds: {
      code: { runtimes: ['node-pnpm'], prompt: 'prompts/code.md' },
      docs: { runtimes: ['node-pnpm'], prompt: 'prompts/docs.md' },
    },
  };

  it('defaults an unspecified label to code', () => {
    const r = resolveKind(harness);
    expect(r).toMatchObject({
      status: 'resolved',
      kind: 'code',
      runtimes: ['node-pnpm'],
      prompt: 'prompts/code.md',
    });
  });

  it('resolves an explicit kind', () => {
    expect(resolveKind(harness, 'docs')).toMatchObject({ status: 'resolved', kind: 'docs' });
  });

  it('returns needs-human for an undefined kind (no throw)', () => {
    expect(resolveKind(harness, 'infra')).toMatchObject({ status: 'needs-human', kind: 'infra' });
  });

  it('copies runtimes so callers cannot mutate the source', () => {
    const r = resolveKind(harness, 'code');
    if (r.status === 'resolved') r.runtimes.push('mutated');
    expect(harness.kinds.code?.runtimes).toEqual(['node-pnpm']);
  });
});

describe('validateHarnessYml — safety fields', () => {
  const base = { kinds: { code: { runtimes: ['node-pnpm'], prompt: 'p.md' } } };

  it('accepts an omitted maxAutonomy / protectedPaths', () => {
    expect(validateHarnessYml(base)).toMatchObject({ kinds: { code: {} } });
  });

  it('accepts a valid maxAutonomy and protectedPaths', () => {
    const parsed = validateHarnessYml({ ...base, maxAutonomy: 'L2', protectedPaths: ['a/**'] });
    expect(parsed.maxAutonomy).toBe('L2');
    expect(parsed.protectedPaths).toEqual(['a/**']);
  });

  it('rejects an unknown maxAutonomy level', () => {
    expect(() => validateHarnessYml({ ...base, maxAutonomy: 'L9' })).toThrow(/maxAutonomy/);
  });

  it('rejects a non-string[] protectedPaths', () => {
    expect(() => validateHarnessYml({ ...base, protectedPaths: 'a/**' })).toThrow(/protectedPaths/);
    expect(() => validateHarnessYml({ ...base, protectedPaths: [1] })).toThrow(/protectedPaths/);
  });
});

describe('resolveConfig — repository autonomy ceiling (ADR-0004)', () => {
  it('clamps a profile level above the repository ceiling', () => {
    const c = resolveConfig({ profileEnv: { AUTONOMY: 'L3' }, harnessMaxAutonomy: 'L2' });
    expect(c.autonomy).toBe('L2');
    expect(c.autonomyCappedFrom).toBe('L3');
  });

  it('clamps a --autonomy override above the repository ceiling', () => {
    const c = resolveConfig({
      cli: { autonomy: 'L3' },
      profileEnv: { AUTONOMY: 'L1' },
      harnessMaxAutonomy: 'L2',
    });
    expect(c.autonomy).toBe('L2');
    expect(c.autonomyCappedFrom).toBe('L3');
  });

  it('leaves a level at or below the ceiling untouched', () => {
    const c = resolveConfig({ profileEnv: { AUTONOMY: 'L1' }, harnessMaxAutonomy: 'L2' });
    expect(c.autonomy).toBe('L1');
    expect(c.autonomyCappedFrom).toBeUndefined();
  });

  it('applies no ceiling when the repository declares none', () => {
    const c = resolveConfig({ profileEnv: { AUTONOMY: 'L3' } });
    expect(c.autonomy).toBe('L3');
    expect(c.autonomyCappedFrom).toBeUndefined();
  });

  it('rejects an invalid ceiling value', () => {
    expect(() => resolveConfig({ harnessMaxAutonomy: 'L9' })).toThrow(ConfigError);
  });
});
