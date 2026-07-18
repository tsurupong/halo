// task-source-github 契約テスト(plugins/task-source-github/test.contract.sh の TS 移植)。
// gh コマンドは PATH 上のスタブに差し替え、ランチャー(index.sh)経由で main.js を spawn して検証する。
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', '..', 'dist', 'task-source-github', 'main.js');

if (!existsSync(distPath)) {
  throw new Error(`dist not found: ${distPath} (run \`pnpm build\` first)`);
}

function runLauncher(input: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [distPath], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

const ghStub = `#!/usr/bin/env bash
echo "gh $*" >> "$GH_LOG"
case "$1 $2" in
  "issue list") printf '%s' "\${GH_ISSUE_JSON:-[]}" ;;
  "issue edit"|"issue comment") : ;;
esac
exit 0
`;

const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'halo-plugin-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

function setupStubBin(): { stubBinDir: string; ghLog: string } {
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

function baseEnv(stubBinDir: string, ghLog: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: `${stubBinDir}:${process.env['PATH'] ?? ''}`, GH_LOG: ghLog, ...extra };
}

describe('task-source-github contract', () => {
  it('next: ready issue exists -> task-source.out shape + label flip', () => {
    const { stubBinDir, ghLog } = setupStubBin();
    const issueJson = JSON.stringify([
      { number: 42, title: 'add feature', body: 'do it', labels: [{ name: 'ready' }, { name: 'kind:code' }] },
    ]);
    const { code, stdout } = runLauncher(JSON.stringify({ op: 'next' }), {
      ...baseEnv(stubBinDir, ghLog),
      GH_ISSUE_JSON: issueJson,
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { task_id: string; title: string; body: string; kind: string };
    expect(out.task_id).toBe('T-42');
    expect(typeof out.title).toBe('string');
    expect(typeof out.body).toBe('string');
    expect(out.kind).toBe('code');
    const log = readFileSync(ghLog, 'utf8');
    expect(log).toContain('issue edit 42 --add-label in-progress --remove-label ready');
  });

  it('next: 0 ready issues -> {task_id:null}, exit 0', () => {
    const { stubBinDir, ghLog } = setupStubBin();
    const { code, stdout } = runLauncher(JSON.stringify({ op: 'next' }), {
      ...baseEnv(stubBinDir, ghLog),
      GH_ISSUE_JSON: '[]',
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { task_id: null };
    expect(out.task_id).toBeNull();
  });

  it('complete: side effect only, stdout empty, exit 0', () => {
    const { stubBinDir, ghLog } = setupStubBin();
    const { code, stdout } = runLauncher(
      JSON.stringify({ op: 'complete', task_id: 'T-42', pr_url: 'https://github.com/o/r/pull/9' }),
      baseEnv(stubBinDir, ghLog),
    );
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('fail (retry_count=1): comment only, no needs-human, stdout empty', () => {
    const { stubBinDir, ghLog } = setupStubBin();
    const { code, stdout } = runLauncher(
      JSON.stringify({ op: 'fail', task_id: 'T-42', reason: 'tests red', retry_count: 1 }),
      baseEnv(stubBinDir, ghLog),
    );
    expect(code).toBe(0);
    expect(stdout).toBe('');
    const log = readFileSync(ghLog, 'utf8');
    expect(log).not.toContain('needs-human');
  });

  it('fail (retry_count=3): needs-human escalation', () => {
    const { stubBinDir, ghLog } = setupStubBin();
    runLauncher(JSON.stringify({ op: 'fail', task_id: 'T-42', reason: 'still red', retry_count: 3 }), baseEnv(stubBinDir, ghLog));
    const log = readFileSync(ghLog, 'utf8');
    expect(log).toContain('add-label needs-human');
  });

  it('unknown op -> exit 2, stdout empty', () => {
    const { stubBinDir, ghLog } = setupStubBin();
    const { code, stdout } = runLauncher(JSON.stringify({ op: 'bogus' }), baseEnv(stubBinDir, ghLog));
    expect(code).toBe(2);
    expect(stdout).toBe('');
  });
});
