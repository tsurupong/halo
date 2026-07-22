// `halo history` (D9 §3 拡張): iter_N.json 群の時系列一覧。status がサマリ、history が明細。
import { stringFlag, type ParsedArgs } from '../args.js';
import type { ExitCode } from '../exit-codes.js';
import { EXIT } from '../exit-codes.js';
import type { Io } from '../io.js';
import type { CliFs } from '../core-ext/fs.js';
import type { IterationLog } from '@tsurupong/halo-core';
import { classifyFailure, loadRuns, DEFAULT_SUMMARY_WINDOW_DAYS } from './status.js';

export interface HistoryDeps {
  fs: CliFs;
  now: number;
}

/** 一覧の既定最大件数。`--limit` で上書き可能。 */
export const DEFAULT_HISTORY_LIMIT = 20;

function join(a: string, b: string): string {
  return `${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`;
}

/** history 1 行分の表示用写像。 */
export interface HistoryRow {
  iter: number;
  started_at: string;
  outcome: string;
  task_id: string | null;
  retry_count: number;
  /** 失敗時のみ理由分類 (classifyFailure)。それ以外は null。 */
  category: string | null;
  /** executor コスト (usd_estimate)。欠損は null。 */
  usd: number | null;
}

/**
 * 期間内の iter を started_at 昇順に整列し、末尾 (=新しい側) から limit 件を返す。純粋。
 * started_at が解釈不能な iter は除外する (status の aggregateRuns と同じ方針)。
 */
export function selectHistory(
  entries: readonly IterationLog[],
  options: { windowDays: number; now: number; limit: number },
): HistoryRow[] {
  const cutoff = options.now - options.windowDays * 24 * 60 * 60 * 1000;
  const inWindow = entries
    .map((entry) => ({ entry, startedMs: Date.parse(entry.started_at) }))
    .filter(
      ({ startedMs }) =>
        !Number.isNaN(startedMs) && startedMs >= cutoff && startedMs <= options.now,
    )
    .sort((a, b) => a.startedMs - b.startedMs || a.entry.iter - b.entry.iter);
  return inWindow.slice(-options.limit).map(({ entry }) => ({
    iter: entry.iter,
    started_at: entry.started_at,
    outcome: entry.outcome,
    task_id: entry.task?.task_id ?? null,
    retry_count: entry.task?.retry_count ?? 0,
    category:
      entry.outcome === 'failed' || entry.outcome === 'escalated' ? classifyFailure(entry) : null,
    usd: entry.executor?.cost?.usd_estimate ?? null,
  }));
}

export async function historyCommand(
  parsed: ParsedArgs,
  io: Io,
  deps: HistoryDeps,
): Promise<ExitCode> {
  const logDir = join(join(io.flags.cwd, '.halo'), 'logs');

  // --days / --limit: 不正値・未指定は既定 (status と同じ graceful degrade)。
  const daysRaw = Number(stringFlag(parsed, 'days'));
  const windowDays =
    Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : DEFAULT_SUMMARY_WINDOW_DAYS;
  const limitRaw = Number(stringFlag(parsed, 'limit'));
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_HISTORY_LIMIT;

  const rows = selectHistory(await loadRuns(logDir, deps.fs), {
    windowDays,
    now: deps.now,
    limit,
  });

  if (io.flags.json) {
    io.printJson({ ok: true, windowDays, rows });
    return EXIT.OK;
  }

  if (rows.length === 0) {
    io.print(`直近${windowDays}日の実行履歴はありません。`);
    return EXIT.OK;
  }
  io.print(`直近${windowDays}日の実行履歴 (${rows.length} 件、古い順):`);
  for (const row of rows) {
    const parts = [
      `iter ${row.iter}`,
      row.started_at,
      row.outcome,
      row.task_id ?? '-',
      `retry ${row.retry_count}`,
    ];
    if (row.category !== null) parts.push(row.category);
    if (row.usd !== null) parts.push(`$${row.usd.toFixed(2)}`);
    io.print(parts.join(' | '));
  }
  return EXIT.OK;
}
