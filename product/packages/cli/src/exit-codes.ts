// Exit-code写像 (D3 §5.1). CLI はロジックを持たず core の結果をこれらへ写像する。
//   0 = 正常終了 / 正当な即終了 (STOP・多重起動回避・ready 0 件・予算超過)
//   1 = 実行時エラー (回復不能・重量プリフライト不通過・登録失敗・doctor FAIL)
//   2 = 予約 (プラグイン fail 相当。CLI 自体では返さない — D1 §3.1 との衝突回避)
//   3 = 設定・使用法エラー (不正引数・未知プロファイル/トリガー/コマンド・不正 .harness.yml)
export const EXIT = {
  OK: 0,
  RUNTIME: 1,
  USAGE: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * CLI が投げるエラー。`exitCode` と、任意で対処 `hint` を持つ。ディスパッチャが
 * これを捕捉して stderr へ「1 行サマリ + hint」を出し `exitCode` を返す (D3 §5.3)。
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly hint: string | undefined;
  readonly usage: string | undefined;

  constructor(
    message: string,
    exitCode: ExitCode,
    opts: { hint?: string | undefined; usage?: string | undefined } = {},
  ) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = opts.hint;
    this.usage = opts.usage;
  }
}

/** 設定・使用法エラー (exit 3). */
export function usageError(
  message: string,
  opts: { hint?: string | undefined; usage?: string | undefined } = {},
): CliError {
  return new CliError(message, EXIT.USAGE, opts);
}

/** 実行時エラー (exit 1). */
export function runtimeError(message: string, opts: { hint?: string | undefined } = {}): CliError {
  return new CliError(message, EXIT.RUNTIME, opts);
}
