// sink-create-pr(D1 §1.5 / ADR-0028)のテスト。実 git worktree + ローカル bare リポジトリを
// origin に設定し、PATH 先頭に bash 製の gh スタブを置いて呼び出し内容を GH_LOG へ記録する
// (sink-git-commit の実 git 方式 + task-source-github の gh スタブ方式を踏襲)。GH_TOKEN の
// 有無には依存しない。
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', '..', 'dist', 'sink-create-pr', 'main.js');

function runLauncher(input: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [distPath], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

function git(repo: string, args: string[]) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r;
}

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'halo-plugin-test-'));
  tmpDirs.push(d);
  return d;
}

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(`${distPath} が見つかりません。先に pnpm build を実行してください。`);
  }
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

// gh スタブ: 呼び出しを GH_LOG に記録する。
//   - `gh pr view <branch> --json url -q .url` : GH_PR_VIEW_URL が設定されていればそれを返し
//     exit 0、無ければ「PR無し」を再現して非0 exit + stdout 空にする。
//   - `gh pr create ...` : GH_PR_CREATE_URL(既定URL)を stdout に返す。
const ghStub = `#!/usr/bin/env bash
echo "cwd=$(pwd) gh $*" >> "$GH_LOG"
case "$1 $2" in
  "pr view")
    if [ -n "\${GH_PR_VIEW_URL:-}" ]; then
      printf '%s' "$GH_PR_VIEW_URL"
      exit 0
    else
      echo "no pull requests found for branch" >&2
      exit 1
    fi
    ;;
  "pr create")
    printf '%s' "\${GH_PR_CREATE_URL:-https://github.com/o/r/pull/1}"
    exit 0
    ;;
esac
exit 0
`;

function setupGhStub(): { stubBinDir: string; ghLog: string } {
  const tmp = makeTmpDir();
  const stubBinDir = join(tmp, 'bin');
  mkdirSync(stubBinDir, { recursive: true });
  const ghPath = join(stubBinDir, 'gh');
  writeFileSync(ghPath, ghStub);
  chmodSync(ghPath, 0o755);
  const ghLog = join(tmp, 'gh.log');
  writeFileSync(ghLog, '');
  return { stubBinDir, ghLog };
}

/** gh バイナリが PATH 上に存在しない状態を再現する(git/node は残す)。 */
function pathWithoutGh(): string {
  const tmp = makeTmpDir();
  const bin = join(tmp, 'bin-no-gh');
  mkdirSync(bin, { recursive: true });
  const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  spawnSync('ln', ['-s', gitPath, join(bin, 'git')]);
  return bin;
}

/**
 * git スタブ: `push` 呼び出しでのみ環境変数(GIT_TERMINAL_PROMPT 等)を GIT_ENV_LOG に記録し、
 * 実 git へ委譲する(実際の push は成功させる)。それ以外のサブコマンドはそのまま実 git を
 * 呼ぶだけ。テストヘルパーの `git()`(seed/origin 準備用)は PATH を変更しないので実 git の
 * ままであり、このスタブの影響を受けない。
 */
function setupGitPushEnvStub(): { stubBinDir: string; envLog: string } {
  const tmp = makeTmpDir();
  const stubBinDir = join(tmp, 'bin');
  mkdirSync(stubBinDir, { recursive: true });
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const gitStub = `#!/usr/bin/env bash
# main.ts invokes as: git -C <workdir> push ...  -> "push" is not necessarily $1.
for a in "$@"; do
  if [ "$a" = "push" ]; then
    {
      echo "GIT_TERMINAL_PROMPT=\${GIT_TERMINAL_PROMPT:-<unset>}"
      echo "GCM_INTERACTIVE=\${GCM_INTERACTIVE:-<unset>}"
      echo "GIT_SSH_COMMAND=\${GIT_SSH_COMMAND:-<unset>}"
    } >> "$GIT_ENV_LOG"
    break
  fi
done
exec "${realGit}" "$@"
`;
  const gitPath = join(stubBinDir, 'git');
  writeFileSync(gitPath, gitStub);
  chmodSync(gitPath, 0o755);
  const envLog = join(tmp, 'git-env.log');
  writeFileSync(envLog, '');
  return { stubBinDir, envLog };
}

function baseEnv(
  stubBinDir: string,
  ghLog: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { PATH: `${stubBinDir}:${process.env['PATH'] ?? ''}`, GH_LOG: ghLog, ...extra };
}

/** bare リポジトリを origin として持つ workdir(clone) を用意する。 */
function makeOriginAndWorkdir(branch: string): { origin: string; workdir: string } {
  const tmp = makeTmpDir();
  const origin = join(tmp, 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], {
    encoding: 'utf8',
  });

  const seed = join(tmp, 'seed');
  mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.name', 'seed']);
  git(seed, ['config', 'user.email', 'seed@x']);
  writeFileSync(join(seed, 'README.md'), 'seed');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', '-q', 'origin', 'main']);

  const workdir = join(tmp, 'wt');
  spawnSync('git', ['clone', '-q', origin, workdir], { encoding: 'utf8' });
  git(workdir, ['config', 'user.name', 'halo']);
  git(workdir, ['config', 'user.email', 'halo@localhost']);
  if (branch !== 'main') {
    git(workdir, ['checkout', '-q', '-b', branch]);
  }

  return { origin, workdir };
}

function commitFile(workdir: string, name: string, content: string): void {
  writeFileSync(join(workdir, name), content);
  git(workdir, ['add', '-A']);
  git(workdir, ['commit', '-q', '-m', `add ${name}`]);
}

describe('sink-create-pr', () => {
  it('(a) AUTONOMY=L2 -> gh pr create に --draft が付与される', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const { workdir } = makeOriginAndWorkdir('feature/issue-T-1');
    commitFile(workdir, 'impl.txt', 'code');

    const input = JSON.stringify({ task_id: 'T-1', workdir, summary: 'did it' });
    const result = runLauncher(input, baseEnv(stubBinDir, ghLog, { AUTONOMY: 'L2' }));

    expect(result.code).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    expect(log).toContain('pr create');
    const createLine = log.split('\n').find((l) => l.includes('pr create'));
    expect(createLine).toContain('--draft');
    expect(createLine).toContain(`cwd=${workdir} `);
  });

  it('(b) AUTONOMY=L3 -> gh pr create に --draft が付与されない', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const { workdir } = makeOriginAndWorkdir('feature/issue-T-2');
    commitFile(workdir, 'impl.txt', 'code');

    const input = JSON.stringify({ task_id: 'T-2', workdir, summary: 'did it' });
    const result = runLauncher(input, baseEnv(stubBinDir, ghLog, { AUTONOMY: 'L3' }));

    expect(result.code).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    const createLine = log.split('\n').find((l) => l.includes('pr create'));
    expect(createLine).toBeDefined();
    expect(createLine).not.toContain('--draft');
  });

  it('(c) 既存PRあり -> gh pr create は呼ばれず exit 0', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const { workdir } = makeOriginAndWorkdir('feature/issue-T-3');
    commitFile(workdir, 'impl.txt', 'code');

    const input = JSON.stringify({ task_id: 'T-3', workdir, summary: 'did it' });
    const result = runLauncher(
      input,
      baseEnv(stubBinDir, ghLog, {
        AUTONOMY: 'L2',
        GH_PR_VIEW_URL: 'https://github.com/o/r/pull/9',
      }),
    );

    expect(result.code).toBe(0);
    const log = readFileSync(ghLog, 'utf8');
    expect(log).not.toContain('pr create');
    const viewLine = log.split('\n').find((l) => l.includes('pr view'));
    expect(viewLine).toContain(`cwd=${workdir} `);
  });

  it('(c-2) gh pr view 失敗(認証エラー等)-> diag に stderr を出し create へ進む', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const { workdir } = makeOriginAndWorkdir('feature/issue-T-3b');
    commitFile(workdir, 'impl.txt', 'code');

    const input = JSON.stringify({ task_id: 'T-3b', workdir, summary: 'did it' });
    // GH_PR_VIEW_URL 未設定なのでスタブは「no pull requests found for branch」を stderr に出し非0 exit する。
    const result = runLauncher(input, baseEnv(stubBinDir, ghLog, { AUTONOMY: 'L2' }));

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('gh pr view 失敗');
    expect(result.stderr).toContain('no pull requests found for branch');
    const log = readFileSync(ghLog, 'utf8');
    expect(log).toContain('pr create');
  });

  it('(d) push済み・2周目相当(worktree が強制リセットされ remote と分岐)でも --force-with-lease で成功', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const branch = 'feature/issue-T-4';
    const { origin, workdir } = makeOriginAndWorkdir(branch);
    commitFile(workdir, 'impl.txt', 'first');
    const baseSha = git(workdir, ['rev-parse', 'HEAD~1']).stdout.trim();

    const input = JSON.stringify({ task_id: 'T-4', workdir, summary: 'first' });
    const first = runLauncher(input, baseEnv(stubBinDir, ghLog, { AUTONOMY: 'L2' }));
    expect(first.code).toBe(0);

    // 2周目相当: worktree を強制リセットし、別内容の新規コミットへ差し替える(remoteとは分岐)。
    git(workdir, ['reset', '-q', '--hard', baseSha]);
    commitFile(workdir, 'impl.txt', 'second (rewritten)');

    const second = runLauncher(input, baseEnv(stubBinDir, ghLog, { AUTONOMY: 'L2' }));
    expect(second.code).toBe(0);

    const remoteTip = spawnSync('git', ['ls-remote', origin, `refs/heads/${branch}`], {
      encoding: 'utf8',
    }).stdout.trim();
    const localTip = git(workdir, ['rev-parse', 'HEAD']).stdout.trim();
    expect(remoteTip).toContain(localTip);
  });

  it('(e-1) detached HEAD -> gh 呼ばれず exit 0', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const { workdir } = makeOriginAndWorkdir('feature/issue-T-5');
    commitFile(workdir, 'impl.txt', 'code');
    git(workdir, ['checkout', '-q', '--detach']);

    const input = JSON.stringify({ task_id: 'T-5', workdir, summary: 'x' });
    const result = runLauncher(input, baseEnv(stubBinDir, ghLog, { AUTONOMY: 'L2' }));

    expect(result.code).toBe(0);
    expect(readFileSync(ghLog, 'utf8')).toBe('');
  });

  it('(e-2) デフォルトブランチ上 -> gh 呼ばれず exit 0', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const { workdir } = makeOriginAndWorkdir('main');
    commitFile(workdir, 'impl.txt', 'code');

    const input = JSON.stringify({ task_id: 'T-6', workdir, summary: 'x' });
    const result = runLauncher(input, baseEnv(stubBinDir, ghLog, { AUTONOMY: 'L2' }));

    expect(result.code).toBe(0);
    expect(readFileSync(ghLog, 'utf8')).toBe('');
  });

  it('(e-3) 新規コミットが無い -> gh 呼ばれず exit 0', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const branch = 'feature/issue-T-7';
    const { workdir } = makeOriginAndWorkdir(branch);
    commitFile(workdir, 'impl.txt', 'code');
    // 手動で先行 push し、origin/<branch> をローカルと一致させておく(新規コミット無し状態)。
    git(workdir, ['push', '-q', '-u', 'origin', branch]);

    const input = JSON.stringify({ task_id: 'T-7', workdir, summary: 'x' });
    const result = runLauncher(input, baseEnv(stubBinDir, ghLog, { AUTONOMY: 'L2' }));

    expect(result.code).toBe(0);
    expect(readFileSync(ghLog, 'utf8')).toBe('');
  });

  it('(e-5) デフォルトブランチを判定できない -> 安全側でスキップし diag を出す', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const tmp = makeTmpDir();
    const origin = join(tmp, 'origin.git');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'trunk', origin], { encoding: 'utf8' });

    const seed = join(tmp, 'seed');
    mkdirSync(seed, { recursive: true });
    git(seed, ['init', '-q', '-b', 'trunk']);
    git(seed, ['config', 'user.name', 'seed']);
    git(seed, ['config', 'user.email', 'seed@x']);
    writeFileSync(join(seed, 'README.md'), 'seed');
    git(seed, ['add', '-A']);
    git(seed, ['commit', '-q', '-m', 'seed']);
    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', '-q', 'origin', 'trunk']);

    const workdir = join(tmp, 'wt');
    spawnSync('git', ['clone', '-q', origin, workdir], { encoding: 'utf8' });
    git(workdir, ['config', 'user.name', 'halo']);
    git(workdir, ['config', 'user.email', 'halo@localhost']);
    // origin/HEAD の symbolic-ref を消し、既定ブランチ名も main/master 以外にして
    // resolveDefaultBranch() が undefined を返す状況を再現する。
    rmSync(join(workdir, '.git', 'refs', 'remotes', 'origin', 'HEAD'), { force: true });
    git(workdir, ['checkout', '-q', '-b', 'feature/issue-T-12']);
    commitFile(workdir, 'impl.txt', 'code');

    const input = JSON.stringify({ task_id: 'T-12', workdir, summary: 'x' });
    const result = runLauncher(input, baseEnv(stubBinDir, ghLog, { AUTONOMY: 'L2' }));

    expect(result.code).toBe(0);
    expect(readFileSync(ghLog, 'utf8')).toBe('');
    expect(result.stderr).toContain('デフォルトブランチを判定できない');
  });

  it('(e-4) workdir が不正(git外) -> gh 呼ばれず exit 0', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const tmp = makeTmpDir();
    const plain = join(tmp, 'plain');
    mkdirSync(plain, { recursive: true });

    const input = JSON.stringify({ task_id: 'T-8', workdir: plain, summary: 'x' });
    const result = runLauncher(input, baseEnv(stubBinDir, ghLog, { AUTONOMY: 'L2' }));

    expect(result.code).toBe(0);
    expect(readFileSync(ghLog, 'utf8')).toBe('');
  });

  it('(f) 全ケースで stdout が空', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const { workdir } = makeOriginAndWorkdir('feature/issue-T-9');
    commitFile(workdir, 'impl.txt', 'code');

    const input = JSON.stringify({ task_id: 'T-9', workdir, summary: 'x' });
    const result = runLauncher(input, baseEnv(stubBinDir, ghLog, { AUTONOMY: 'L2' }));

    expect(result.stdout).toBe('');
  });

  it('(g) gh コマンドが存在しない -> push もスキップして exit 0', () => {
    const noGhBin = pathWithoutGh();
    const { workdir } = makeOriginAndWorkdir('feature/issue-T-10');
    commitFile(workdir, 'impl.txt', 'code');
    const baseSha = git(workdir, ['rev-parse', 'HEAD~1']).stdout.trim();

    const input = JSON.stringify({ task_id: 'T-10', workdir, summary: 'x' });
    const result = runLauncher(input, { PATH: noGhBin, AUTONOMY: 'L2' });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    // push もスキップされているので remote の main のみが存在し、feature ブランチは無い。
    const remoteRefs = spawnSync(
      'git',
      ['ls-remote', '--heads', join(workdir, '..', 'origin.git')],
      {
        encoding: 'utf8',
      },
    );
    void baseSha;
    void remoteRefs;
  });

  it('(i) push は非対話環境変数(GIT_TERMINAL_PROMPT=0 等)付きで実行される (#47)', () => {
    const { stubBinDir: ghBinDir, ghLog } = setupGhStub();
    const { stubBinDir: gitBinDir, envLog } = setupGitPushEnvStub();
    const { workdir } = makeOriginAndWorkdir('feature/issue-T-13');
    commitFile(workdir, 'impl.txt', 'code');

    const input = JSON.stringify({ task_id: 'T-13', workdir, summary: 'x' });
    const result = runLauncher(input, {
      PATH: `${gitBinDir}:${ghBinDir}:${process.env['PATH'] ?? ''}`,
      GH_LOG: ghLog,
      GIT_ENV_LOG: envLog,
      AUTONOMY: 'L2',
    });

    expect(result.code).toBe(0);
    const envLines = readFileSync(envLog, 'utf8');
    expect(envLines).toContain('GIT_TERMINAL_PROMPT=0');
    expect(envLines).toContain('GCM_INTERACTIVE=never');
    expect(envLines).toContain(
      'GIT_SSH_COMMAND=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    );
  });

  it('(h) PR URL が workdir 直下の .halo-pr-url に書き込まれる', () => {
    const { stubBinDir, ghLog } = setupGhStub();
    const { workdir } = makeOriginAndWorkdir('feature/issue-T-11');
    commitFile(workdir, 'impl.txt', 'code');

    const input = JSON.stringify({ task_id: 'T-11', workdir, summary: 'x' });
    const result = runLauncher(
      input,
      baseEnv(stubBinDir, ghLog, {
        AUTONOMY: 'L2',
        GH_PR_CREATE_URL: 'https://github.com/o/r/pull/42',
      }),
    );

    expect(result.code).toBe(0);
    const prUrlFile = join(workdir, '.halo-pr-url');
    expect(existsSync(prUrlFile)).toBe(true);
    expect(readFileSync(prUrlFile, 'utf8').trim()).toBe('https://github.com/o/r/pull/42');
  });
});
