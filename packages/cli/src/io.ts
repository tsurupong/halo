// 出力の分離 (D3 §2.0/§5.3): stdout = 主要出力 (--json 時は JSON)、stderr = 進捗・警告・エラー。
// テスト容易性のため実ストリームは注入する。CLI はここを通してのみ書き込む。
import { boolFlag, type ParsedArgs } from './args.js';

export interface Streams {
  out(text: string): void;
  err(text: string): void;
}

export interface GlobalFlags {
  cwd: string;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

export interface Io {
  streams: Streams;
  flags: GlobalFlags;
  /** 主要出力 (stdout)。末尾改行は付けない — 呼び手が整形する。 */
  print(text: string): void;
  /** 機械可読出力 (stdout)。--json 時に使用。 */
  printJson(value: unknown): void;
  /** 進捗・警告 (stderr)。--quiet で抑制。 */
  warn(text: string): void;
  /** 診断 (stderr)。--verbose 時のみ。 */
  debug(text: string): void;
}

/** 実プロセスストリームに束ねた Streams。 */
export function nodeStreams(): Streams {
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  };
}

/** グローバルフラグを ParsedArgs から解決する (D3 §2.0)。 */
export function resolveGlobalFlags(parsed: ParsedArgs, defaultCwd: string): GlobalFlags {
  const cwd = typeof parsed.flags.cwd === 'string' ? parsed.flags.cwd : defaultCwd;
  return {
    cwd,
    json: boolFlag(parsed, 'json'),
    quiet: boolFlag(parsed, 'quiet'),
    verbose: boolFlag(parsed, 'verbose'),
  };
}

export function createIo(streams: Streams, flags: GlobalFlags): Io {
  return {
    streams,
    flags,
    print(text) {
      streams.out(text.endsWith('\n') ? text : `${text}\n`);
    },
    printJson(value) {
      streams.out(`${JSON.stringify(value, null, 2)}\n`);
    },
    warn(text) {
      if (!flags.quiet) streams.err(text.endsWith('\n') ? text : `${text}\n`);
    },
    debug(text) {
      if (flags.verbose) streams.err(text.endsWith('\n') ? text : `${text}\n`);
    },
  };
}

/** グローバル値フラグ (全コマンド共通で値を取るもの)。 */
export const GLOBAL_VALUE_FLAGS = ['cwd'] as const;
