// キルスイッチ (D3 §2.4, §6): `.halo/STOP` の touch/rm。core に killswitch モジュールが
// 無いため CLI 側で実装する薄いラッパ。stop=set / resume=clear の表裏で、いずれも冪等。
import type { CliFs } from './fs.js';

export const STOP_FILENAME = 'STOP';

export function stopPath(haloDir: string): string {
  return `${haloDir.replace(/\/$/, '')}/${STOP_FILENAME}`;
}

export interface SetStopOptions {
  haloDir: string;
  fs: CliFs;
  reason?: string | undefined;
  now: number;
}

/** STOP ファイル本文を生成する (理由と日時を記録, D3 §2.4)。 */
export function formatStopFile(reason: string | undefined, now: number): string {
  const iso = new Date(now).toISOString();
  const lines = [`# HALO STOP — 無人実行のキルスイッチ (D3 §2.4)`, `created_at: ${iso}`];
  if (reason !== undefined && reason !== '') lines.push(`reason: ${reason}`);
  return `${lines.join('\n')}\n`;
}

/** STOP を配置。既存でも理由を更新して冪等に成功する。 */
export async function setStop(
  options: SetStopOptions,
): Promise<{ path: string; existed: boolean }> {
  const { haloDir, fs, reason, now } = options;
  await fs.mkdir(haloDir, { recursive: true });
  const path = stopPath(haloDir);
  const existed = await fs.exists(path);
  await fs.writeFile(path, formatStopFile(reason, now));
  return { path, existed };
}

/** STOP を除去。存在しなくても冪等に成功する。 */
export async function clearStop(
  haloDir: string,
  fs: CliFs,
): Promise<{ path: string; existed: boolean }> {
  const path = stopPath(haloDir);
  const existed = await fs.exists(path);
  if (existed) await fs.rm(path);
  return { path, existed };
}
