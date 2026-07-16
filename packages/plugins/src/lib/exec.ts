// 外部コマンド実行の薄いラッパー。プラグインが本来の対象とする外部コマンド
// (git / gh / pnpm / スケジューラ)のみに使う(ADR-0017: jq 等の汎用依存は持たない)。
import { spawnSync } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
}

/** コマンドを同期実行し、exit code と出力を返す。コマンド不在は code=127。 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    input: opts.input,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error !== undefined) {
    return { code: 127, stdout: '', stderr: r.error.message };
  }
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** コマンドが PATH 上に存在するか。 */
export function hasCmd(cmd: string): boolean {
  return run(cmd, ['--version']).code !== 127;
}
