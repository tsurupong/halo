// `halo stop` / `halo resume` (T25, D3 §2.4): killswitch へ委譲。冪等な exit 0。
import { stringFlag, type ParsedArgs } from '../args.js';
import type { ExitCode } from '../exit-codes.js';
import { EXIT } from '../exit-codes.js';
import type { Io } from '../io.js';
import type { CliFs } from '../core-ext/fs.js';
import { setStop, clearStop } from '../core-ext/killswitch.js';

export interface StopDeps {
  fs: CliFs;
  now: number;
}

export const STOP_VALUE_FLAGS = ['reason'] as const;

/** haloDir を cwd から導出 (`<cwd>/.halo`)。 */
function haloDirOf(cwd: string): string {
  return `${cwd.replace(/\/$/, '')}/.halo`;
}

export async function stopCommand(parsed: ParsedArgs, io: Io, deps: StopDeps): Promise<ExitCode> {
  const reason = stringFlag(parsed, 'reason');
  const result = await setStop({
    haloDir: haloDirOf(io.flags.cwd),
    fs: deps.fs,
    reason,
    now: deps.now,
  });
  if (io.flags.json) {
    io.printJson({ ok: true, action: 'stop', path: result.path, updated: result.existed });
  } else {
    io.print(
      result.existed
        ? 'STOP を更新しました (既存)。'
        : 'STOP を配置しました。無人実行は次のイテレーション冒頭で停止します。',
    );
  }
  return EXIT.OK;
}

export async function resumeCommand(parsed: ParsedArgs, io: Io, deps: StopDeps): Promise<ExitCode> {
  void parsed;
  const result = await clearStop(haloDirOf(io.flags.cwd), deps.fs);
  if (io.flags.json) {
    io.printJson({ ok: true, action: 'resume', path: result.path, removed: result.existed });
  } else {
    io.print(
      result.existed
        ? 'STOP を削除しました。無人実行を再開できます。'
        : 'STOP はありません (既に再開状態)。',
    );
  }
  return EXIT.OK;
}
