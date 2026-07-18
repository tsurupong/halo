// trigger install/uninstall/list の委譲先 (D3 §2.3, §6, D1 §1.9)。core に trigger 用の
// discovery ヘルパが無いため CLI 側に置く薄い層: entry契約 (plugin.json の aux.install/
// aux.uninstall) の解決と node での spawn、`.bin/halo` 絶対パス解決 (fire 埋め込み用),
// 有効トリガー一覧。実処理は各アダプタの TS 実装 (ADR-0017)。
import { isAbsolute } from 'node:path';
import type { CliFs } from './fs.js';

/** name/profile の許容文字 (シェル注入を避ける, install.sh と同じ制約)。 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function isSafeName(value: string): boolean {
  return SAFE_NAME.test(value);
}

function join(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/$/, '') : p.replace(/^\/|\/$/g, '')))
    .join('/');
}

/** 有効化されたトリガーアダプタのディレクトリ (`.halo/ports/trigger.d/<name>`)。 */
export function triggerDir(haloDir: string, name: string): string {
  return join(haloDir, 'ports/trigger.d', name);
}

/** 無人実行の唯一の起動入口となる `node_modules/.bin/halo` の絶対パス (D3 §2.3)。 */
export function resolveBinPath(cwd: string): string {
  return join(cwd, 'node_modules/.bin/halo');
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** アダプタ script を子プロセス実行するシーム (テストでスタブ)。 */
export type SpawnAdapter = (
  script: string,
  args: readonly string[],
  env: Record<string, string>,
) => Promise<SpawnResult>;

export interface TriggerContext {
  haloDir: string;
  cwd: string;
  fs: CliFs;
  spawn: SpawnAdapter;
}

export interface AdapterOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ResolvedAux {
  /** aux[key] の絶対パス (adapterDir 起点で解決済み)。 */
  scriptPath: string;
  /** アダプタディレクトリの絶対パス (HALO_PLUGIN_DIR 用)。 */
  adapterDir: string;
}

/**
 * adapter ディレクトリの plugin.json を読み、`aux[key]` の絶対パスを解決する (entry契約, D11 §3)。
 * plugin.json 不在/壊れている、または `aux[key]` が無い場合は fail-fast する。
 */
async function resolveAux(ctx: TriggerContext, name: string, key: string): Promise<ResolvedAux> {
  const adapterDir = triggerDir(ctx.haloDir, name);
  if (!(await ctx.fs.isDirectory(adapterDir))) {
    throw new Error(`unknown trigger adapter: ${name}`);
  }
  let manifest: { aux?: Record<string, string> };
  try {
    const raw = await ctx.fs.readFile(join(adapterDir, 'plugin.json'));
    manifest = JSON.parse(raw) as { aux?: Record<string, string> };
  } catch {
    throw new Error(`trigger adapter '${name}': plugin.json not found or invalid`);
  }
  const rawScript = manifest.aux?.[key];
  if (rawScript === undefined) {
    throw new Error(`trigger adapter '${name}': plugin.json に aux.${key} がありません`);
  }
  const scriptPath = isAbsolute(rawScript)
    ? rawScript
    : join(adapterDir, rawScript.replace(/^\.\//, ''));
  return { scriptPath, adapterDir };
}

/** `install.js <profile>` を node で起動し OS スケジューラへ登録。fire 用に HALO_BIN を注入 (D3 §2.3)。 */
export async function installTrigger(
  ctx: TriggerContext,
  name: string,
  profile: string,
): Promise<AdapterOutcome> {
  const { scriptPath, adapterDir } = await resolveAux(ctx, name, 'install');
  const env = {
    HALO_BIN: resolveBinPath(ctx.cwd),
    HALO_HOME: ctx.cwd,
    HALO_PLUGIN_DIR: adapterDir,
  };
  return ctx.spawn(process.execPath, [scriptPath, profile], env);
}

/** `uninstall.js [<profile>]` を node で起動し登録解除。未登録でも冪等成功はアダプタ側の責務。 */
export async function uninstallTrigger(
  ctx: TriggerContext,
  name: string,
  profile: string | undefined,
): Promise<AdapterOutcome> {
  const { scriptPath, adapterDir } = await resolveAux(ctx, name, 'uninstall');
  const env = {
    HALO_BIN: resolveBinPath(ctx.cwd),
    HALO_HOME: ctx.cwd,
    HALO_PLUGIN_DIR: adapterDir,
  };
  return ctx.spawn(
    process.execPath,
    profile !== undefined ? [scriptPath, profile] : [scriptPath],
    env,
  );
}

export interface TriggerEntry {
  name: string;
  /** fire の絶対パス。 */
  fire: string;
  /** 生存状態: 登録先 fire が現在の .bin/halo と整合するか (D3 §2.3/§4)。 */
  alive: boolean;
}

/**
 * 有効化されたトリガーアダプタ一覧 (`.halo/ports/trigger.d/*`)。各アダプタの `plugin.json` を
 * 読み込み、`aux.fire` (entry契約化後は `halo enable` が dist ルート起点の絶対パスへ書き換え済み)
 * の実在で生存判定する。plugin.json 自体が無い/壊れている、または aux.fire が無い場合は DEAD
 * 扱い (D3 §2.3/§4)。
 */
export async function listTriggers(ctx: TriggerContext): Promise<TriggerEntry[]> {
  const dir = join(ctx.haloDir, 'ports/trigger.d');
  let names: string[];
  try {
    names = await ctx.fs.readdir(dir);
  } catch {
    return [];
  }
  const entries: TriggerEntry[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const adir = join(dir, name);
    if (!(await ctx.fs.isDirectory(adir))) continue;

    let fire: string | undefined;
    try {
      const raw = await ctx.fs.readFile(join(adir, 'plugin.json'));
      const manifest = JSON.parse(raw) as { aux?: Record<string, string> };
      const rawFire = manifest.aux?.fire;
      if (rawFire !== undefined) {
        fire = isAbsolute(rawFire) ? rawFire : join(adir, rawFire.replace(/^\.\//, ''));
      }
    } catch {
      fire = undefined;
    }

    if (fire === undefined) {
      entries.push({ name, fire: join(adir, 'plugin.json'), alive: false });
      continue;
    }
    const alive = await ctx.fs.exists(fire);
    entries.push({ name, fire, alive });
  }
  return entries;
}
