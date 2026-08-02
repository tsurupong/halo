// sink-create-pr(D1 §1.5 / ADR-0028): gate 通過済み worktree を origin へ push し、
// GitHub PR を作成(or 既存PRを検出)する sink。PR #44 で executor の越権 push を封じた
// 結果不在になった L2+ の外部公開経路をここで担う。AUTONOMY=L2 は draft PR、L3 は通常 PR。
// stdin の sink.in JSON {task_id, workdir, summary} を受け取る。
//   - デフォルトブランチ上・detached HEAD・新規コミット無し・gh 不在は全て何もせずスキップ
//   - push は --force-with-lease(2周目以降の再実行で worktree が作り直されローカル履歴が
//     入れ替わっても、外部から誰も触れていない限り成功する)
//   - PR URL(新規作成・既存問わず)は `<workdir>/.halo-pr-url` へ書き込み、run-wiring の
//     resolvePrUrl が完了参照として拾う
// ベストエフォート(部分失敗許容)。出力は無し、stdout は空に保つ。診断は diag(stderr)のみ。
import { existsSync, writeFileSync } from 'node:fs';
import { readStdinJson, diag, str } from '../lib/io.js';
import { run, hasCmd } from '../lib/exec.js';

const input = await readStdinJson().catch(() => undefined);
const taskId = str(input, 'task_id');
const workdir = str(input, 'workdir');
const summary = str(input, 'summary') ?? '';

if (taskId === undefined || workdir === undefined || !existsSync(workdir)) {
  diag('sink-create-pr: task_id/workdir 不正のためスキップ');
  process.exit(0);
}

if (run('git', ['-C', workdir, 'rev-parse', '--is-inside-work-tree']).code !== 0) {
  diag(`sink-create-pr: git worktree ではないためスキップ: ${workdir}`);
  process.exit(0);
}

const branchRes = run('git', ['-C', workdir, 'rev-parse', '--abbrev-ref', 'HEAD']);
const branch = branchRes.stdout.trim();
if (branchRes.code !== 0 || branch === '' || branch === 'HEAD') {
  diag('sink-create-pr: detached HEAD のためスキップ');
  process.exit(0);
}

// デフォルトブランチ判定: origin/HEAD の参照先を見る。失敗時は main/master へフォールバック。
function resolveDefaultBranch(): string | undefined {
  const symbolic = run('git', ['-C', workdir!, 'symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (symbolic.code === 0) {
    const ref = symbolic.stdout.trim(); // refs/remotes/origin/<branch>
    const parts = ref.split('/');
    const name = parts[parts.length - 1];
    if (name !== undefined && name !== '') return name;
  }
  for (const candidate of ['main', 'master']) {
    if (run('git', ['-C', workdir!, 'rev-parse', '--verify', `origin/${candidate}`]).code === 0) {
      return candidate;
    }
  }
  return undefined;
}

const defaultBranch = resolveDefaultBranch();
if (defaultBranch === undefined) {
  diag('sink-create-pr: デフォルトブランチを判定できないためスキップ(安全側)');
  process.exit(0);
}
if (branch === defaultBranch) {
  diag(`sink-create-pr: デフォルトブランチ上のためスキップ: ${branch}`);
  process.exit(0);
}

// 新規コミット判定: origin/<branch> が無ければ(未 push)新規コミットありとみなす。
const revList = run('git', ['-C', workdir, 'rev-list', `origin/${branch}..HEAD`]);
if (revList.code === 0 && revList.stdout.trim() === '') {
  diag(`sink-create-pr: 新規コミット無しのためスキップ: ${branch}`);
  process.exit(0);
}

if (!hasCmd('gh')) {
  diag('sink-create-pr: gh コマンドが見つからないためスキップ(push もしない)');
  process.exit(0);
}

const push = run('git', ['-C', workdir, 'push', '--force-with-lease', '-u', 'origin', branch]);
if (push.code !== 0) {
  diag(`sink-create-pr: push 失敗: ${push.stderr}`);
  process.exit(0);
}

function writePrUrl(url: string): void {
  const trimmed = url.trim();
  if (trimmed === '') return;
  try {
    writeFileSync(`${workdir}/.halo-pr-url`, trimmed);
  } catch {
    diag('sink-create-pr: .halo-pr-url の書き込みに失敗');
  }
}

const view = run('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { cwd: workdir });
if (view.code === 0 && view.stdout.trim() !== '') {
  writePrUrl(view.stdout);
  process.exit(0);
}
if (view.code !== 0) {
  diag(`sink-create-pr: gh pr view 失敗(PR無しとみなし作成へ進む): ${view.stderr}`);
}

const createArgs = [
  'pr',
  'create',
  '--head',
  branch,
  '--title',
  `${taskId}: ${summary !== '' ? summary : 'automated change'}`,
  '--body',
  summary,
];
if (process.env['AUTONOMY'] !== 'L3') {
  createArgs.push('--draft');
}
const create = run('gh', createArgs, { cwd: workdir });
if (create.code !== 0) {
  diag(`sink-create-pr: gh pr create 失敗: ${create.stderr}`);
  process.exit(0);
}
writePrUrl(create.stdout);
process.exit(0);
