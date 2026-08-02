// runtime node-pnpm 共通処理(D1 §1.7 / D5 §3.2)。
// stdin の runtime.in JSON {workdir, changed_files?} を読み、workdir で指定コマンド列を実行する。
// 判定: 全成功=exit 0 / いずれか失敗=exit 2。診断は stderr、stdout は使わない。
import { spawnSync } from 'node:child_process';
import { readStdinJson, diag, str } from '../lib/io.js';

export interface RuntimeCmd {
  cmd: string;
  args: string[];
}

export async function runRuntime(
  label: string,
  cmds: RuntimeCmd[],
  after?: (workdir: string) => void,
): Promise<never> {
  const input = await readStdinJson().catch(() => undefined);
  const workdir = str(input, 'workdir');
  if (workdir === undefined) {
    diag(`runtime-node-pnpm/${label}: workdir が入力にありません`);
    process.exit(2);
  }
  for (const { cmd, args } of cmds) {
    // stdout も stderr へ寄せ、runtime の stdout(JSON 契約チャネル)を空に保つ。
    const r = spawnSync(cmd, args, {
      cwd: workdir,
      stdio: ['ignore', 2, 2],
    });
    if (r.error !== undefined) {
      diag(`runtime-node-pnpm/${label}: 実行失敗: ${cmd} (${r.error.message})`);
      process.exit(2);
    }
    if (r.status !== 0) {
      // issue #27: signal 終了 (status=null) は理由を stderr に残す — gate/診断が拾える。
      if (r.status === null && r.signal !== null) {
        diag(`runtime-node-pnpm/${label}: signal 終了: ${r.signal}`);
      }
      process.exit(2);
    }
  }
  // 全コマンド成功時のみの後処理(失敗した workdir には触らない)。
  if (after !== undefined) {
    try {
      after(workdir);
    } catch (err) {
      diag(`runtime-node-pnpm/${label}: 後処理失敗(続行): ${(err as Error).message}`);
    }
  }
  process.exit(0);
}
