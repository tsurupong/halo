// registry.ts の manifest がリポジトリの plugins/**/plugin.json と食い違っていないかを
// 検証するドリフト防止テスト (ADR-0017 / D11 §3)。halo enable が古いメタデータを
// コピーし続けるのを防ぐ。
//
// entry/aux は registry 側が dist ルート相対（例: `./trigger-polling/fire.js`）、リポジトリ側が
// monorepo 相対（例: `../../packages/plugins/dist/trigger-polling/fire.js`）と表現が異なるため、
// entry/aux 以外のフィールドは完全一致、entry/aux は指す先の末尾2セグメント（ディレクトリ名/ファイル名）
// の一致で比較する（basename のみだと main.js のような同名ファイルでディレクトリ違いを見逃すため）。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { expect, test, describe } from 'vitest';
import type { PluginManifest } from '@tsurupong/halo-contracts';
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
      expectManifestsMatch(plugin.manifest, repoManifest);
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

/** パスの末尾2セグメント（ディレクトリ名/ファイル名）を取り出す。7プラグインが main.js のような
 * 同名ファイルを使っていても、ディレクトリ違い（登録ミス）を検出できるようにするため basename 単独
 * より一段強い比較単位として使う。 */
function lastTwoSegments(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts.slice(-2).join('/');
}

/** registry の manifest とリポジトリの plugin.json を比較する。entry/aux はパス表現が
 * 異なる (dist相対 vs monorepo相対) ため末尾2セグメントの一致で判定し、それ以外は完全一致を見る。 */
function expectManifestsMatch(registryManifest: PluginManifest, repoManifest: unknown): void {
  expect(repoManifest).toEqual(expect.any(Object));
  const repo = repoManifest as PluginManifest;

  const { entry: registryEntry, aux: registryAux, ...registryRest } = registryManifest;
  const { entry: repoEntry, aux: repoAux, ...repoRest } = repo;

  expect(registryRest).toEqual(repoRest);
  expect(typeof repoEntry).toBe('string');
  expect(repoEntry.length).toBeGreaterThan(0);
  expect(lastTwoSegments(registryEntry)).toBe(lastTwoSegments(repoEntry));

  expect(Object.keys(registryAux ?? {}).sort()).toEqual(Object.keys(repoAux ?? {}).sort());
  for (const key of Object.keys(registryAux ?? {})) {
    const repoAuxValue = (repoAux ?? {})[key];
    expect(typeof repoAuxValue).toBe('string');
    expect((repoAuxValue ?? '').length).toBeGreaterThan(0);
    expect(lastTwoSegments((registryAux ?? {})[key]!)).toBe(lastTwoSegments(repoAuxValue!));
  }
}
