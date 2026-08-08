// `halo run <profile>` (T23, D3 §2.1, §6): プロファイル解決 + フラグ上書き →
// preflight.light → preflight.heavy → loop.run。CLI は「引数→config 解決」と
// 「preflight 判定→終了コード写像」のみ。上書き優先順位の適用は core.resolveConfig に委譲。
import { boolFlag, stringFlag, type ParsedArgs } from '../args.js';
import type { ExitCode } from '../exit-codes.js';
import { EXIT, usageError, runtimeError } from '../exit-codes.js';
import type { Io } from '../io.js';
import type { CliFs } from '@tsurupong/halo-core';
import {
  resolveConfig,
  parseEnvFile,
  ConfigError,
  type HaloConfig,
  type CliOverrides,
  type LightDecision,
  type HeavyDecision,
  type LoopResult,
  type LoadedHarness,
} from '@tsurupong/halo-core';

export const RUN_VALUE_FLAGS = [
  'max-iter',
  'autonomy',
  'timeout',
  'daily-budget',
  'max-budget-usd',
  'profiles-dir',
  'max-turns',
] as const;

/** preflight/loop の実行を注入するシーム。CLI 本体はロジックを持たない (D3 §0)。 */
export interface RunHooks {
  preflightLight(ctx: RunContext): Promise<LightDecision>;
  preflightHeavy(ctx: RunContext): Promise<HeavyDecision>;
  runLoop(ctx: RunContext): Promise<LoopResult>;
}

export interface RunContext {
  config: HaloConfig;
  haloDir: string;
  cwd: string;
  now: number;
  /**
   * 協調シャットダウン (ADR-0022)。1 回目の SIGINT/SIGTERM でこれが abort され、
   * 配線が loop と全 runPort 呼び出しへ渡す。省略時はシグナル非対応 (旧挙動)。
   */
  abort?: AbortSignal;
  /**
   * ループ進捗の通知先 (issue #43)。配線がフェーズ境界・イテレーション確定の要約行を
   * 渡す。省略時は無音 (旧挙動)。非TTYリダイレクトでも無人運用のログ監査ができるよう、
   * run は --verbose 時にこれを stderr (io.debug) へ束ねる。
   */
  onProgress?: (line: string) => void;
}

export interface RunDeps {
  fs: CliFs;
  now: number;
  hooks: RunHooks;
  /**
   * `.harness.yml` 読み込みシーム (D2 §7)。宣言された `maxAutonomy` を config 解決へ
   * 渡すために run が必要とする。省略時はリポジトリ上限なし (宣言を読まない旧挙動)。
   */
  loadHarness?: (cwd: string) => Promise<LoadedHarness | null>;
  /**
   * シグナルシーム (ADR-0022)。`process.on` を直接触らずに注入するのは、テストが
   * テストランナー自身へシグナルを送らずに 2 回目の即時終了まで検証できるようにするため。
   * 省略時はハンドラを張らない (シグナルで即死する旧挙動)。
   */
  signals?: SignalSeam;
}

/** SIGINT/SIGTERM の受け口と強制終了 (ADR-0022, D3 §2.1)。 */
export interface SignalSeam {
  /** ハンドラを登録し、解除関数を返す。run 終了時に必ず解除する。 */
  on(handler: (signal: NodeJS.Signals) => void): () => void;
  /** 2 回目のシグナル用の即時終了 (cleanup を諦める脱出口)。 */
  exit(code: number): void;
}

/** POSIX の 128+signum。未知のシグナルは SIGTERM 相当に倒す。 */
export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (signal === 'SIGINT' ? 2 : 15);
}

function haloDirOf(cwd: string): string {
  return `${cwd.replace(/\/$/, '')}/.halo`;
}
function join(a: string, b: string): string {
  return `${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`;
}

/** フラグ → CliOverrides 写像。--dry-run は --max-iter 1 相当 (D3 §2.1)。 */
export function buildOverrides(parsed: ParsedArgs): CliOverrides {
  const overrides: CliOverrides = {};
  const maxIter = stringFlag(parsed, 'max-iter');
  const autonomy = stringFlag(parsed, 'autonomy');
  const timeout = stringFlag(parsed, 'timeout');
  const dailyBudget = stringFlag(parsed, 'daily-budget');
  const maxBudgetUsd = stringFlag(parsed, 'max-budget-usd');
  const maxTurns = stringFlag(parsed, 'max-turns');
  if (boolFlag(parsed, 'dry-run')) overrides.maxIter = 1;
  else if (maxIter !== undefined) overrides.maxIter = maxIter;
  if (autonomy !== undefined) overrides.autonomy = autonomy;
  if (timeout !== undefined) overrides.timeout = timeout;
  if (dailyBudget !== undefined) overrides.dailyBudget = dailyBudget;
  if (maxBudgetUsd !== undefined) overrides.maxBudgetUsd = maxBudgetUsd;
  if (maxTurns !== undefined) overrides.maxTurns = maxTurns;
  return overrides;
}

/**
 * 「正当な非実行」ではない終了理由 (D3 §5.1 の exit 1 側)。task-source の故障と
 * 重量プリフライト不通過は、監視が非0だけをアラート対象にできるよう exit 1 に写す。
 * これらを 0 に丸めると、ポーリング運用で夜通し失敗し続けても外形は「正常」に見える。
 */
const ABNORMAL_END_REASONS: ReadonlySet<LoopResult['endReason']> = new Set([
  'TASK_SOURCE_ERROR',
  'ABORTED_ENV',
]);

/** LoopResult.endReason → 終了コード。正当な停止は 0、真の異常のみ 1 (D3 §5.1)。 */
export function loopReasonToExit(reason: LoopResult['endReason']): ExitCode {
  // MAX_ITER / NO_TASK / STOP / BUDGET_EXCEEDED / TIMEOUT はいずれも正当な終了 → 0。
  return ABNORMAL_END_REASONS.has(reason) ? EXIT.RUNTIME : EXIT.OK;
}

export async function runCommand(parsed: ParsedArgs, io: Io, deps: RunDeps): Promise<ExitCode> {
  const profile = parsed.positionals[0];
  if (profile === undefined) {
    throw usageError('missing <profile>', {
      usage:
        'usage: halo run <profile> [--max-iter n] [--max-turns n] [--autonomy L1|L2|L3] [--timeout d] [--daily-budget n] [--max-budget-usd n] [--dry-run]',
    });
  }

  const haloDir = haloDirOf(io.flags.cwd);
  const profilesDir = stringFlag(parsed, 'profiles-dir') ?? join(haloDir, 'profiles');
  const profilePath = join(profilesDir, `${profile}.env`);

  let envBody: string;
  try {
    envBody = await deps.fs.readFile(profilePath);
  } catch {
    throw usageError(`profile '${profile}' not found in ${profilesDir}/`, {
      hint: 'run `halo status` to list available profiles, or `halo project init` to create them.',
    });
  }
  const profileEnv = parseEnvFile(envBody);

  const overrides = buildOverrides(parsed);

  // --autonomy 昇格警告: L1 プロファイルへの L2/L3 上書きは事故防止の警告 (ブロックはしない, D3 §2.1)。
  if (
    overrides.autonomy !== undefined &&
    profileEnv.AUTONOMY === 'L1' &&
    overrides.autonomy !== 'L1'
  ) {
    io.warn(
      `warning: profile '${profile}' is AUTONOMY=L1; --autonomy ${overrides.autonomy} raises it for this run only.`,
    );
  }

  // .harness.yml の maxAutonomy はリポジトリ上限 (ADR-0004)。profile / CLI より後に
  // 適用するので、コミット済みの宣言をコマンドラインから引き上げることはできない。
  // 宣言が壊れている場合はここで停止する — 安全上限の読み取り失敗を握り潰して
  // 無人ループを走らせるより、起動を止める方が安全側。
  let harness: LoadedHarness | null = null;
  if (deps.loadHarness) {
    try {
      harness = await deps.loadHarness(io.flags.cwd);
    } catch (err) {
      if (err instanceof ConfigError) throw usageError(err.message);
      throw err;
    }
  }

  let config: HaloConfig;
  try {
    config = resolveConfig({
      profileEnv,
      cli: overrides,
      profileName: profile,
      ...(harness?.harness.maxAutonomy != null
        ? { harnessMaxAutonomy: harness.harness.maxAutonomy }
        : {}),
    });
  } catch (err) {
    if (err instanceof ConfigError) throw usageError(err.message);
    throw err;
  }

  if (config.autonomyCappedFrom !== undefined) {
    io.warn(
      `warning: .harness.yml caps autonomy at ${config.autonomy}; ` +
        `requested ${config.autonomyCappedFrom} was lowered for this run.`,
    );
  }

  const ctx: RunContext = {
    config,
    haloDir,
    cwd: io.flags.cwd,
    now: deps.now,
    // io.debug 自体が --verbose でゲートするので常に配線してよいが、
    // 無指定時に配線側へ無駄な文字列組み立てをさせないため明示的に絞る。
    ...(io.flags.verbose ? { onProgress: (line: string) => io.debug(line) } : {}),
  };

  // ADR-0022: 1 回目は協調中断 (子プロセスを落として finally を通す)、2 回目は即時終了。
  // ハンドラ自身は fs を触らない — 後片付けは通常の巻き戻し経路が担う。
  const controller = new AbortController();
  let signalCount = 0;
  const disposeSignals = deps.signals?.on((sig) => {
    signalCount += 1;
    if (signalCount === 1) {
      io.warn(
        `received ${sig}: 現在のイテレーションを中断して後片付けします (もう一度送ると即時終了)`,
      );
      controller.abort();
      return;
    }
    io.warn(`received ${sig} again: 後片付けを諦めて即時終了します`);
    deps.signals?.exit(signalExitCode(sig));
  });
  ctx.abort = controller.signal;

  // ハンドラは preflight も含めて必ず解除する。lock 取得は runLoop 内なので、
  // preflight 段での例外脱出でもリスナーを残さない。
  try {
    // preflight.light: STOP / flock / 予算 — 不通過は「正当な非実行」→ exit 0 (D3 §5.1)。
    const light = await deps.hooks.preflightLight(ctx);
    if (!light.proceed) {
      io.warn(`preflight: 即終了 (${light.reason})`);
      return EXIT.OK;
    }

    // preflight.heavy: git 汚染 / ディスク不足 / graph — 不通過は真の異常 → exit 1。
    const heavy = await deps.hooks.preflightHeavy(ctx);
    if (!heavy.proceed) {
      throw runtimeError(`preflight failed: ${heavy.reason}`);
    }

    let result: LoopResult;
    try {
      result = await deps.hooks.runLoop(ctx);
    } catch (err) {
      throw runtimeError(`loop error: ${(err as Error).message}`);
    }

    const exit = loopReasonToExit(result.endReason);
    if (exit !== EXIT.OK) {
      // 異常終了は endDetail (task-source の stderr 抜粋など) ごと error 行へ出す。
      // ここを warn + exit 0 にしていると、監視から見て正常終了と区別が付かない。
      throw runtimeError(
        `loop ended abnormally (${result.endReason})` +
          (result.endDetail != null && result.endDetail !== '' ? `: ${result.endDetail}` : ''),
      );
    }
    io.warn(`loop: 終了 (${result.endReason}, iterations=${result.iterations.length})`);
    return exit;
  } finally {
    disposeSignals?.();
  }
}
