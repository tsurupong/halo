// kind.executor (issue #51): readKindPrompt の透過検証。
import { describe, it, expect } from 'vitest';
import { readKindPrompt } from './harness.js';
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

describe('readKindPrompt — executor passthrough', () => {
  it('carries an explicit executor through to the resolved result', async () => {
    const harness = {
      kinds: {
        code: {
          runtimes: ['node-pnpm'],
          prompt: '.halo/prompts/code.md',
          executor: 'executor-alt',
        },
      },
    };
    const fs = fakeFs({ '/repo/.halo/prompts/code.md': '# House rules' });
    const r = await readKindPrompt(harness, '/repo/.harness.yml', 'code', fs);
    expect(r).toMatchObject({ status: 'resolved', executor: 'executor-alt' });
  });

  it('omits the executor key entirely when the kind does not declare one', async () => {
    const harness = {
      kinds: { code: { runtimes: ['node-pnpm'], prompt: '.halo/prompts/code.md' } },
    };
    const fs = fakeFs({ '/repo/.halo/prompts/code.md': '# House rules' });
    const r = await readKindPrompt(harness, '/repo/.harness.yml', 'code', fs);
    expect(r.status).toBe('resolved');
    if (r.status === 'resolved') {
      expect(r.executor).toBeUndefined();
      expect('executor' in r).toBe(false);
    }
  });
});
