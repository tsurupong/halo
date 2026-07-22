// min-autonomy: L1
// context-recent-failures (D1 §1.2): 過去失敗の再注入 context プラグイン。
// stdin の task-source.out JSON (op=next の出力) を受け取り、on-fail-record が併記する
// JSONL カタログ (.halo/failure-catalog.jsonl) から同一 task_id の直近 N 件を拾って
// ContextOut の fragment として返す (失敗学習ループ、要件 §3.2 原則7)。
// core の lastFailure 再注入は直前 1 回分のみのため、本プラグインが履歴横断分を補完する。
// ベストエフォート: カタログ不在・不正行はスキップし、常に有効な ContextOut を返す。
import { readFileSync } from 'node:fs';
import { readStdinJson, writeStdoutJson, str } from '../lib/io.js';

const EMPTY = { fragments: [] };

const input = await readStdinJson().catch(() => undefined);
const taskId = str(input, 'task_id');
if (taskId === undefined) {
  writeStdoutJson(EMPTY);
  process.exit(0);
}

// カタログは安定領域 (cwd = 対象リポジトリ root)。on-fail-record の既定と揃える。
const catalogJsonl = process.env['HALO_CATALOG_JSONL'] ?? '.halo/failure-catalog.jsonl';
const maxRaw = Number(process.env['HALO_RECENT_FAILURES_MAX'] ?? '5');
const max = Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : 5;

let body: string;
try {
  body = readFileSync(catalogJsonl, 'utf8');
} catch {
  writeStdoutJson(EMPTY);
  process.exit(0);
}

interface FailureRecord {
  ts?: string;
  task_id?: string;
  gate?: string;
  retry_count?: number;
  reason?: string;
}

const matches: FailureRecord[] = [];
for (const line of body.split('\n')) {
  const trimmed = line.trim();
  if (trimmed === '') continue;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const rec = parsed as FailureRecord;
      if (rec.task_id === taskId) matches.push(rec);
    }
  } catch {
    // 不正行はスキップ (ベストエフォート)。
  }
}

const recent = matches.slice(-max);
if (recent.length === 0) {
  writeStdoutJson(EMPTY);
  process.exit(0);
}

const lines = recent.map(
  (r) =>
    `- [${r.ts ?? '?'}] gate=${r.gate ?? 'unknown'} retry=${r.retry_count ?? 0}: ${r.reason ?? ''}`,
);
const content =
  `このタスクの過去の失敗履歴 (直近 ${recent.length} 件)。同じ失敗を繰り返さないこと:\n` +
  lines.join('\n');
writeStdoutJson({ fragments: [{ source: 'recent-failures', content, priority: 50 }] });
process.exit(0);
