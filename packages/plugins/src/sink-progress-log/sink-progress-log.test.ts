import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(__dirname, '..', '..', '..', '..', 'plugins', 'sink-progress-log');
const launcherPath = join(pluginDir, 'log.sh');
const distPath = join(__dirname, '..', '..', 'dist', 'sink-progress-log', 'main.js');

function runLauncher(input: string, env: Record<string, string> = {}) {
  const r = spawnSync('sh', [launcherPath], { input, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
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

describe('sink-progress-log メタデータ', () => {
  it('plugin.json は minAutonomy L1 を宣言する', () => {
    const pluginJson = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8')) as {
      minAutonomy?: string;
    };
    expect(pluginJson.minAutonomy).toBe('L1');
  });

  it('main.ts の先頭に // min-autonomy: L1 コメントがある', () => {
    const src = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(/^\/\/ min-autonomy:\s*L1/m.test(src)).toBe(true);
  });
});

describe('sink-progress-log 正常系', () => {
  it('logs へ構造化 1 行 JSON を追記し stdout は空', () => {
    const tmp = makeTmpDir();
    const logsDir = join(tmp, 'logs');
    const input = JSON.stringify({ task_id: 'T-7', workdir: join(tmp, 'wt'), summary: 'planned 3 steps' });
    const result = runLauncher(input, { HALO_LOGS_DIR: logsDir });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    const logfile = readdirSync(logsDir).find((f) => f.startsWith('progress-') && f.endsWith('.jsonl'));
    expect(logfile).toBeDefined();
    const content = readFileSync(join(logsDir, logfile as string), 'utf8').trim();
    const entry = JSON.parse(content) as { task_id: string; summary: string; ts: string };
    expect(entry.task_id).toBe('T-7');
    expect(entry.summary).toBe('planned 3 steps');
    expect(typeof entry.ts).toBe('string');
  });

  it('複数回実行で append 累積する(2行)', () => {
    const tmp = makeTmpDir();
    const logsDir = join(tmp, 'logs');
    const input = JSON.stringify({ task_id: 'T-7', workdir: join(tmp, 'wt'), summary: 'planned 3 steps' });
    runLauncher(input, { HALO_LOGS_DIR: logsDir });
    runLauncher(input, { HALO_LOGS_DIR: logsDir });
    const logfile = readdirSync(logsDir).find((f) => f.startsWith('progress-') && f.endsWith('.jsonl')) as string;
    const lines = readFileSync(join(logsDir, logfile), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('task_id/workdir 欠落は exit 0・stdout 空・書き込みなし', () => {
    const tmp = makeTmpDir();
    const logsDir = join(tmp, 'logs');
    const result = runLauncher(JSON.stringify({ summary: 'x' }), { HALO_LOGS_DIR: logsDir });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(logsDir)).toBe(false);
  });

  it('HALO_LOGS_DIR 未指定時は cwd の .halo/logs が既定', () => {
    const tmp = makeTmpDir();
    const repo = join(tmp, 'repo');
    mkdirSync(repo, { recursive: true });
    const input = JSON.stringify({ task_id: 'T-7', workdir: join(tmp, 'wt'), summary: 'planned 3 steps' });
    const r = spawnSync('sh', [launcherPath], {
      input,
      cwd: repo,
      encoding: 'utf8',
      env: (() => {
        const e = { ...process.env };
        delete e['HALO_LOGS_DIR'];
        return e;
      })(),
    });
    const status = r.status ?? 1;
    expect(status).toBe(0);
    expect(r.stdout).toBe('');
    const defLogsDir = join(repo, '.halo', 'logs');
    expect(existsSync(defLogsDir)).toBe(true);
    const logfile = readdirSync(defLogsDir).find((f) => f.startsWith('progress-'));
    expect(logfile).toBeDefined();
  });
});
