// `halo run <profile>` (T23, D3 §2.1, §6): プロファイル解決 + フラグ上書き →
// preflight.light → preflight.heavy → loop.run。CLI は「引数→config 解決」と
// 「preflight 判定→終了コード写像」のみ。上書き優先順位の適用は core.resolveConfig に委譲。
import { boolFlag, stringFlag, type ParsedArgs } from '../args.js';
import type { ExitCode } from '../exit-codes.js';
import { EXIT, usageError, runtimeError } from '../exit-codes.js';
import type { Io } from '../io.js';
import type { CliFs } from '../core-ext/fs.js';
import {
  resolveConfig,
  parseEnvFile,
  ConfigError,
  type HaloConfig,
  type CliOverrides,
  type LightDecision,
  type HeavyDecision,
  type LoopResult,
} from '@tsurupong/halo-core';

export const RUN_VALUE_FLAGS = [
  'max-iter',
  'autonomy',
  'timeout',
  'daily-budget',
  'profiles-dir',
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
}

export interface RunDeps {
  fs: CliFs;
  now: number;
  hooks: RunHooks;
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
  if (boolFlag(parsed, 'dry-run')) overrides.maxIter = 1;
  else if (maxIter !== undefined) overrides.maxIter = maxIter;
  if (autonomy !== undefined) overrides.autonomy = autonomy;
  if (timeout !== undefined) overrides.timeout = timeout;
  if (dailyBudget !== undefined) overrides.dailyBudget = dailyBudget;
  return overrides;
}

/** LoopResult.endReason → 終了コード。正当な停止は 0、真の異常のみ 1 (D3 §5.1)。 */
export function loopReasonToExit(reason: LoopResult['endReason']): ExitCode {
  // MAX_ITER / NO_TASK / STOP / BUDGET_EXCEEDED / TIMEOUT はいずれも正当な終了 → 0。
  void reason;
  return EXIT.OK;
}

export async function runCommand(parsed: ParsedArgs, io: Io, deps: RunDeps): Promise<ExitCode> {
  const profile = parsed.positionals[0];
  if (profile === undefined) {
    throw usageError('missing <profile>', {
      usage:
        'usage: halo run <profile> [--max-iter n] [--autonomy L1|L2|L3] [--timeout d] [--daily-budget n] [--dry-run]',
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

  let config: HaloConfig;
  try {
    config = resolveConfig({ profileEnv, cli: overrides, profileName: profile });
  } catch (err) {
    if (err instanceof ConfigError) throw usageError(err.message);
    throw err;
  }

  const ctx: RunContext = { config, haloDir, cwd: io.flags.cwd, now: deps.now };

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

  io.warn(`loop: 終了 (${result.endReason}, iterations=${result.iterations.length})`);
  return loopReasonToExit(result.endReason);
}
