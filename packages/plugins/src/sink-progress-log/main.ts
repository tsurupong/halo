// min-autonomy: L1
// sink-progress-log / 20-progress-log(D1 §1.5 / D5 §2.5 / 03 §4.3): 進捗の構造化記録 sink。
// stdin の sink.in JSON {task_id, workdir, summary} を受け取り、logs/ へ 1 行 JSON を追記する。
// minAutonomy L1: 副作用なしの記録のみ(コード変更を成果物として残さない、観察運転用)。
// ベストエフォート(部分失敗許容、03 §4.1)。出力は無し、stdout は空に保つ。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readStdinJson, diag, str } from '../lib/io.js';

const input = await readStdinJson().catch(() => undefined);
const taskId = str(input, 'task_id');
const workdir = str(input, 'workdir');
const summary = str(input, 'summary') ?? '';

if (taskId === undefined || workdir === undefined) {
  diag('sink-progress-log: task_id/workdir 欠落のためスキップ');
  process.exit(0);
}

// ログ先は安定領域(cwd = 対象リポジトリ root、コアの runner が保証)。
// workdir は使い捨て worktree で削除と同時に記録が消えるため既定にしない。
const logsDir = process.env['HALO_LOGS_DIR'] ?? '.halo/logs';
try {
  mkdirSync(logsDir, { recursive: true });
} catch {
  diag(`sink-progress-log: logs ディレクトリ作成失敗: ${logsDir}`);
  process.exit(0);
}

const now = new Date();
const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
const logfile = join(logsDir, `progress-${ts.slice(0, 10)}.jsonl`);
try {
  appendFileSync(logfile, `${JSON.stringify({ ts, task_id: taskId, workdir, summary })}\n`);
} catch {
  diag(`sink-progress-log: 追記失敗: ${logfile}`);
}
process.exit(0);
