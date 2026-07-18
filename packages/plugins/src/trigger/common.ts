// トリガー共通処理(設計 04 §4.2 / D1 §1.9 / D10 §2-3)。
// fire: 「halo CLI を正しい環境で呼ぶ」ことだけ(トリガー種別の分岐は持たない)。
// install/uninstall: スケジューラバックエンドへの登録・解除を lib/scheduler.ts へ委譲。
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { diag } from '../lib/io.js';
import { schedulerInstall, schedulerUninstall } from '../lib/scheduler.js';

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function requireProfile(trigger: string): string {
  const profile = process.argv[2];
  if (profile === undefined || profile === '') {
    diag(`trigger-${trigger}: profile name required`);
    process.exit(1);
  }
  if (!NAME_RE.test(profile)) {
    diag(`invalid profile name: ${profile}`);
    process.exit(1);
  }
  return profile;
}

/** fire 実処理。ready 0 件なら core が即 exit 0 するため空振りコストは小さい(設計 04 §4.4)。 */
export function fire(trigger: string, profile: string): never {
  // Windows パス継承問題の回避: PATH を Linux 側のみに洗い直す(設計 04 §4.2 / §7)。
  const extra = process.env['HALO_PATH_EXTRA'];
  const path = `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${homedir()}/.local/bin${extra !== undefined && extra !== '' ? `:${extra}` : ''}`;

  // 無人実行では npx を経由せず .bin の絶対パスを直接叩く(バージョン固定・ネット非依存, D1 §1.9)。
  const haloHome = process.env['HALO_HOME'] ?? join(homedir(), 'halo');
  const haloBin = process.env['HALO_BIN'] ?? join(haloHome, 'node_modules', '.bin', 'halo');

  try {
    accessSync(haloBin, constants.X_OK);
  } catch {
    diag(`trigger-${trigger}/fire: halo CLI が見つかりません: ${haloBin}`);
    process.exit(1);
  }

  const r = spawnSync(haloBin, ['run', profile, '--cwd', haloHome], {
    stdio: 'inherit',
    env: { ...process.env, PATH: path },
  });
  process.exit(r.error !== undefined ? 1 : (r.status ?? 1));
}

/** install 実処理。冪等(再実行は削除→再登録)。fireArgv は fire を起動する argv(node + スクリプトパス)。 */
export function install(trigger: string, profile: string, spec: string, fireArgv: readonly string[]): never {
  try {
    schedulerInstall(trigger, profile, spec, fireArgv);
  } catch (e) {
    diag(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(0);
}

/** uninstall 実処理。登録が無ければ何もせず正常終了する(冪等, 設計 04 §4.2)。 */
export function uninstall(trigger: string, profile: string): never {
  try {
    schedulerUninstall(trigger, profile);
  } catch (e) {
    diag(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  process.exit(0);
}
