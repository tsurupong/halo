// min-autonomy: L1
// on-fail-record / 10-record-failure(D1 §1.6 / D5 §2.6 / 03 §5.2): 失敗記録 on-fail プラグイン。
// stdin の on-fail.in JSON {task_id, reason, retry_count, gate?, workdir?} を受け取り、
// .halo/failure-catalog.md へインシデント 1 件を追記する(失敗学習ループの永続化層、要件 §3.2 原則7)。
// escalate(needs-human)は task-source 側で担保するため本プラグインは記録のみ。
// ベストエフォート(部分失敗許容)。出力は無し、stdout は空に保つ。
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readStdinJson, diag, str } from '../lib/io.js';

const input = await readStdinJson().catch(() => undefined);
const taskId = str(input, 'task_id');
const reason = str(input, 'reason') ?? '';
const gate = str(input, 'gate') ?? 'unknown';
const rcRaw =
  typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>)['retry_count']
    : undefined;
const retryCount = typeof rcRaw === 'number' ? rcRaw : 0;

if (taskId === undefined) {
  diag('on-fail-record: task_id 欠落のためスキップ');
  process.exit(0);
}

// カタログ先は安定領域(cwd = 対象リポジトリ root、コアの runner が保証。HALO_CATALOG で上書き可能)。
// workdir は使い捨て worktree で削除と同時に記録が消えるため既定にしない。
const catalog = process.env['HALO_CATALOG'] ?? '.halo/failure-catalog.md';
try {
  mkdirSync(dirname(catalog), { recursive: true });
} catch {
  diag(`on-fail-record: カタログディレクトリ作成失敗: ${catalog}`);
  process.exit(0);
}

const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const entry =
  `\n## ${ts} — ${taskId}\n\n` +
  `- 日時: ${ts}\n` +
  `- タスク: ${taskId}\n` +
  `- 失敗ゲート: ${gate}\n` +
  `- リトライ: ${retryCount}\n` +
  `- 理由: ${reason}\n` +
  `- 対処: \n`;
try {
  appendFileSync(catalog, entry);
} catch {
  diag(`on-fail-record: 追記失敗: ${catalog}`);
}

// 機械可読の JSONL も併記する (context-recent-failures の読み取り源)。MD は人間用に維持。
const catalogJsonl = process.env['HALO_CATALOG_JSONL'] ?? '.halo/failure-catalog.jsonl';
const record = { ts, task_id: taskId, gate, retry_count: retryCount, reason };
try {
  mkdirSync(dirname(catalogJsonl), { recursive: true });
  appendFileSync(catalogJsonl, `${JSON.stringify(record)}\n`);
} catch {
  diag(`on-fail-record: JSONL 追記失敗: ${catalogJsonl}`);
}
process.exit(0);
