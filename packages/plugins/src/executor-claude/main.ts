// executor-claude(D1 §1.3 / D5 §2.3, §5.2): `claude -p` headless アダプタ。
// stdin の executor.in JSON {prompt, workdir, budget:{max_turns,timeout_sec}} を受け取り、
// 使い捨て worktree 内で claude を非対話実行し、executor.out JSON {status, summary, cost?} を stdout へ。
//   - status enum: done / stuck / timeout(done 以外はコアが failure 経路へ回す)
//   - STUCK マーカー(既定 [HALO:STUCK])を出力に検出したら status:"stuck" へ変換
//   - timeout でハングを status:"timeout" に落とす
//   - --strict-mcp-config で私有 MCP 設定の混入を防ぐ(D1 §5.2)
// worktree のライフサイクル自体はコア(T20/D2 §8)が駆動する。ここはアダプタに徹する。
// 契約出力は常に stdout の JSON。プラグイン自体の exit code は 0(status で経路が決まる)。
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readStdinJson, writeStdoutJson, str } from '../lib/io.js';

const stuckMarker = process.env['HALO_STUCK_MARKER'] ?? '[HALO:STUCK]';
// 無人実行の編集権限。既定 acceptEdits がないと headless claude はファイルを
// 変更できず、無変更のまま status:done を返して偽グリーンになる。
const permissionMode = process.env['HALO_CLAUDE_PERMISSION_MODE'] ?? 'acceptEdits';

function emit(status: string, summary: string): never {
  writeStdoutJson({ status, summary });
  process.exit(0);
}

const input = await readStdinJson().catch(() => undefined);
const prompt = str(input, 'prompt');
const workdir = str(input, 'workdir');
const budget =
  typeof input === 'object' && input !== null
    ? ((input as Record<string, unknown>)['budget'] as Record<string, unknown> | undefined)
    : undefined;
const maxTurns = typeof budget?.['max_turns'] === 'number' ? budget['max_turns'] : 40;
const timeoutSec = typeof budget?.['timeout_sec'] === 'number' ? budget['timeout_sec'] : 900;

if (prompt === undefined || workdir === undefined) {
  emit('stuck', 'invalid executor input: prompt and workdir are required');
}
if (!existsSync(workdir)) {
  emit('stuck', `workdir does not exist: ${workdir}`);
}

// claude headless 実行。stdout(結果本文)を捕捉し、stderr は失敗時の理由伝搬のため
// 捕捉して summary に添える(「なぜ非 0 か」をコアの retry プロンプトと on-fail 記録へ届ける)。
const r = spawnSync(
  'claude',
  [
    '-p', prompt,
    '--strict-mcp-config',
    '--permission-mode', permissionMode,
    '--max-turns', String(maxTurns),
  ],
  {
    cwd: workdir,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  },
);

if (r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
  emit('stuck', 'missing command: claude');
}
// spawnSync の timeout は SIGKILL でプロセスを落とし signal に現れる。
if (r.signal !== null || (r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT')) {
  emit('timeout', `claude timed out after ${timeoutSec}s`);
}

const out = r.stdout ?? '';
const err = r.stderr ?? '';
const code = r.status ?? 1;

const lastLines = (text: string, n: number): string =>
  text.split('\n').filter((l) => l !== '').slice(-n).join(' ');

// STUCK マーカー検出 → stuck へ変換(自己申告の行き詰まり)。
if (out.includes(stuckMarker)) {
  emit('stuck', `executor reported stuck: ${lastLines(out, 5)}`);
}

// 非 0 終了は行き詰まり扱い(failure 経路へ)。stdout/stderr の末尾を理由として添える。
if (code !== 0) {
  const detail = lastLines(`${out}\n${err}`, 3);
  emit('stuck', `claude exited with code ${code}${detail !== '' ? `: ${detail}` : ''}`);
}

const summary = lastLines(out, 3);
emit('done', summary !== '' ? summary : 'execution completed');
