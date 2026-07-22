import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, '..', '..', 'dist', 'on-fail-notify', 'main.js');

// Webhook 送信を event loop で受けるため非同期 spawn (spawnSync だと同一プロセスの
// テスト用 http サーバが応答できない)。
function run(
  input: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [distPath], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

interface Received {
  body: string;
  contentType: string | undefined;
}

let server: Server | undefined;
const received: Received[] = [];

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        received.push({ body, contentType: req.headers['content-type'] });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/notify`);
    });
  });
}

const INPUT = JSON.stringify({
  task_id: 'T-12',
  reason: 'coverage 87% < 90%',
  retry_count: 3,
  gate: '30-test',
});

beforeAll(() => {
  if (!existsSync(distPath)) {
    throw new Error(`${distPath} が見つかりません。先に pnpm build を実行してください。`);
  }
});

afterEach(async () => {
  received.length = 0;
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
});

describe('on-fail-notify メタデータ', () => {
  it('main.ts の先頭に // min-autonomy: L1 コメントがある', () => {
    const src = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(/^\/\/ min-autonomy:\s*L1/m.test(src)).toBe(true);
  });
});

describe('on-fail-notify', () => {
  it('閾値到達で JSON を POST し stdout は空・exit 0', async () => {
    const url = await startServer();
    const result = await run(INPUT, { HALO_NOTIFY_URL: url });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(received).toHaveLength(1);
    expect(received[0]!.contentType).toContain('application/json');
    const payload = JSON.parse(received[0]!.body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      task_id: 'T-12',
      reason: 'coverage 87% < 90%',
      retry_count: 3,
      gate: '30-test',
    });
    expect(typeof payload.ts).toBe('string');
  });

  it('retry_count が閾値未満なら送信しない', async () => {
    const url = await startServer();
    const result = await run(
      JSON.stringify({ task_id: 'T-12', reason: 'x', retry_count: 2 }),
      { HALO_NOTIFY_URL: url },
    );
    expect(result.code).toBe(0);
    expect(received).toHaveLength(0);
  });

  it('HALO_NOTIFY_THRESHOLD で閾値を上書きできる', async () => {
    const url = await startServer();
    const result = await run(
      JSON.stringify({ task_id: 'T-12', reason: 'x', retry_count: 1 }),
      { HALO_NOTIFY_URL: url, HALO_NOTIFY_THRESHOLD: '1' },
    );
    expect(result.code).toBe(0);
    expect(received).toHaveLength(1);
  });

  it('HALO_NOTIFY_URL 未設定 (空) なら何もせず exit 0', async () => {
    const result = await run(INPUT, { HALO_NOTIFY_URL: '' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('到達不能 URL でも exit 0 で stderr に診断を出す', async () => {
    const result = await run(INPUT, {
      HALO_NOTIFY_URL: 'http://127.0.0.1:1/unreachable',
      HALO_NOTIFY_TIMEOUT_MS: '2000',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('on-fail-notify');
  });
});
