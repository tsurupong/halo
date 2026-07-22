#!/usr/bin/env node
// halo CLI エントリ (T22, D3 §1): 引数パース → コマンドディスパッチ → 終了コード写像。
// CLI はロジックを持たず core / core-ext へ委譲する (D3 §0)。
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HALO_CORE_VERSION } from '@tsurupong/halo-core';
import { parseArgs, boolFlag } from './args.js';
import { EXIT, CliError, type ExitCode } from './exit-codes.js';
import { createIo, nodeStreams, resolveGlobalFlags, type Streams } from './io.js';
import { runCommand } from './commands/run.js';
import { initCommand } from './commands/init.js';
import { triggerCommand } from './commands/trigger.js';
import { stopCommand, resumeCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { historyCommand } from './commands/history.js';
import { watchdogCommand } from './commands/watchdog.js';
import { doctorCommand } from './commands/doctor.js';
import { enableCommand } from './commands/enable.js';
import { createNodeCliFs } from './core-ext/fs.js';
import { nodeSpawnAdapter, nodeDoctorProbes, defaultRunHooks } from './deps.js';

export const CLI_VERSION = HALO_CORE_VERSION;

// 全コマンドの値/反復フラグの和集合 (パーサに単一のスペックで渡す)。
const VALUE_FLAGS = [
  'cwd',
  'runtime',
  'reason',
  'profile',
  'max-iter',
  'max-turns',
  'autonomy',
  'timeout',
  'daily-budget',
  'profiles-dir',
  'days',
  'limit',
  'action',
];
const REPEAT_FLAGS = ['kind'];

const HELP = `halo — 無人実行ハーネス CLI

usage: halo <command> [args] [flags]

commands:
  run <profile>                       プロファイル指定で 1 回起動 (preflight → loop)
  project init                        リポジトリを HALO 管理下に (.harness.yml / .halo/)
  trigger install <name> <profile>    トリガーを OS スケジューラへ登録
  trigger uninstall <name> [profile]  トリガー解除 (冪等)
  trigger list                        登録トリガー一覧
  stop [--reason <text>]              キルスイッチ配置 (.halo/STOP)
  resume                              キルスイッチ除去
  status [--days <n>]                 稼働状態・予算残・直近実績 (既定 7 日のサマリ集計・コスト付き)
  history [--days <n>] [--limit <n>]  実行履歴の時系列一覧 (既定 7 日 / 20 件)
  watchdog [--action <mode>]          停滞ループの検知/回収 (report|kill|skip, 既定 report)
  doctor [--fix]                      環境自己診断 (9 検査)
  enable <plugin-name>                同梱プラグインを絶対パスランチャーとして .halo/ に生成

global flags:
  --cwd <path>   対象リポジトリルート   --json      機械可読出力
  --quiet, -q    進捗/警告を抑制        --verbose, -v  診断を増やす
  --version      バージョン表示         --help, -h  ヘルプ表示
`;

export interface Deps {
  streams: Streams;
  now: number;
}

/**
 * argv (`process.argv.slice(2)` 相当) を処理して終了コードを返す。純粋な写像に近く、
 * 実 I/O は Deps 経由でのみ触れる。例外は CliError に集約し stderr + exit code に写像。
 */
export async function run(argv: readonly string[], deps: Deps): Promise<ExitCode> {
  const parsed = parseArgs(argv, { valueFlags: VALUE_FLAGS, repeatFlags: REPEAT_FLAGS });

  // --version / --help はコマンドに先立ち exit 0 (D3 §2.0)。
  if (boolFlag(parsed, 'version')) {
    deps.streams.out(`halo ${CLI_VERSION}\n`);
    return EXIT.OK;
  }

  const command = parsed.positionals[0];
  const wantsHelp = boolFlag(parsed, 'help');
  if (command === undefined || wantsHelp) {
    deps.streams.out(HELP);
    return EXIT.OK;
  }

  const global = resolveGlobalFlags(parsed, process.cwd());
  const io = createIo(deps.streams, global);
  const fs = createNodeCliFs();
  const spawn = nodeSpawnAdapter();

  // 第一位置引数をコマンドから除いた残りを各コマンドへ渡す。
  const rest = { ...parsed, positionals: parsed.positionals.slice(1) };

  try {
    switch (command) {
      case 'run':
        return await runCommand(rest, io, { fs, now: deps.now, hooks: defaultRunHooks() });
      case 'project':
        return await initCommand(rest, io, { fs });
      case 'trigger':
        return await triggerCommand(rest, io, { fs, spawn });
      case 'stop':
        return await stopCommand(rest, io, { fs, now: deps.now });
      case 'resume':
        return await resumeCommand(rest, io, { fs, now: deps.now });
      case 'status':
        return await statusCommand(rest, io, { fs, now: deps.now, spawn });
      case 'history':
        return await historyCommand(rest, io, { fs, now: deps.now });
      case 'watchdog':
        return await watchdogCommand(rest, io, {
          fs,
          now: deps.now,
          env: process.env,
          tmpdir: process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp',
          host: hostname(),
          isProcessAlive: (pid) => {
            try {
              process.kill(pid, 0);
              return true;
            } catch (err) {
              return (err as NodeJS.ErrnoException).code === 'EPERM';
            }
          },
          kill: (pid, signal) => process.kill(pid, signal),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        });
      case 'doctor':
        return await doctorCommand(rest, io, {
          fs,
          probes: nodeDoctorProbes(global.cwd, fs, spawn),
        });
      case 'enable':
        return await enableCommand(rest, io, { fs });
      default:
        deps.streams.err(`error: unknown command '${command}'\n`);
        deps.streams.err(`hint: run \`halo --help\` for available commands.\n`);
        return EXIT.USAGE;
    }
  } catch (err) {
    if (err instanceof CliError) {
      deps.streams.err(`error: ${err.message}\n`);
      if (err.hint) deps.streams.err(`hint: ${err.hint}\n`);
      if (err.usage) deps.streams.err(`${err.usage}\n`);
      return err.exitCode;
    }
    deps.streams.err(`error: ${(err as Error).message}\n`);
    return EXIT.RUNTIME;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const code = await run(argv, { streams: nodeStreams(), now: Date.now() });
  process.exitCode = code;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  void main();
}
