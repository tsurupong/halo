import { describe, it, expect } from 'vitest';
import {
  parseNumericPrefix,
  isDisabledName,
  effectiveOrder,
  comparePlugins,
  sortPlugins,
  validatePluginManifest,
  DiscoveryError,
  isSinglePort,
  checkSinglePortPopulated,
  discoverPort,
  portDir,
  findUpwards,
  findHarnessYml,
  UNORDERED,
  type DiscoveryFs,
  type DirEntry,
  type DiscoveredPlugin,
  type PortDiscovery,
} from './discovery.js';
import type { PluginManifest, Port } from '@halo/contracts';

const validManifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  name: '@halo/plugin-x',
  version: '1.0.0',
  port: 'sink',
  exec: './run.sh',
  ...over,
});

describe('parseNumericPrefix', () => {
  it('reads a NN- / NN_ prefix', () => {
    expect(parseNumericPrefix('10-git-commit')).toBe(10);
    expect(parseNumericPrefix('05_setup')).toBe(5);
    expect(parseNumericPrefix('30')).toBe(30);
  });

  it('is undefined without a numeric prefix', () => {
    expect(parseNumericPrefix('git-commit')).toBeUndefined();
    expect(parseNumericPrefix('v2-thing')).toBeUndefined();
  });
});

describe('isDisabledName', () => {
  it('flags *.disabled entries', () => {
    expect(isDisabledName('15-create-pr.disabled')).toBe(true);
    expect(isDisabledName('15-create-pr')).toBe(false);
  });
});

describe('effectiveOrder', () => {
  it('prefers the manifest order field', () => {
    expect(effectiveOrder(validManifest({ order: 42 }), '10-x')).toBe(42);
  });

  it('falls back to the filename numeric prefix', () => {
    expect(effectiveOrder(validManifest(), '20-x')).toBe(20);
  });

  it('is UNORDERED when neither is present', () => {
    expect(effectiveOrder(validManifest(), 'x')).toBe(UNORDERED);
  });

  it('keeps a real order:0 ahead of an unnumbered plugin', () => {
    expect(effectiveOrder(validManifest({ order: 0 }), 'x')).toBeLessThan(UNORDERED);
  });
});

describe('comparePlugins / sortPlugins', () => {
  const mk = (name: string, order: number, dirName = name): DiscoveredPlugin => ({
    port: 'gate',
    name,
    dirName,
    dir: `/d/${dirName}`,
    execPath: `/d/${dirName}/run.sh`,
    order,
    manifest: validManifest({ name, port: 'gate' }),
  });

  it('sorts by order ascending', () => {
    const sorted = sortPlugins([mk('b', 30), mk('a', 10), mk('c', 20)]);
    expect(sorted.map((p) => p.name)).toEqual(['a', 'c', 'b']);
  });

  it('breaks ties by name deterministically', () => {
    const sorted = sortPlugins([mk('zeta', 10), mk('alpha', 10)]);
    expect(sorted.map((p) => p.name)).toEqual(['alpha', 'zeta']);
  });

  it('does not mutate the input', () => {
    const input = [mk('b', 30), mk('a', 10)];
    sortPlugins(input);
    expect(input.map((p) => p.name)).toEqual(['b', 'a']);
  });

  it('comparePlugins returns 0 for identical keys', () => {
    expect(comparePlugins(mk('a', 10), mk('a', 10))).toBe(0);
  });
});

describe('validatePluginManifest', () => {
  it('accepts a minimal valid manifest', () => {
    expect(validatePluginManifest(validManifest())).toEqual(validManifest());
  });

  it('accepts all optional fields', () => {
    const m = validManifest({ order: 15, minAutonomy: 'L2', timeoutSec: 120, env: { GH_TOKEN: '${X}' } });
    expect(validatePluginManifest(m)).toEqual(m);
  });

  it('rejects missing required fields', () => {
    expect(() => validatePluginManifest({ version: '1.0.0', port: 'sink', exec: './x' })).toThrow(DiscoveryError);
    expect(() => validatePluginManifest({ name: 'x', port: 'sink', exec: './x' })).toThrow(/version/);
  });

  it('rejects a bad semver', () => {
    expect(() => validatePluginManifest(validManifest({ version: 'v1' }))).toThrow(/semver/);
  });

  it('rejects an unknown port', () => {
    expect(() => validatePluginManifest({ ...validManifest(), port: 'nope' })).toThrow(/port/);
  });

  it('rejects a port that does not match the discovered directory', () => {
    expect(() => validatePluginManifest(validManifest({ port: 'gate' }), 'sink')).toThrow(/found under 'sink.d\//);
  });

  it('rejects a bad minAutonomy / non-integer order / timeoutSec < 1', () => {
    expect(() => validatePluginManifest(validManifest({ minAutonomy: 'L9' as never }))).toThrow(/minAutonomy/);
    expect(() => validatePluginManifest({ ...validManifest(), order: 1.5 })).toThrow(/order/);
    expect(() => validatePluginManifest(validManifest({ timeoutSec: 0 }))).toThrow(/timeoutSec/);
  });

  it('rejects unknown fields (additionalProperties: false)', () => {
    expect(() => validatePluginManifest({ ...validManifest(), extra: 1 })).toThrow(/unknown field/);
  });

  it('rejects non-string env values', () => {
    expect(() => validatePluginManifest({ ...validManifest(), env: { X: 1 } })).toThrow(/env/);
  });
});

describe('isSinglePort / checkSinglePortPopulated', () => {
  it('identifies single ports', () => {
    expect(isSinglePort('task-source')).toBe(true);
    expect(isSinglePort('executor')).toBe(true);
    expect(isSinglePort('gate')).toBe(false);
  });

  const empty = (port: Port): PortDiscovery => ({ port, plugins: [], issues: [] });

  it('flags a single port with zero enabled plugins as core-stop', () => {
    const r = checkSinglePortPopulated(empty('executor'));
    expect(r.ok).toBe(false);
  });

  it('allows a non-single port to be empty', () => {
    expect(checkSinglePortPopulated(empty('context')).ok).toBe(true);
  });
});

// --- fake fs seam -----------------------------------------------------------

interface FakeTree {
  dirs: Record<string, DirEntry[]>;
  files: Record<string, string>;
}

function fakeFs(tree: FakeTree): DiscoveryFs {
  return {
    async readDir(path) {
      return tree.dirs[path] ?? [];
    },
    async readFile(path) {
      const f = tree.files[path];
      if (f === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return f;
    },
    async exists(path) {
      return path in tree.files || path in tree.dirs;
    },
  };
}

const dir = (name: string): DirEntry => ({ name, isDirectory: true, isFile: false });
const file = (name: string): DirEntry => ({ name, isDirectory: false, isFile: true });

describe('discoverPort', () => {
  const haloRoot = '/repo/.halo';
  const base = portDir(haloRoot, 'sink');

  it('is [] when the port directory does not exist', async () => {
    const r = await discoverPort({ haloRoot, port: 'sink', fs: fakeFs({ dirs: {}, files: {} }) });
    expect(r.plugins).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  it('scans plugin dirs, validates manifests, and returns them in order', async () => {
    const tree: FakeTree = {
      dirs: { [base]: [dir('20-progress-log'), dir('10-git-commit')] },
      files: {
        [`${base}/20-progress-log/plugin.json`]: JSON.stringify(validManifest({ name: 'progress', order: 20 })),
        [`${base}/10-git-commit/plugin.json`]: JSON.stringify(validManifest({ name: 'commit', order: 10 })),
      },
    };
    const r = await discoverPort({ haloRoot, port: 'sink', fs: fakeFs(tree) });
    expect(r.plugins.map((p) => p.name)).toEqual(['commit', 'progress']);
    expect(r.plugins[0]?.execPath).toBe(`${base}/10-git-commit/run.sh`);
    expect(r.issues).toEqual([]);
  });

  it('orders by filename prefix when order is omitted', async () => {
    const tree: FakeTree = {
      dirs: { [base]: [dir('30-c'), dir('10-a')] },
      files: {
        [`${base}/30-c/plugin.json`]: JSON.stringify(validManifest({ name: 'c' })),
        [`${base}/10-a/plugin.json`]: JSON.stringify(validManifest({ name: 'a' })),
      },
    };
    const r = await discoverPort({ haloRoot, port: 'sink', fs: fakeFs(tree) });
    expect(r.plugins.map((p) => p.name)).toEqual(['a', 'c']);
  });

  it('skips *.disabled dirs, .disabled markers, non-dirs, and dirs without a manifest', async () => {
    const tree: FakeTree = {
      dirs: { [base]: [dir('10-on'), dir('20-off.disabled'), dir('30-marked'), dir('40-nomanifest'), file('README.md')] },
      files: {
        [`${base}/10-on/plugin.json`]: JSON.stringify(validManifest({ name: 'on' })),
        [`${base}/30-marked/plugin.json`]: JSON.stringify(validManifest({ name: 'marked' })),
        [`${base}/30-marked/.disabled`]: '',
      },
    };
    const r = await discoverPort({ haloRoot, port: 'sink', fs: fakeFs(tree) });
    expect(r.plugins.map((p) => p.name)).toEqual(['on']);
  });

  it('excludes an invalid manifest and records an issue rather than throwing', async () => {
    const tree: FakeTree = {
      dirs: { [base]: [dir('10-bad'), dir('20-good')] },
      files: {
        [`${base}/10-bad/plugin.json`]: '{ not json',
        [`${base}/20-good/plugin.json`]: JSON.stringify(validManifest({ name: 'good' })),
      },
    };
    const r = await discoverPort({ haloRoot, port: 'sink', fs: fakeFs(tree) });
    expect(r.plugins.map((p) => p.name)).toEqual(['good']);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.dir).toBe(`${base}/10-bad`);
  });

  it('records an issue when requireExec is set and the exec is missing', async () => {
    const tree: FakeTree = {
      dirs: { [base]: [dir('10-x')] },
      files: { [`${base}/10-x/plugin.json`]: JSON.stringify(validManifest({ name: 'x', exec: './missing.sh' })) },
    };
    const r = await discoverPort({ haloRoot, port: 'sink', fs: fakeFs(tree), requireExec: true });
    expect(r.plugins).toEqual([]);
    expect(r.issues[0]?.message).toMatch(/exec not found/);
  });
});

describe('findUpwards / findHarnessYml', () => {
  it('finds the file walking up to an ancestor', async () => {
    const tree: FakeTree = { dirs: {}, files: { '/repo/.harness.yml': 'kinds: {}' } };
    const found = await findHarnessYml('/repo/packages/core/src', fakeFs(tree));
    expect(found).toBe('/repo/.harness.yml');
  });

  it('returns null and stops at the repository root (.git)', async () => {
    const tree: FakeTree = { dirs: {}, files: { '/repo/.git': '' } };
    const found = await findHarnessYml('/repo/packages', fakeFs(tree));
    expect(found).toBeNull();
  });

  it('returns null at the filesystem root when nothing is found', async () => {
    const found = await findUpwards('/a/b', '.harness.yml', fakeFs({ dirs: {}, files: {} }));
    expect(found).toBeNull();
  });
});
