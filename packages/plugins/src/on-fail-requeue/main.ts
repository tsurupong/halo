// on-fail-requeue / 20-requeue-transient(D9 §4 / ADR-0014): transient 失敗の自動再供給。
// stdin の on-fail.in JSON {task_id, reason, retry_count, gate?, workdir?} を受け取り、
// reason が一時的失敗(rate limit / flaky / ネットワーク断 / timeout)に見える場合のみ、
// ローカルタスクソースのタスクファイル <task_id>.md を queue/ へ戻す。試行回数は
// ${HALO_REQUEUE_DIR}/<task_id>.count で永続化し、上限到達で quarantine/ へ隔離する
// (削除はしない — 上限超過は必ず移動で表現、ADR-0014)。
// record(order 10)が先に failure-catalog へ記録した後に走る(order 20)。
// ベストエフォート(部分失敗許容)。出力は無し、stdout は空に保つ。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStdinJson, diag, str } from '../lib/io.js';

const TRANSIENT_RE = /rate.?limit|429|flaky|ECONNRESET|ETIMEDOUT|ENETUNREACH|timed?.?out|temporar/i;
const maxAttempts = Number(process.env['REQUEUE_MAX_ATTEMPTS'] ?? '3');
const requeueDir = process.env['HALO_REQUEUE_DIR'] ?? '.halo/requeue';
const tasksDir = process.env['HALO_TASKS_DIR'] ?? '.halo/tasks';

const input = await readStdinJson().catch(() => undefined);
const taskId = str(input, 'task_id');
const reason = str(input, 'reason') ?? '';

// task_id はファイル名に使うため厳格に検証(パス区切り等の混入を拒否して exit 0)。
if (taskId === undefined || !/^[A-Za-z0-9._-]+$/.test(taskId)) {
  diag(`on-fail-requeue: task_id 不正のためスキップ: [${taskId ?? ''}]`);
  process.exit(0);
}

// 非 transient は再投入しない(人間の判断待ち。record が記録済み)。
if (!TRANSIENT_RE.test(reason)) {
  process.exit(0);
}

// 試行カウンタを +1 して書き戻す(無ければ 0 起点)。
const countFile = join(requeueDir, `${taskId}.count`);
let count = 0;
if (existsSync(countFile)) {
  const raw = readFileSync(countFile, 'utf8').trim();
  count = /^[0-9]+$/.test(raw) ? Number(raw) : 0;
}
count += 1;
try {
  mkdirSync(requeueDir, { recursive: true });
  writeFileSync(countFile, `${count}\n`);
} catch {
  diag(`on-fail-requeue: カウンタ書き込み失敗: ${countFile}`);
  process.exit(0);
}

// タスクファイルを tasks 配下(queue/ 以外に退避されている場合も含む)から探す。
let taskFile = '';
const subdirs = existsSync(tasksDir)
  ? readdirSync(tasksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : [];
for (const sub of subdirs) {
  const candidate = join(tasksDir, sub, `${taskId}.md`);
  if (existsSync(candidate)) {
    taskFile = candidate;
    break;
  }
}
if (taskFile === '' && existsSync(join(tasksDir, `${taskId}.md`))) {
  taskFile = join(tasksDir, `${taskId}.md`);
}
if (taskFile === '') {
  diag(`on-fail-requeue: タスクファイル不在のためスキップ: ${taskId}`);
  process.exit(0);
}

if (count < maxAttempts) {
  // 上限未満 → queue/ へ戻して次回ループで再供給させる。
  const dest = join(tasksDir, 'queue', `${taskId}.md`);
  try {
    mkdirSync(join(tasksDir, 'queue'), { recursive: true });
    if (taskFile !== dest) renameSync(taskFile, dest);
  } catch {
    diag(`on-fail-requeue: queue への移動失敗: ${taskFile}`);
  }
} else {
  // 上限到達 → quarantine/ へ隔離し、カウンタを片付ける(次回投入時は 0 起点)。
  try {
    mkdirSync(join(tasksDir, 'quarantine'), { recursive: true });
    renameSync(taskFile, join(tasksDir, 'quarantine', `${taskId}.md`));
    rmSync(countFile, { force: true });
  } catch {
    diag(`on-fail-requeue: quarantine への移動失敗: ${taskFile}`);
  }
}
process.exit(0);
