// `halo project init` (T24, D3 §3): scaffold へ委譲し生成結果を整形するだけ。
import { arrayFlag, boolFlag, stringFlag, type ParsedArgs } from '../args.js';
import type { ExitCode } from '../exit-codes.js';
import { EXIT } from '../exit-codes.js';
import type { Io } from '../io.js';
import type { CliFs } from '../core-ext/fs.js';
import { scaffold } from '../core-ext/scaffold.js';

export interface InitDeps {
  fs: CliFs;
}

export const INIT_VALUE_FLAGS = ['runtime'] as const;
export const INIT_REPEAT_FLAGS = ['kind'] as const;

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

  if (io.flags.json) {
    io.printJson({ ok: true, created: result.created, skipped: result.skipped });
    return EXIT.OK;
  }

  if (result.created.length > 0) {
    io.print(`初期化しました (${result.created.length} 件生成):`);
    for (const path of result.created) io.print(`  + ${path}`);
  }
  if (result.skipped.length > 0) {
    io.warn(`温存 (既存): ${result.skipped.length} 件`);
  }
  if (result.created.length === 0) {
    io.print('既に初期化済みです (不足なし)。');
  }
  return EXIT.OK;
}
