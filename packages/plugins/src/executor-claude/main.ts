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
// ADR-0020: 既定 dontAsk + allowedTools。dontAsk はリスト外ツールを即拒否する
// 硬い境界(acceptEdits はリスト外がモード処理へフォールスルーし境界にならない)。
// リスト内の Edit/Write/Bash は無確認で通るため無人編集は成立する。
const permissionMode = process.env['HALO_CLAUDE_PERMISSION_MODE'] ?? 'dontAsk';
// ADR-0020(改訂版 D4 §6): dontAsk では Read/検索系・Agent(サブエージェント委譲)・
// Skill も明示許可が必要(リスト外は即拒否)。env で運用上書き可。
const allowedTools =
  process.env['HALO_CLAUDE_ALLOWED_TOOLS'] ??
  'mcp__codegraph__*,mcp__knowledge__*,Read,Glob,Grep,Edit,Write,Bash,Agent,Skill,TodoWrite';
// ADR-0019: HALO 管理の deny 集合(保護ファイル)を worktree 外の settings で事前強制。
// 生成はコア/CLI 側の責務。未設定なら注入しない(層2の gate-loop-audit は常に有効)。
const settingsFile = process.env['HALO_SETTINGS_FILE'];

function emit(status: string, summary: string, costUsd?: number): never {
  writeStdoutJson(
    costUsd !== undefined
      ? { status, summary, cost: { usd_estimate: costUsd } }
      : { status, summary },
  );
  process.exit(0);
}

/**
 * S3: `--output-format json` の結果エンベロープを解釈する。`result`(本文テキスト)と
 * `total_cost_usd`(日次コスト予算 DAILY_MAX_COST_USD の集計元)を取り出す。JSON でない
 * 場合(古い claude / テストスタブ)は生テキストへフォールバックする。
 */
function parseEnvelope(raw: string): { text: string; cost?: number; isError: boolean } {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (j !== null && typeof j === 'object') {
      const text = typeof j['result'] === 'string' ? (j['result'] as string) : raw;
      const rawCost = j['total_cost_usd'] ?? j['cost_usd'];
      const cost =
        typeof rawCost === 'number' && Number.isFinite(rawCost) ? rawCost : undefined;
      return { text, ...(cost !== undefined ? { cost } : {}), isError: j['is_error'] === true };
    }
  } catch {
    /* JSON でない → 生テキスト扱い */
  }
  return { text: raw, isError: false };
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
    // S2: 対象リポジトリの project/local 設定 (.claude/settings.json の allow/hooks) を
    // 無視し、無人ループの実効権限をリポジトリ側ファイルに拡張させない (要件 §6.1 / D4 §2)。
    '--setting-sources', 'user',
    // ADR-0019 層1: HALO 管理 settings(deny 集合)を spawn 時に注入(存在時のみ)。
    ...(settingsFile !== undefined && settingsFile !== '' && existsSync(settingsFile)
      ? ['--settings', settingsFile]
      : []),
    '--permission-mode', permissionMode,
    // ADR-0020: dontAsk 下の許可リスト = 可視ツール境界。
    '--allowedTools', allowedTools,
    // S3: cost を取得するため結果を JSON エンベロープで受け取る (DAILY_MAX_COST_USD の集計元)。
    '--output-format', 'json',
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

// S3: JSON エンベロープを解釈して本文テキストと cost を取り出す(非JSONは生テキスト)。
const env = parseEnvelope(out);
const text = env.text;

// STUCK マーカー検出 → stuck へ変換(自己申告の行き詰まり)。cost は取れれば添える。
if (text.includes(stuckMarker)) {
  emit('stuck', `executor reported stuck: ${lastLines(text, 5)}`, env.cost);
}

// 非 0 終了 or エンベロープの is_error は行き詰まり扱い(failure 経路へ)。
if (code !== 0 || env.isError) {
  const detail = lastLines(`${text}\n${err}`, 3);
  emit('stuck', `claude failed (exit ${code})${detail !== '' ? `: ${detail}` : ''}`, env.cost);
}

const summary = lastLines(text, 3);
emit('done', summary !== '' ? summary : 'execution completed', env.cost);
