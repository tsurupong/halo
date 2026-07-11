import { expect, test, describe } from 'vitest';
import { renderHarnessYml, scaffold, PROFILE_TEMPLATES } from './scaffold.js';
import { memFs } from '../testkit.js';

describe('scaffold (T24)', () => {
  test('renderHarnessYml emits one block per kind with runtime + prompt', () => {
    const yml = renderHarnessYml({ kinds: ['code', 'docs'], runtime: 'node-pnpm' });
    expect(yml).toContain('  code:');
    expect(yml).toContain('    runtimes: [node-pnpm]');
    expect(yml).toContain('    prompt: .halo/prompts/docs.md');
  });

  test('renderHarnessYml defaults to code kind and node-pnpm', () => {
    const yml = renderHarnessYml({ kinds: [], runtime: '' });
    expect(yml).toContain('  code:');
    expect(yml).toContain('[node-pnpm]');
  });

  test('generates all 3 profiles and preserves existing files', async () => {
    const fs = memFs({ files: { '/repo/.harness.yml': 'EXISTING' } });
    const r = await scaffold({
      cwd: '/repo',
      fs,
      kinds: ['code'],
      runtime: 'node-pnpm',
      gitignore: true,
    });
    for (const name of Object.keys(PROFILE_TEMPLATES)) {
      expect(fs.files.has(`/repo/.halo/profiles/${name}`)).toBe(true);
    }
    expect(fs.files.get('/repo/.harness.yml')).toBe('EXISTING');
    expect(r.skipped).toContain('.harness.yml');
  });

  test('.gitignore append is idempotent', async () => {
    const fs = memFs({ files: { '/repo/.gitignore': 'node_modules\n.halo/\n' } });
    const r = await scaffold({
      cwd: '/repo',
      fs,
      kinds: ['code'],
      runtime: 'node-pnpm',
      gitignore: true,
    });
    expect(fs.files.get('/repo/.gitignore')).toBe('node_modules\n.halo/\n');
    expect(r.skipped).toContain('.gitignore');
  });

  test('creates .gitignore when absent', async () => {
    const fs = memFs();
    await scaffold({ cwd: '/repo', fs, kinds: ['code'], runtime: 'node-pnpm', gitignore: true });
    expect(fs.files.get('/repo/.gitignore')).toContain('.halo/');
  });
});
