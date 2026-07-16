// `halo enable <plugin-name>` (entry契約化 Task 6): 同梱プラグイン(@tsurupong/halo-plugins)の
// manifest (entry/aux) を実行時解決した dist の絶対パスへ書き換えた `plugin.json` のみを
// `.halo/ports/<port>.d/<name>/` へ生成する。.sh ランチャーは一切生成しない — 実行はコア側が
// plugin.json の entry/aux を直接 `node` に渡す (entry契約化)。CLI はロジックを持たず registry
// の manifest を絶対パス化して写すだけ。

import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { BUNDLED_PLUGINS, type BundledPlugin } from '@tsurupong/halo-plugins/registry';
import type { PluginManifest } from '@tsurupong/halo-contracts';
import type { ParsedArgs } from '../args.js';
import type { ExitCode } from '../exit-codes.js';
import { EXIT } from '../exit-codes.js';
import type { Io } from '../io.js';
import type { CliFs } from '../core-ext/fs.js';

export interface EnableDeps {
  fs: CliFs;
  /** `@tsurupong/halo-plugins` の package.json 絶対パスを解決する。既定は require.resolve 相当。 */
  resolvePluginsPackageJson?: () => string;
}

/** `require.resolve('@tsurupong/halo-plugins/package.json')` 相当 (D11 §3 追記)。 */
function defaultResolvePluginsPackageJson(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@tsurupong/halo-plugins/package.json');
}

function listAvailable(): string {
  const names = BUNDLED_PLUGINS.map((p) => p.name).sort();
  return `利用可能な同梱プラグイン:\n${names.map((n) => `  ${n}`).join('\n')}\n`;
}

/** `plugin.env` のテンプレート値中の `{PORTS_DIR}` を実際の絶対パスへ展開する。 */
function resolveEnv(
  env: Record<string, string> | undefined,
  portsDir: string,
): Record<string, string> | undefined {
  if (env === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = value.replaceAll('{PORTS_DIR}', portsDir);
  }
  return resolved;
}

export async function enableCommand(
  parsed: ParsedArgs,
  io: Io,
  deps: EnableDeps,
): Promise<ExitCode> {
  const name = parsed.positionals[0];
  if (name === undefined) {
    io.streams.err(listAvailable());
    return EXIT.OK;
  }

  const plugin = BUNDLED_PLUGINS.find((p): p is BundledPlugin => p.name === name);
  if (!plugin) {
    io.streams.err(`error: unknown plugin '${name}'\n`);
    io.streams.err(listAvailable());
    return EXIT.USAGE;
  }

  const resolvePackageJson = deps.resolvePluginsPackageJson ?? defaultResolvePluginsPackageJson;
  const distRoot = join(dirname(resolvePackageJson()), 'dist');

  const cwd = io.flags.cwd.replace(/\/$/, '');
  const portsDir = `${cwd}/.halo/ports`;
  const targetDir = `${portsDir}/${plugin.port}.d/${plugin.name}`;

  await deps.fs.mkdir(targetDir, { recursive: true });

  const resolvedEnv = resolveEnv(plugin.env, portsDir);
  const absolutize = (rel: string): string => (isAbsolute(rel) ? rel : join(distRoot, rel));
  const manifest: PluginManifest = {
    ...plugin.manifest,
    entry: absolutize(plugin.manifest.entry),
    ...(plugin.manifest.aux !== undefined
      ? {
          aux: Object.fromEntries(
            Object.entries(plugin.manifest.aux).map(([k, v]) => [k, absolutize(v)]),
          ),
        }
      : {}),
    ...(resolvedEnv !== undefined ? { env: resolvedEnv } : {}),
  };
  await deps.fs.writeFile(`${targetDir}/plugin.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  io.streams.err(`enabled ${plugin.name} -> ${targetDir}\n`);
  return EXIT.OK;
}
