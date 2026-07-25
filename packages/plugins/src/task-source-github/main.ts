// task-source-github(D1 §1.1 / D5 §3.1): GitHub Issues をタスクの源にするアダプタ。
// stdin の task-source.in JSON(op=next/complete/fail、oneOf)を受け取り、gh CLI を叩く。
//   next     : ready 先頭 Issue を取得し ready→in-progress へ付け替え、task-source.out を stdout へ。
//              ready 0 件なら {"task_id":null} + exit 0。
//   complete : 完了記録(in-progress→done、PR URL をコメント)。副作用のみ、stdout 空。
//   fail     : リトライをコメント記録。通算回数が THRESHOLD 未満なら ready へ戻して再供給し、
//              到達したら needs-human を付与する。副作用のみ。
// stdout は JSON 契約チャネル。complete/fail では何も出さない(D1 §3.2)。
import { readStdinJson, writeStdoutJson, diag, str } from '../lib/io.js';
import { run } from '../lib/exec.js';

const failThreshold = Number(process.env['HALO_FAIL_THRESHOLD'] ?? '3');

function die(msg: string, code = 2): never {
  diag(`task-source-github: ${msg}`);
  process.exit(code);
}

/**
 * gh を実行し、stderr は診断チャネルへ流す。**非0終了は必ず致命扱いにする**。
 *
 * 握り潰すと認証切れ・レート制限・ネットワーク断で stdout が空になり、`op=next` が
 * `{"task_id":null}` + exit 0 を返してしまう。コアはそれを健全なアイドルと解釈して
 * NO_TASK でクリーン終了するため、一晩中何もせず「正常」と記録される(H3)。
 * exit 2 で落とせばコアは TASK_SOURCE_ERROR として区別できる (D1 §3.1 / D2 §2.7)。
 */
function gh(args: string[], what: string): { code: number; stdout: string } {
  const r = run('gh', args);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  if (r.code === 127) die('依存コマンド欠落: gh');
  if (r.code !== 0) die(`${what} に失敗 (gh exit ${r.code}): gh ${args.join(' ')}`);
  return { code: r.code, stdout: r.stdout };
}

/**
 * この Issue が過去に何回失敗したかを GitHub 側から導出する (N4)。`fail #N:` 形式の
 * コメント数を数える。取得・解析できなければ 0 を返し、呼び出し側がコアの retry_count に
 * フォールバックする — 回数が過小になっても「エスカレーションが遅れる」だけで、
 * 誤って needs-human を早期に付けるよりは安全側。
 */
function pastFailureCount(num: string): number {
  const out = gh(
    ['issue', 'view', num, '--json', 'comments'],
    `Issue #${num} の失敗履歴取得`,
  ).stdout;
  try {
    const parsed = JSON.parse(out) as { comments?: unknown };
    const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
    return comments.filter((c) => {
      const body = (c as Record<string, unknown>)['body'];
      return typeof body === 'string' && /^fail #\d+:/.test(body);
    }).length;
  } catch {
    return 0;
  }
}

const input = await readStdinJson().catch(() => undefined);
const op = str(input, 'op');

switch (op) {
  case 'next': {
    const list = gh(
      [
        'issue',
        'list',
        '--label',
        'ready',
        '--state',
        'open',
        '--limit',
        '1',
        '--json',
        'number,title,body,labels',
      ],
      'ready Issue の取得',
    );
    // ここに来る時点で gh は exit 0。したがってパース失敗は「ready 0 件」ではなく
    // 出力形式の異常なので、null を返さず障害として落とす(H3 と同じ理由)。
    let issues: unknown;
    try {
      issues = JSON.parse(list.stdout);
    } catch {
      die(`gh issue list の出力が JSON ではありません: ${list.stdout.slice(0, 200)}`);
    }
    const issue = Array.isArray(issues)
      ? (issues[0] as Record<string, unknown> | undefined)
      : undefined;
    if (issue === undefined) {
      writeStdoutJson({ task_id: null }); // ready 0 件 → コアは即 exit 0
      process.exit(0);
    }
    const num = issue['number'];
    if (typeof num !== 'number' || !Number.isInteger(num)) die('invalid issue number from gh');
    // kind:<name> ラベル由来。無指定時は code(D5 §3.1)。
    const labels = Array.isArray(issue['labels'])
      ? (issue['labels'] as Record<string, unknown>[])
      : [];
    const kindLabel = labels
      .map((l) => (typeof l['name'] === 'string' ? l['name'] : ''))
      .find((n) => n.startsWith('kind:'));
    const kind = (kindLabel ?? 'kind:code').replace(/^kind:/, '');
    // 多重取得防止のロック(ready→in-progress)。ここが失敗したまま払い出すと同じ Issue を
    // 何度も取得し続けるので、ロックできなければタスクを渡さず落とす(N5)。
    gh(
      ['issue', 'edit', String(num), '--add-label', 'in-progress', '--remove-label', 'ready'],
      `Issue #${num} のロック (ready→in-progress)`,
    );
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
    gh(['issue', 'comment', num, '--body', `completed via PR: ${prUrl}`], '完了コメントの投稿');
    gh(
      ['issue', 'edit', num, '--add-label', 'done', '--remove-label', 'in-progress'],
      `Issue #${num} の完了ラベル付与`,
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
    const num = taskId.replace(/^T-/, '');
    // 失敗回数の真実の源は GitHub 側 (ADR-0009 ゼロ・グローバル状態)。コアの retry_count は
    // runLoop 内の in-memory 値なので、trigger が run を都度起動する運用では毎回 1 から
    // 始まり閾値に到達しない (N4)。過去の `fail #N:` コメント数から通算回数を導出する。
    const attempts = Math.max(pastFailureCount(num) + 1, rc);
    gh(['issue', 'comment', num, '--body', `fail #${attempts}: ${reason}`], '失敗コメントの投稿');
    if (attempts >= failThreshold) {
      // 閾値到達 → needs-human でエスカレーション(無限ループ遮断)。
      gh(
        ['issue', 'edit', num, '--add-label', 'needs-human', '--remove-label', 'in-progress'],
        `Issue #${num} の needs-human エスカレーション`,
      );
    } else {
      // C1: 閾値未満なら ready へ戻す。戻さないと op=next (--label ready) が二度と拾わず、
      // リトライも失敗理由の再注入 (D2 §2.4) も起きないまま in-progress で滞留する。
      gh(
        ['issue', 'edit', num, '--add-label', 'ready', '--remove-label', 'in-progress'],
        `Issue #${num} の再供給 (in-progress→ready)`,
      );
    }
    break;
  }
  default:
    die(`unknown op: '${op ?? ''}'`);
}
process.exit(0);
