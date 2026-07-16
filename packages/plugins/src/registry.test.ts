// registry.ts の manifest がリポジトリの plugins/**/plugin.json と食い違っていないかを
// 検証するドリフト防止テスト (ADR-0017 / D11 §3)。halo enable が古いメタデータを
// コピーし続けるのを防ぐ。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { expect, test, describe } from 'vitest';
import { BUNDLED_PLUGINS } from './registry.js';

// packages/plugins/src/registry.test.ts から見た monorepo ルートの plugins/。
const PLUGINS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugins');

// registry のプラグイン名 → リポジトリ上の plugin.json への相対ディレクトリ。
// gate-runtime-check は port ディレクトリ配下がサブディレクトリ分割されているため個別指定する。
const REPO_DIRS: Record<string, string> = {
  'gate-runtime-check-typecheck': 'gate-runtime-check/10-typecheck',
  'gate-runtime-check-test': 'gate-runtime-check/30-test',
};

describe('BUNDLED_PLUGINS drift (D11 §3)', () => {
  for (const plugin of BUNDLED_PLUGINS) {
    test(`${plugin.name}: manifest matches plugins/**/plugin.json`, async () => {
      const repoDir = REPO_DIRS[plugin.name] ?? plugin.name;
      const raw = await readFile(join(PLUGINS_ROOT, repoDir, 'plugin.json'), 'utf8');
      const repoManifest: unknown = JSON.parse(raw);
      expect(plugin.manifest).toEqual(repoManifest);
    });
  }

  test('covers every plugin.json under plugins/ (no orphans)', async () => {
    const { readdir } = await import('node:fs/promises');
    const topDirs = await readdir(PLUGINS_ROOT, { withFileTypes: true });
    const discovered = new Set<string>();
    for (const entry of topDirs) {
      if (!entry.isDirectory()) continue;
      const top = entry.name;
      if (await fileExists(join(PLUGINS_ROOT, top, 'plugin.json'))) {
        discovered.add(top);
        continue;
      }
      const subDirs = await readdir(join(PLUGINS_ROOT, top), { withFileTypes: true });
      for (const sub of subDirs) {
        if (
          sub.isDirectory() &&
          (await fileExists(join(PLUGINS_ROOT, top, sub.name, 'plugin.json')))
        ) {
          discovered.add(`${top}/${sub.name}`);
        }
      }
    }

    const registered = new Set(BUNDLED_PLUGINS.map((p) => REPO_DIRS[p.name] ?? p.name));
    expect([...discovered].sort()).toEqual([...registered].sort());
  });
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
