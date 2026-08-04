// kind.executor (issue #51): validateHarnessYml / resolveKind の透過検証。
import { describe, it, expect } from 'vitest';
import { validateHarnessYml, resolveKind, ConfigError } from './config.js';
import type { HarnessYml } from '@tsurupong/halo-contracts';

describe('validateHarnessYml — kind.executor', () => {
  const base = { kinds: { code: { runtimes: ['node-pnpm'], prompt: 'p.md' } } };

  it('accepts a kind with an explicit executor', () => {
    const parsed = validateHarnessYml({
      kinds: { code: { runtimes: ['node-pnpm'], prompt: 'p.md', executor: 'executor-alt' } },
    });
    expect(parsed.kinds.code?.executor).toBe('executor-alt');
  });

  it('accepts an omitted executor', () => {
    expect(validateHarnessYml(base).kinds.code?.executor).toBeUndefined();
  });

  it('rejects an empty string executor', () => {
    expect(() =>
      validateHarnessYml({
        kinds: { code: { runtimes: ['node-pnpm'], prompt: 'p.md', executor: '' } },
      }),
    ).toThrow(ConfigError);
    expect(() =>
      validateHarnessYml({
        kinds: { code: { runtimes: ['node-pnpm'], prompt: 'p.md', executor: '' } },
      }),
    ).toThrow(/executor/);
  });

  it('rejects a non-string executor', () => {
    expect(() =>
      validateHarnessYml({
        kinds: { code: { runtimes: ['node-pnpm'], prompt: 'p.md', executor: 123 } },
      }),
    ).toThrow(/executor/);
  });
});

describe('resolveKind — executor passthrough', () => {
  const harness: HarnessYml = {
    kinds: {
      code: { runtimes: ['node-pnpm'], prompt: 'prompts/code.md', executor: 'executor-alt' },
      docs: { runtimes: ['node-pnpm'], prompt: 'prompts/docs.md' },
    },
  };

  it('carries the explicit executor through to the resolved result', () => {
    const r = resolveKind(harness, 'code');
    expect(r).toMatchObject({ status: 'resolved', executor: 'executor-alt' });
  });

  it('omits executor entirely (no key) when the kind does not declare one', () => {
    const r = resolveKind(harness, 'docs');
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') {
      expect(r.executor).toBeUndefined();
      expect('executor' in r).toBe(false);
    }
  });
});
