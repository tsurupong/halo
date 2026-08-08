// runtime node-pnpm 共通処理(D1 §1.7 / D5 §3.2)。
// stdin の runtime.in JSON {workdir, changed_files?} を読み、workdir で指定コマンド列を実行する。
// 判定: 全成功=exit 0 / いずれか失敗=exit 2。診断は stderr、stdout は使わない。
import { spawnSync } from 'node:child_process';
import { readStdinJson, diag, str } from '../lib/io.js';

export interface RuntimeCmd {
  cmd: string;
  args: string[];
}

// 自衛タイムアウトの既定 (秒)。外側 (run-wiring の DEFAULT_PORT_TIMEOUT_SEC=300) が
// SIGKILL する前に自分で打ち切り、「timeout で失敗した」ことを自己申告できる値にする。
const DEFAULT_TIMEOUT_SEC = 270;

/** RUNTIME_SETUP_TIMEOUT_SEC (正の整数のみ有効) を秒で返す。未設定・不正値は既定値。 */
function resolveTimeoutSec(): number {
  const raw = process.env['RUNTIME_SETUP_TIMEOUT_SEC'];
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DEFAULT_TIMEOUT_SEC;
  const sec = Number(raw.trim());
  return sec > 0 ? sec : DEFAULT_TIMEOUT_SEC;
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
  const timeoutSec = resolveTimeoutSec();
  for (const { cmd, args } of cmds) {
    // stdout も stderr へ寄せ、runtime の stdout(JSON 契約チャネル)を空に保つ。
    const startedAt = Date.now();
    const r = spawnSync(cmd, args, {
      cwd: workdir,
      stdio: ['ignore', 2, 2],
      timeout: timeoutSec * 1000,
    });
    if (r.error !== undefined) {
      // 自衛タイムアウトで打ち切った場合は、外側の SIGKILL と区別できるよう理由を明示する。
      if ((r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        diag(
          `runtime-node-pnpm/${label}: timeout: ${cmd} が上限 ${timeoutSec} 秒に達したため打ち切りました (経過 ${elapsedSec} 秒)`,
        );
        process.exit(2);
      }
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
