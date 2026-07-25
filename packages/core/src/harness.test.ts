import { describe, it, expect } from 'vitest';
import { parseHarnessYaml, loadHarnessYml, readKindPrompt } from './harness.js';
import { ConfigError } from './config.js';
import type { DiscoveryFs } from './discovery.js';

/** In-memory DiscoveryFs over a path→content map. Directories are implied by paths. */
function fakeFs(files: Record<string, string>): DiscoveryFs {
  return {
    readDir: () => Promise.resolve([]),
    readFile: (path) => {
      const body = files[path];
      if (body === undefined) return Promise.reject(new Error(`ENOENT: ${path}`));
      return Promise.resolve(body);
    },
    exists: (path) => Promise.resolve(Object.prototype.hasOwnProperty.call(files, path)),
  };
}

describe('parseHarnessYaml', () => {
  it('parses the shape `halo project init` generates', () => {
    const parsed = parseHarnessYaml(
      [
        '# .harness.yml — comment',
        'kinds:',
        '  code:',
        '    runtimes: [node-pnpm]',
        '    prompt: .halo/prompts/code.md',
        '',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      kinds: { code: { runtimes: ['node-pnpm'], prompt: '.halo/prompts/code.md' } },
    });
  });

  it('parses multiple kinds, flow sequences with several items, and quoted scalars', () => {
    const parsed = parseHarnessYaml(
      [
        'kinds:',
        '  code:',
        '    runtimes: [node-pnpm, python-uv]',
        "    prompt: 'quoted value.md'",
        '  docs:',
        '    runtimes: [node-pnpm]',
        '    prompt: "docs.md"',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      kinds: {
        code: { runtimes: ['node-pnpm', 'python-uv'], prompt: 'quoted value.md' },
        docs: { runtimes: ['node-pnpm'], prompt: 'docs.md' },
      },
    });
  });

  it('parses top-level safety fields including a block sequence', () => {
    const parsed = parseHarnessYaml(
      [
        'kinds:',
        '  code:',
        '    runtimes: [node-pnpm]',
        '    prompt: p.md',
        'maxAutonomy: L2',
        'protectedPaths:',
        '  - packages/plugins/src/gate-loop-audit/**',
        '  - plugins/**/plugin.json',
      ].join('\n'),
    );
    expect(parsed).toMatchObject({
      maxAutonomy: 'L2',
      protectedPaths: ['packages/plugins/src/gate-loop-audit/**', 'plugins/**/plugin.json'],
    });
  });

  it('keeps a `#` inside a quoted scalar and strips a trailing comment otherwise', () => {
    const parsed = parseHarnessYaml(['a: "x # y"', 'b: z # trailing'].join('\n'));
    expect(parsed).toEqual({ a: 'x # y', b: 'z' });
  });

  it('keeps a colon inside a value (only `: ` separates key from value)', () => {
    expect(parseHarnessYaml('url: https://example.com/x')).toEqual({
      url: 'https://example.com/x',
    });
  });

  it('parses an empty flow sequence', () => {
    expect(parseHarnessYaml('runtimes: []')).toEqual({ runtimes: [] });
  });

  // Failing closed matters more than breadth here: this file carries the autonomy
  // ceiling, so an unsupported construct must be an error, never a silent guess.
  it.each([
    ['tabs', 'kinds:\n\tcode: x'],
    ['document markers', '---\nkinds: {}'],
    ['block scalars', 'prompt: |\n  text'],
    ['flow mappings', 'code: {runtimes: [a]}'],
    ['anchors', 'a: &anchor x'],
    ['aliases', 'a: *anchor'],
    ['duplicate keys', 'a: 1\na: 2'],
    ['a bare line with no key', 'kinds:\n  oops'],
    ['inconsistent indentation', 'a:\n  b: 1\n   c: 2'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseHarnessYaml(text)).toThrow(ConfigError);
  });

  // Deliberate deviation from YAML, pinned so nobody "fixes" it into type inference:
  // the .harness.yml contract is entirely string-typed.
  it('keeps every scalar a string, with no type inference', () => {
    expect(parseHarnessYaml('port: 8080\nflag: yes\nnil: null')).toEqual({
      port: '8080',
      flag: 'yes',
      nil: 'null',
    });
  });

  it('rejects an empty document', () => {
    expect(() => parseHarnessYaml('# only a comment\n')).toThrow(/empty/);
  });

  it('reports the offending line number', () => {
    expect(() => parseHarnessYaml('a: 1\nb: |\n  x')).toThrow(/:2/);
  });
});

describe('loadHarnessYml', () => {
  const valid = ['kinds:', '  code:', '    runtimes: [node-pnpm]', '    prompt: p.md'].join('\n');

  it('returns null when no .harness.yml exists above startDir', async () => {
    const fs = fakeFs({ '/repo/.git': '' });
    expect(await loadHarnessYml('/repo', fs)).toBeNull();
  });

  it('finds, parses and validates the declaration', async () => {
    const fs = fakeFs({ '/repo/.harness.yml': valid, '/repo/.git': '' });
    const loaded = await loadHarnessYml('/repo', fs);
    expect(loaded?.path).toBe('/repo/.harness.yml');
    expect(loaded?.harness.kinds.code?.runtimes).toEqual(['node-pnpm']);
  });

  it('throws ConfigError for a declaration that parses but violates the contract', async () => {
    const fs = fakeFs({
      '/repo/.harness.yml': 'kinds:\n  code:\n    prompt: p.md',
      '/repo/.git': '',
    });
    await expect(loadHarnessYml('/repo', fs)).rejects.toThrow(ConfigError);
  });

  it('surfaces the file path in a parse error', async () => {
    const fs = fakeFs({ '/repo/.harness.yml': 'a: |\n  x', '/repo/.git': '' });
    await expect(loadHarnessYml('/repo', fs)).rejects.toThrow(/\/repo\/\.harness\.yml/);
  });
});

describe('readKindPrompt', () => {
  const harness = {
    kinds: { code: { runtimes: ['node-pnpm'], prompt: '.halo/prompts/code.md' } },
  };

  it('reads the prompt template relative to the declaration directory', async () => {
    const fs = fakeFs({ '/repo/.halo/prompts/code.md': '# House rules' });
    const r = await readKindPrompt(harness, '/repo/.harness.yml', 'code', fs);
    expect(r).toMatchObject({ status: 'resolved', kind: 'code', instructions: '# House rules' });
  });

  it('escalates an undefined kind to needs-human rather than throwing', async () => {
    const fs = fakeFs({});
    const r = await readKindPrompt(harness, '/repo/.harness.yml', 'infra', fs);
    expect(r).toMatchObject({ status: 'needs-human' });
  });

  it('escalates a declared-but-missing prompt file to needs-human', async () => {
    const fs = fakeFs({});
    const r = await readKindPrompt(harness, '/repo/.harness.yml', 'code', fs);
    expect(r.status).toBe('needs-human');
    if (r.status === 'needs-human') expect(r.reason).toMatch(/prompt/);
  });

  it('treats an absolute prompt path as absolute', async () => {
    const fs = fakeFs({ '/abs/p.md': 'body' });
    const abs = { kinds: { code: { runtimes: ['n'], prompt: '/abs/p.md' } } };
    const r = await readKindPrompt(abs, '/repo/.harness.yml', 'code', fs);
    expect(r).toMatchObject({ status: 'resolved', instructions: 'body' });
  });
});
