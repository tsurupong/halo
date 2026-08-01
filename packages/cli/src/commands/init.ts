// `halo project init` (T24, D3 §3): scaffold へ委譲し生成結果を整形するだけ。
// ADR-0027: scaffold 後に DEFAULT_ENABLED_PLUGINS (on-fail-record + context-recent-failures)
// を materializeManifest で既定有効化する。core が @tsurupong/halo-plugins に依存する
// (依存方向の逆転) のを避けるため、有効化ロジックは CLI 側に置く (halo enable と同型)。
import { dirname, join } from 'node:path';
import { arrayFlag, boolFlag, stringFlag, type ParsedArgs } from '../args.js';
import type { ExitCode } from '../exit-codes.js';
import { EXIT } from '../exit-codes.js';
import type { Io } from '../io.js';
import type { CliFs } from '../core-ext/fs.js';
import { scaffold } from '../core-ext/scaffold.js';
import { BUNDLED_PLUGINS, DEFAULT_ENABLED_PLUGINS } from '@tsurupong/halo-plugins/registry';
import { defaultResolvePluginsPackageJson, materializeManifest } from './enable.js';

export interface InitDeps {
  fs: CliFs;
  /** `@tsurupong/halo-plugins` の package.json 絶対パスを解決する。既定は require.resolve 相当 (enable と同型のシーム)。 */
  resolvePluginsPackageJson?: () => string;
}

export const INIT_VALUE_FLAGS = ['runtime'] as const;
export const INIT_REPEAT_FLAGS = ['kind'] as const;

/**
 * DEFAULT_ENABLED_PLUGINS (ADR-0027) を `.halo/ports/<port>.d/<name>/plugin.json` として
 * 生成する。既存ファイルはスキップ (冪等)。dist 解決に失敗した場合は fatal にせず warn を返し、
 * scaffold 結果はそのまま返す (init 全体は失敗させない)。
 */
async function materializeDefaultPlugins(
  cwd: string,
  fs: CliFs,
  resolvePluginsPackageJson: () => string,
): Promise<{ created: string[]; skipped: string[]; warnings: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  let distRoot: string;
  try {
    distRoot = join(dirname(resolvePluginsPackageJson()), 'dist');
  } catch (err) {
    warnings.push(
      `既定プラグインの有効化をスキップしました (@tsurupong/halo-plugins の解決に失敗): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { created, skipped, warnings };
  }

  const portsDir = `${cwd.replace(/\/$/, '')}/.halo/ports`;

  for (const name of DEFAULT_ENABLED_PLUGINS) {
    const plugin = BUNDLED_PLUGINS.find((p) => p.name === name);
    if (!plugin) continue; // registry.test.ts が drift を検出する

    const targetDir = `${portsDir}/${plugin.port}.d/${plugin.name}`;
    const targetPath = `${targetDir}/plugin.json`;
    const exists = await fs.exists(targetPath);
    if (exists) {
      skipped.push(targetPath);
      continue;
    }

    await fs.mkdir(targetDir, { recursive: true });
    const manifest = materializeManifest(plugin, distRoot, portsDir);
    await fs.writeFile(targetPath, `${JSON.stringify(manifest, null, 2)}\n`);
    created.push(targetPath);
  }

  return { created, skipped, warnings };
}

export async function initCommand(parsed: ParsedArgs, io: Io, deps: InitDeps): Promise<ExitCode> {
  const sub = parsed.positionals[0];
  if (sub !== 'init') {
    io.streams.err(
      `error: unknown subcommand for 'project': ${sub ?? '(none)'}\nusage: halo project init [--kind <name>] [--runtime <name>] [--force] [--no-gitignore]\n`,
    );
    return EXIT.USAGE;
  }

  const kinds = arrayFlag(parsed, 'kind');
  const runtime = stringFlag(parsed, 'runtime') ?? 'node-pnpm';
  const gitignore = boolFlag(parsed, 'gitignore', true);

  const result = await scaffold({
    cwd: io.flags.cwd,
    fs: deps.fs,
    kinds,
    runtime,
    gitignore,
  });

  const resolvePluginsPackageJson =
    deps.resolvePluginsPackageJson ?? defaultResolvePluginsPackageJson;
  const pluginsResult = await materializeDefaultPlugins(
    io.flags.cwd,
    deps.fs,
    resolvePluginsPackageJson,
  );

  const created = [...result.created, ...pluginsResult.created];
  const skipped = [...result.skipped, ...pluginsResult.skipped];

  if (io.flags.json) {
    io.printJson({ ok: true, created, skipped, warnings: pluginsResult.warnings });
    return EXIT.OK;
  }

  if (created.length > 0) {
    io.print(`初期化しました (${created.length} 件生成):`);
    for (const path of created) io.print(`  + ${path}`);
  }
  if (skipped.length > 0) {
    io.warn(`温存 (既存): ${skipped.length} 件`);
  }
  for (const warning of pluginsResult.warnings) {
    io.warn(warning);
  }
  if (created.length === 0) {
    io.print('既に初期化済みです (不足なし)。');
  }
  return EXIT.OK;
}
