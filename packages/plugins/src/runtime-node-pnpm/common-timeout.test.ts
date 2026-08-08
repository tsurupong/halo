// runtime-node-pnpm の自衛タイムアウト (issue #55) の単体テスト。
// 実プロセスを起動せず、common.ts が使う node:child_process.spawnSync シームをモックして
// (1) timeout オプションが渡ること (2) ETIMEDOUT 時に timeout 起因と秒数が stderr に残ること
// を検証する。launcher 契約テスト (runtime-node-pnpm.test.ts) とは独立。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

interface SpawnCall {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
}
interface SpawnResult {
  error?: NodeJS.ErrnoException;
  status: number | null;
  signal: NodeJS.Signals | null;
}

const spawnCalls: SpawnCall[] = [];
const diags: string[] = [];
let nextResult: SpawnResult = { status: 0, signal: null };

vi.mock('node:child_process', () => ({
  spawnSync: (cmd: string, args: string[], options: Record<string, unknown>): SpawnResult => {
    spawnCalls.push({ cmd, args, options });
    return nextResult;
  },
}));

vi.mock('../lib/io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/io.js')>();
  return {
    ...actual,
    readStdinJson: (): Promise<unknown> => Promise.resolve({ workdir: '/tmp/halo-wt' }),
    diag: (message: string): void => {
      diags.push(message);
    },
  };
});

const { runRuntime } = await import('./common.js');

/** process.exit(n) の代わりに投げる番兵 — runRuntime は never を返すため。 */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit:${code}`);
  }
}

/** runRuntime を 1 コマンドで実行し、exit コードを返す。 */
async function run(): Promise<number> {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new ExitSignal(typeof code === 'number' ? code : 0);
  });
  try {
    await runRuntime('setup', [{ cmd: 'pnpm', args: ['install', '--offline'] }]);
    throw new Error('runRuntime が exit せずに返りました');
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  } finally {
    exitSpy.mockRestore();
  }
}

function timedOut(): SpawnResult {
  const error: NodeJS.ErrnoException = new Error('spawnSync pnpm ETIMEDOUT');
  error.code = 'ETIMEDOUT';
  return { error, status: null, signal: 'SIGTERM' };
}

describe('runtime-node-pnpm 自衛タイムアウト (issue #55)', () => {
  const envKey = 'RUNTIME_SETUP_TIMEOUT_SEC';
  const saved = process.env[envKey];

  beforeEach(() => {
    spawnCalls.length = 0;
    diags.length = 0;
    nextResult = { status: 0, signal: null };
    delete process.env[envKey];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[envKey];
    else process.env[envKey] = saved;
  });

  it('環境変数なし: 既定 270 秒が spawnSync の timeout に渡る', async () => {
    expect(await run()).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.options['timeout']).toBe(270_000);
  });

  it('RUNTIME_SETUP_TIMEOUT_SEC (正の整数) を秒として尊重する', async () => {
    process.env[envKey] = '30';
    expect(await run()).toBe(0);
    expect(spawnCalls[0]?.options['timeout']).toBe(30_000);
  });

  it.each(['0', '-5', '1.5', 'abc', ''])(
    '不正値 %j は既定 270 秒にフォールバックする',
    async (v) => {
      process.env[envKey] = v;
      expect(await run()).toBe(0);
      expect(spawnCalls[0]?.options['timeout']).toBe(270_000);
    },
  );

  it('timeout (ETIMEDOUT) で終了したら exit 2、stderr に timeout と秒数が残る', async () => {
    process.env[envKey] = '12';
    nextResult = timedOut();

    expect(await run()).toBe(2);
    const message = diags.join('\n');
    expect(message).toContain('timeout');
    expect(message).toContain('12 秒');
    expect(message).toMatch(/経過 \d+ 秒/);
  });

  it('timeout 以外の spawn エラーは従来どおりの実行失敗メッセージ', async () => {
    const error: NodeJS.ErrnoException = new Error('spawnSync pnpm ENOENT');
    error.code = 'ENOENT';
    nextResult = { error, status: null, signal: null };

    expect(await run()).toBe(2);
    expect(diags.join('\n')).toContain('実行失敗: pnpm');
    expect(diags.join('\n')).not.toContain('timeout');
  });
});
