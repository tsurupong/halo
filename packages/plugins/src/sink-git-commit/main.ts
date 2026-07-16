// sink-git-commit(ADR-0016 / D1 §1.5): gate 通過済み worktree の変更をタスクブランチへ
// コミットして成果を永続化する sink。push はしない(外部公開は L2+ の別 sink の責務)。
// stdin の sink.in JSON {task_id, workdir, summary} を受け取る。
//   - 変更が無ければ何もしない(コミット無し → コアの完了判定も発火しない)
//   - コミット者はハーネス名義(HALO_GIT_NAME/EMAIL で上書き可)
// ベストエフォート(部分失敗許容)。出力は無し、stdout は空に保つ。
import { existsSync } from 'node:fs';
import { readStdinJson, diag, str } from '../lib/io.js';
import { run } from '../lib/exec.js';

const gitName = process.env['HALO_GIT_NAME'] ?? 'halo';
const gitEmail = process.env['HALO_GIT_EMAIL'] ?? 'halo@localhost';

const input = await readStdinJson().catch(() => undefined);
const taskId = str(input, 'task_id');
const workdir = str(input, 'workdir');
const summary = str(input, 'summary') ?? '';

if (taskId === undefined || workdir === undefined || !existsSync(workdir)) {
  diag('sink-git-commit: task_id/workdir 不正のためスキップ');
  process.exit(0);
}
if (run('git', ['-C', workdir, 'rev-parse', '--is-inside-work-tree']).code !== 0) {
  diag(`sink-git-commit: git worktree ではないためスキップ: ${workdir}`);
  process.exit(0);
}

if (run('git', ['-C', workdir, 'add', '-A']).code !== 0) {
  diag('sink-git-commit: git add 失敗');
  process.exit(0);
}

// ステージに変更が無ければコミットしない(成果無し = 完了させない、ADR-0016)。
if (run('git', ['-C', workdir, 'diff', '--cached', '--quiet']).code === 0) {
  diag(`sink-git-commit: 変更なし、コミットをスキップ: ${taskId}`);
  process.exit(0);
}

const commit = run('git', [
  '-C', workdir,
  '-c', `user.name=${gitName}`,
  '-c', `user.email=${gitEmail}`,
  'commit', '-m', `feat: complete task ${taskId} (halo)`, '-m', summary,
]);
if (commit.code !== 0) diag(`sink-git-commit: コミット失敗: ${taskId}`);
process.exit(0);
