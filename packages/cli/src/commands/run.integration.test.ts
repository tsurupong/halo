// run 統合テスト (JOB1, D8 §2/§4): `runCommand` を *実 RunHooks* (createRunHooks) で
// 駆動し、実プロセス境界 (runPort + bash フィクスチャ) と実 git worktree を通す。
// executor/task-source は bash フィクスチャなのでネットワーク/claude 課金ゼロ。
// 対象リポジトリは tmpdir 上の実 git リポジトリで、.halo/ports/*.d に見本相当の
// 極小プラグインを配置する (discovery が monorepo/plugins ではなく対象リポジトリから
// 解決することの回帰も兼ねる, D2 §6)。
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { captureStreams } from '../testkit.js';
import { createNodeCliFs } from '../core-ext/fs.js';
import { createRunHooks } from '../core-ext/run-wiring.js';
import { runCommand } from './run.js';
import { EXIT } from '../exit-codes.js';

const RUN_FLAGS = {
  valueFlags: ['max-iter', 'autonomy', 'timeout', 'daily-budget', 'profiles-dir'],
};

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function writeExec(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

/** plugin.json + 実行スクリプトを 1 プラグイン分書き出す。 */
function plugin(
  port: string,
  dirName: string,
  exec: string,
  body: string,
  env: Record<string, string> = {},
): void {
  const dir = join(repo, '.halo', 'ports', `${port}.d`, dirName);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name: `@fx/${dirName}`,
    version: '1.0.0',
    port,
    exec: `./${exec}`,
    ...(Object.keys(env).length ? { env } : {}),
  };
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  writeExec(join(dir, exec), body);
}

const TASK_SOURCE = `#!/usr/bin/env bash
set -uo pipefail
in="$(cat)"
op="$(printf '%s' "$in" | jq -r '.op // "next"')"
mark="$STATE_DIR/served"
if [[ "$op" == "next" ]]; then
  if [[ -f "$mark" ]]; then jq -cn '{task_id:null}'; else touch "$mark"; jq -cn '{task_id:"7",title:"t",body:"do it"}'; fi
else
  echo "$op" >> "$STATE_DIR/ops"; jq -cn '{}'
fi
exit 0
`;

// 毎回タスクを払い出す task-source (retry/複数周回の検証用)。
const TASK_SOURCE_REPEAT = `#!/usr/bin/env bash
set -uo pipefail
in="$(cat)"; op="$(printf '%s' "$in" | jq -r '.op // "next"')"
if [[ "$op" == "next" ]]; then jq -cn '{task_id:"9",title:"t",body:"b"}'; else jq -cn '{}'; fi
exit 0
`;

const EXEC_DONE = `#!/usr/bin/env bash
cat >/dev/null; jq -cn '{status:"done",summary:"ok"}'; exit 0
`;

const GATE_PASS = `#!/usr/bin/env bash
cat >/dev/null; exit 0
`;

// worktree の HEAD を記録する executor (使い捨て worktree が常に最新 HEAD 起点である回帰用)。
const EXEC_RECORD_HEAD = `#!/usr/bin/env bash
in="$(cat)"
wd="$(printf '%s' "$in" | jq -r '.workdir')"
git -C "$wd" rev-parse HEAD > "$STATE_DIR/wt-head"
jq -cn '{status:"done",summary:"ok"}'; exit 0
`;

const GATE_FAIL = `#!/usr/bin/env bash
cat >/dev/null; jq -cn '{reason:"boom",gate:"g"}'; exit 2
`;

const ONFAIL = `#!/usr/bin/env bash
in="$(cat)"; printf '%s\\n' "$in" >> "$STATE_DIR/onfail"; exit 0
`;

function io(cap: ReturnType<typeof captureStreams>) {
  return createIo(cap.streams, { cwd: repo, json: false, quiet: true, verbose: false });
}

function deps() {
  return { fs: createNodeCliFs(), now: Date.now(), hooks: createRunHooks() };
}

function writeProfile(body = 'AUTONOMY=L1\nMAX_ITER=20\nTIMEOUT=1h\n'): void {
  const dir = join(repo, '.halo', 'profiles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'p.env'), body);
}

function logsDir(): string {
  return join(repo, '.halo', 'logs');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'halo-run-int-'));
  git('init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, '.halo', 'state'), { recursive: true });
  writeProfile();
});

afterEach(() => {
  // 生成された worktree を掃除 (create は $TMPDIR/halo-wt-issue-* を使う)。
  try {
    for (const id of ['7', '9'])
      rmSync(join(process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp', `halo-wt-issue-${id}`), {
        recursive: true,
        force: true,
      });
  } catch {
    /* ignore */
  }
  rmSync(repo, { recursive: true, force: true });
});

describe('run integration (real hooks, zero billing)', () => {
  it('happy path: task → execute → gate pass → NO_TASK → exit 0, iter log written', async () => {
    const state = join(repo, '.halo', 'state');
    plugin('task-source', 'ts', 'index.sh', TASK_SOURCE, { STATE_DIR: state });
    plugin('executor', 'ex', 'run.sh', EXEC_DONE);
    plugin('gate', '10-g', 'run.sh', GATE_PASS);
    git('add', '-A');
    git('commit', '-q', '-m', 'fixtures');

    const cap = captureStreams();
    const code = await runCommand(parseArgs(['p'], RUN_FLAGS), io(cap), deps());

    expect(code).toBe(EXIT.OK);
    expect(existsSync(join(logsDir(), 'iter_1.json'))).toBe(true);
    const log = JSON.parse(readFileSync(join(logsDir(), 'iter_1.json'), 'utf8'));
    expect(log.outcome).toBe('passed');
    expect(log.task.task_id).toBe('7');
  });

  it('stale feature branch: 既存 feature/issue-<id> があっても worktree は最新 HEAD 起点', async () => {
    const state = join(repo, '.halo', 'state');
    plugin('task-source', 'ts', 'index.sh', TASK_SOURCE, { STATE_DIR: state });
    plugin('executor', 'ex', 'run.sh', EXEC_RECORD_HEAD, { STATE_DIR: state });
    plugin('gate', '10-g', 'run.sh', GATE_PASS);
    git('add', '-A');
    git('commit', '-q', '-m', 'fixtures');
    // 古い時点を指す残骸ブランチを作ってから main を進める。
    git('branch', 'feature/issue-7');
    writeFileSync(join(repo, 'new-file.txt'), 'later\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'advance HEAD');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

    const cap = captureStreams();
    const code = await runCommand(parseArgs(['p'], RUN_FLAGS), io(cap), deps());

    expect(code).toBe(EXIT.OK);
    expect(readFileSync(join(state, 'wt-head'), 'utf8').trim()).toBe(head);
  });

  it('HALO_WORKTREE_DIR: worktree の置き場を環境変数で上書きできる', async () => {
    const state = join(repo, '.halo', 'state');
    const wtBase = mkdtempSync(join(tmpdir(), 'halo-wt-base-'));
    plugin('task-source', 'ts', 'index.sh', TASK_SOURCE, { STATE_DIR: state });
    // workdir の実パスを記録する executor (置き場の検証用)。
    plugin(
      'executor',
      'ex',
      'run.sh',
      `#!/usr/bin/env bash
in="$(cat)"
printf '%s' "$in" | jq -r '.workdir' > "$STATE_DIR/wt-path"
jq -cn '{status:"done",summary:"ok"}'; exit 0
`,
      { STATE_DIR: state },
    );
    plugin('gate', '10-g', 'run.sh', GATE_PASS);
    git('add', '-A');
    git('commit', '-q', '-m', 'fixtures');

    process.env['HALO_WORKTREE_DIR'] = wtBase;
    try {
      const cap = captureStreams();
      const code = await runCommand(parseArgs(['p'], RUN_FLAGS), io(cap), deps());
      expect(code).toBe(EXIT.OK);
      expect(readFileSync(join(state, 'wt-path'), 'utf8').trim()).toBe(join(wtBase, 'halo-wt-issue-7'));
    } finally {
      delete process.env['HALO_WORKTREE_DIR'];
      rmSync(wtBase, { recursive: true, force: true });
    }
  });

  it('preflight STOP: .halo/STOP present → exit 0, loop never runs (no logs)', async () => {
    const state = join(repo, '.halo', 'state');
    plugin('task-source', 'ts', 'index.sh', TASK_SOURCE, { STATE_DIR: state });
    plugin('executor', 'ex', 'run.sh', EXEC_DONE);
    plugin('gate', '10-g', 'run.sh', GATE_PASS);
    git('add', '-A');
    git('commit', '-q', '-m', 'fixtures');
    writeFileSync(join(repo, '.halo', 'STOP'), 'stop\n');

    const cap = captureStreams();
    const code = await runCommand(parseArgs(['p'], RUN_FLAGS), io(cap), deps());

    expect(code).toBe(EXIT.OK);
    expect(existsSync(join(logsDir(), 'iter_1.json'))).toBe(false);
  });

  it('gate fail path: executor done + gate fail → on-fail runs, outcome failed, exit 0', async () => {
    const state = join(repo, '.halo', 'state');
    plugin('task-source', 'ts', 'index.sh', TASK_SOURCE_REPEAT, { STATE_DIR: state });
    plugin('executor', 'ex', 'run.sh', EXEC_DONE);
    plugin('gate', '10-g', 'run.sh', GATE_FAIL);
    plugin('on-fail', 'rec', 'run.sh', ONFAIL, { STATE_DIR: state });
    git('add', '-A');
    git('commit', '-q', '-m', 'fixtures');

    const cap = captureStreams();
    // MAX_ITER=1 で 1 周だけ (repeat task-source なので上限で止める)。
    const code = await runCommand(parseArgs(['p', '--max-iter', '1'], RUN_FLAGS), io(cap), deps());

    expect(code).toBe(EXIT.OK);
    const log = JSON.parse(readFileSync(join(logsDir(), 'iter_1.json'), 'utf8'));
    expect(log.outcome).toBe('failed');
    expect(log.gates.some((g: { result: string }) => g.result === 'fail')).toBe(true);
    expect(existsSync(join(state, 'onfail'))).toBe(true);
  });
});
