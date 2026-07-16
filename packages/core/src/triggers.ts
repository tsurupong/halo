// trigger install/uninstall/list の委譲先 (D3 §2.3, §6, D1 §1.9)。core に trigger 用の
// discovery ヘルパが無いため CLI 側に置く薄い層: アダプタ script の解決と spawn、
// `.bin/halo` 絶対パス解決 (fire 埋め込み用), 有効トリガー一覧。実処理は bash アダプタ。
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

async function requireAdapterScript(
  ctx: TriggerContext,
  name: string,
  script: string,
): Promise<string> {
  const dir = triggerDir(ctx.haloDir, name);
  if (!(await ctx.fs.isDirectory(dir))) {
    throw new Error(`unknown trigger adapter: ${name}`);
  }
  return join(dir, script);
}

/** `install.sh <profile>` を呼び OS スケジューラへ登録。fire 用に HALO_BIN を注入 (D3 §2.3)。 */
export async function installTrigger(
  ctx: TriggerContext,
  name: string,
  profile: string,
): Promise<AdapterOutcome> {
  const script = await requireAdapterScript(ctx, name, 'install.sh');
  const env = { HALO_BIN: resolveBinPath(ctx.cwd), HALO_HOME: ctx.cwd };
  return ctx.spawn(script, [profile], env);
}

/** `uninstall.sh [<profile>]` を呼び登録解除。未登録でも冪等成功はアダプタ側の責務。 */
export async function uninstallTrigger(
  ctx: TriggerContext,
  name: string,
  profile: string | undefined,
): Promise<AdapterOutcome> {
  const script = await requireAdapterScript(ctx, name, 'uninstall.sh');
  const env = { HALO_BIN: resolveBinPath(ctx.cwd), HALO_HOME: ctx.cwd };
  return ctx.spawn(script, profile !== undefined ? [profile] : [], env);
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
