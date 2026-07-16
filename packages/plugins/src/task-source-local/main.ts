// task-source-local(旧 run.sh の TS 移植, ADR-0018): ローカル md ファイルキューをタスク源にする
// アダプタ(gh 未導入環境用)。task-source-github と同じ契約(op=next/complete/fail)。
//   キュー : $HALO_TASKS_DIR/queue/*.md   (先頭の "# " 行を title、全文を body に)
//   完了   : queue → done/ へ移動(完了記録は done/<id>.result に PR URL)
//   失敗   : retry_count >= 閾値で queue → needs-human/ へ移動(エスカレーション)
// task_id はファイル名(拡張子除く)。同一タスクは complete まで queue に残り、
// コアのリトライ再注入(D2 §2.4)が同じ task_id で効く。
import {
  readdirSync,
  readFileSync,
  renameSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { readStdinJson, writeStdoutJson, diag, str } from '../lib/io.js';

const tasksDir = process.env['HALO_TASKS_DIR'] ?? join(process.cwd(), '.halo', 'tasks');
const failThreshold = Number(process.env['HALO_FAIL_THRESHOLD'] ?? '3');
const queueDir = join(tasksDir, 'queue');
const doneDir = join(tasksDir, 'done');
const needsHumanDir = join(tasksDir, 'needs-human');
mkdirSync(queueDir, { recursive: true });
mkdirSync(doneDir, { recursive: true });
mkdirSync(needsHumanDir, { recursive: true });

function die(msg: string, code = 2): never {
  diag(`task-source-local: ${msg}`);
  process.exit(code);
}

const input = await readStdinJson().catch(() => undefined);
const op = str(input, 'op');

switch (op) {
  case 'next': {
    const file = readdirSync(queueDir)
      .filter((f) => f.endsWith('.md'))
      .sort()[0];
    if (file === undefined) {
      writeStdoutJson({ task_id: null });
      process.exit(0);
    }
    const filePath = join(queueDir, file);
    const id = basename(file, '.md');
    const body = readFileSync(filePath, 'utf8');
    const titleMatch = /^# (.+)$/m.exec(body);
    const title = titleMatch !== null ? titleMatch[1] : id;
    writeStdoutJson({ task_id: id, title, body, kind: 'code' });
    break;
  }
  case 'complete': {
    const taskId = str(input, 'task_id');
    const prUrl = str(input, 'pr_url') ?? '';
    if (taskId === undefined) die('complete requires task_id');
    const src = join(queueDir, `${taskId}.md`);
    if (!existsSync(src)) die(`unknown task: ${taskId}`);
    renameSync(src, join(doneDir, `${taskId}.md`));
    writeFileSync(
      join(doneDir, `${taskId}.result`),
      `completed_at=${new Date().toISOString()}\npr_url=${prUrl}\n`,
    );
    break;
  }
  case 'fail': {
    const taskId = str(input, 'task_id');
    const reason = str(input, 'reason') ?? '';
    const rcRaw =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)['retry_count']
        : undefined;
    const rc = typeof rcRaw === 'number' ? rcRaw : 0;
    if (taskId === undefined) die('fail requires task_id');
    appendFileSync(
      join(tasksDir, 'failures.log'),
      `${new Date().toISOString()} fail #${rc}: ${reason}\n`,
    );
    if (rc >= failThreshold) {
      const src = join(queueDir, `${taskId}.md`);
      if (existsSync(src)) renameSync(src, join(needsHumanDir, `${taskId}.md`));
    }
    break;
  }
  default:
    die(`unknown op: '${op ?? ''}'`);
}
process.exit(0);
