// run 統合テスト (JOB1, D8 §2/§4): `runCommand` を *実 RunHooks* (createRunHooks) で
// 駆動し、実プロセス境界 (runPort + node フィクスチャ) と実 git worktree を通す。
// executor/task-source は node フィクスチャ (entry 契約, ADR-0018: `spawn(process.execPath,
// [entryPath])` で直接起動されるため exec-bit/shebang は不要) なのでネットワーク/claude
// 課金ゼロ。対象リポジトリは tmpdir 上の実 git リポジトリで、.halo/ports/*.d に見本相当の
// 極小プラグインを配置する (discovery が monorepo/plugins ではなく対象リポジトリから
// 解決することの回帰も兼ねる, D2 §6)。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** plugin.json + JS エントリを 1 プラグイン分書き出す (entry 契約, ADR-0018)。 */
function plugin(
  port: string,
  dirName: string,
  entry: string,
  body: string,
  env: Record<string, string> = {},
): void {
  const dir = join(repo, '.halo', 'ports', `${port}.d`, dirName);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name: `@fx/${dirName}`,
    version: '1.0.0',
    port,
    entry: `./${entry}`,
    ...(Object.keys(env).length ? { env } : {}),
  };
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, entry), body, 'utf8');
}

// CommonJS フィクスチャ (拡張子 .cjs で package.json の type とは無関係に CJS として実行)。
// stdin の単一 JSON オブジェクトを読み、stdout に単一 JSON オブジェクトを書いて exit する
// (D1 §3 の実行契約)。

const TASK_SOURCE = `
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const op = input.op || 'next';
const stateDir = process.env.STATE_DIR;
const mark = stateDir + '/served';
if (op === 'next') {
  if (fs.existsSync(mark)) {
    process.stdout.write(JSON.stringify({ task_id: null }));
  } else {
    fs.writeFileSync(mark, '');
    process.stdout.write(JSON.stringify({ task_id: '7', title: 't', body: 'do it' }));
  }
} else {
  fs.appendFileSync(stateDir + '/ops', op + '\\n');
  process.stdout.write(JSON.stringify({}));
}
process.exit(0);
`;

// 毎回タスクを払い出す task-source (retry/複数周回の検証用)。
const TASK_SOURCE_REPEAT = `
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const op = input.op || 'next';
if (op === 'next') {
  process.stdout.write(JSON.stringify({ task_id: '9', title: 't', body: 'b' }));
} else {
  process.stdout.write(JSON.stringify({}));
}
process.exit(0);
`;

const EXEC_DONE = `
require('fs').readFileSync(0);
process.stdout.write(JSON.stringify({ status: 'done', summary: 'ok' }));
process.exit(0);
`;

const GATE_PASS = `
require('fs').readFileSync(0);
process.exit(0);
`;

// worktree の HEAD を記録する executor (使い捨て worktree が常に最新 HEAD 起点である回帰用)。
const EXEC_RECORD_HEAD = `
const fs = require('fs');
const { execFileSync } = require('child_process');
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const head = execFileSync('git', ['-C', input.workdir, 'rev-parse', 'HEAD']).toString();
fs.writeFileSync(process.env.STATE_DIR + '/wt-head', head);
process.stdout.write(JSON.stringify({ status: 'done', summary: 'ok' }));
process.exit(0);
`;

const GATE_FAIL = `
require('fs').readFileSync(0);
process.stdout.write(JSON.stringify({ reason: 'boom', gate: 'g' }));
process.exit(2);
`;

const ONFAIL = `
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.STATE_DIR + '/onfail', input + '\\n');
process.exit(0);
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
  // .harness.yml は必須 (要件 §4.2③): 無いと preflight.heavy が NO_HARNESS_YML で止まる。
  writeFileSync(
    join(repo, '.harness.yml'),
    'kinds:\n  code:\n    runtimes: [node-pnpm]\n    prompt: .halo/prompts/code.md\n',
  );
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
    plugin('task-source', 'ts', 'index.cjs', TASK_SOURCE, { STATE_DIR: state });
    plugin('executor', 'ex', 'run.cjs', EXEC_DONE);
    plugin('gate', '10-g', 'run.cjs', GATE_PASS);
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
    plugin('task-source', 'ts', 'index.cjs', TASK_SOURCE, { STATE_DIR: state });
    plugin('executor', 'ex', 'run.cjs', EXEC_RECORD_HEAD, { STATE_DIR: state });
    plugin('gate', '10-g', 'run.cjs', GATE_PASS);
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
    plugin('task-source', 'ts', 'index.cjs', TASK_SOURCE, { STATE_DIR: state });
    // workdir の実パスを記録する executor (置き場の検証用)。
    plugin(
      'executor',
      'ex',
      'run.cjs',
      `
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
fs.writeFileSync(process.env.STATE_DIR + '/wt-path', input.workdir);
process.stdout.write(JSON.stringify({ status: 'done', summary: 'ok' }));
process.exit(0);
`,
      { STATE_DIR: state },
    );
    plugin('gate', '10-g', 'run.cjs', GATE_PASS);
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
    plugin('task-source', 'ts', 'index.cjs', TASK_SOURCE, { STATE_DIR: state });
    plugin('executor', 'ex', 'run.cjs', EXEC_DONE);
    plugin('gate', '10-g', 'run.cjs', GATE_PASS);
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
    plugin('task-source', 'ts', 'index.cjs', TASK_SOURCE_REPEAT, { STATE_DIR: state });
    plugin('executor', 'ex', 'run.cjs', EXEC_DONE);
    plugin('gate', '10-g', 'run.cjs', GATE_FAIL);
    plugin('on-fail', 'rec', 'run.cjs', ONFAIL, { STATE_DIR: state });
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
