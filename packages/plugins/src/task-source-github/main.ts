// task-source-github(D1 §1.1 / D5 §3.1): GitHub Issues をタスクの源にするアダプタ。
// stdin の task-source.in JSON(op=next/complete/fail、oneOf)を受け取り、gh CLI を叩く。
//   next     : ready 先頭 Issue を取得し ready→in-progress へ付け替え、task-source.out を stdout へ。
//              ready 0 件なら {"task_id":null} + exit 0。
//   complete : 完了記録(in-progress→done、PR URL をコメント)。副作用のみ、stdout 空。
//   fail     : リトライをコメント記録。retry_count>=THRESHOLD で needs-human 付与。副作用のみ。
// stdout は JSON 契約チャネル。complete/fail では何も出さない(D1 §3.2)。
import { readStdinJson, writeStdoutJson, diag, str } from '../lib/io.js';
import { run } from '../lib/exec.js';

const failThreshold = Number(process.env['HALO_FAIL_THRESHOLD'] ?? '3');

function die(msg: string, code = 2): never {
  diag(`task-source-github: ${msg}`);
  process.exit(code);
}

/** gh を実行し、stderr は診断チャネルへ流す。 */
function gh(args: string[]): { code: number; stdout: string } {
  const r = run('gh', args);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  if (r.code === 127) die('依存コマンド欠落: gh');
  return { code: r.code, stdout: r.stdout };
}

const input = await readStdinJson().catch(() => undefined);
const op = str(input, 'op');

switch (op) {
  case 'next': {
    const list = gh([
      'issue', 'list', '--label', 'ready', '--state', 'open', '--limit', '1',
      '--json', 'number,title,body,labels',
    ]);
    let issues: unknown;
    try {
      issues = JSON.parse(list.stdout);
    } catch {
      issues = [];
    }
    const issue = Array.isArray(issues) ? (issues[0] as Record<string, unknown> | undefined) : undefined;
    if (issue === undefined) {
      writeStdoutJson({ task_id: null }); // ready 0 件 → コアは即 exit 0
      process.exit(0);
    }
    const num = issue['number'];
    if (typeof num !== 'number' || !Number.isInteger(num)) die('invalid issue number from gh');
    // kind:<name> ラベル由来。無指定時は code(D5 §3.1)。
    const labels = Array.isArray(issue['labels']) ? (issue['labels'] as Record<string, unknown>[]) : [];
    const kindLabel = labels
      .map((l) => (typeof l['name'] === 'string' ? l['name'] : ''))
      .find((n) => n.startsWith('kind:'));
    const kind = (kindLabel ?? 'kind:code').replace(/^kind:/, '');
    // 多重取得防止のロック(ready→in-progress)。診断は stderr へ。
    gh(['issue', 'edit', String(num), '--add-label', 'in-progress', '--remove-label', 'ready']);
    writeStdoutJson({
      task_id: `T-${num}`,
      title: typeof issue['title'] === 'string' ? issue['title'] : '',
      body: typeof issue['body'] === 'string' ? issue['body'] : '',
      kind,
    });
    break;
  }
  case 'complete': {
    const taskId = str(input, 'task_id');
    const prUrl = str(input, 'pr_url');
    if (taskId === undefined || prUrl === undefined) die('complete requires task_id and pr_url');
    const num = taskId.replace(/^T-/, '');
    // PR 本文の Closes #num でマージ時に自動クローズされる前提。ここでは記録のみ。
    gh(['issue', 'comment', num, '--body', `completed via PR: ${prUrl}`]);
    gh(['issue', 'edit', num, '--add-label', 'done', '--remove-label', 'in-progress']);
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
    const num = taskId.replace(/^T-/, '');
    gh(['issue', 'comment', num, '--body', `fail #${rc}: ${reason}`]);
    // 同一 Issue で THRESHOLD 回失敗 → needs-human でエスカレーション(無限ループ遮断)。
    if (rc >= failThreshold) {
      gh(['issue', 'edit', num, '--add-label', 'needs-human', '--remove-label', 'in-progress']);
    }
    break;
  }
  default:
    die(`unknown op: '${op ?? ''}'`);
}
process.exit(0);
