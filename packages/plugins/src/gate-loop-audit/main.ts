// gate-loop-audit / 50-loop-audit(D4 §4 / D5 §3.3 / 要件 §11.1): 自己改変防止の構造検査ゲート。
// HALO の安全不変条件を担う最重要 gate。判定はすべて git diff ベースの静的検査で決定的に行う。
// stdin の gate.in JSON {task_id, workdir, changed_files} を受け取り、7 検査を順に実行する。
//   ① spec_refs 実在      … グラフ依存。Phase 1 はスキップ/空許容(pass-with-warning、D6 私有管轄)
//   ② テストファイル不変  … テストの削除・変更は fail(新規追加は許可)
//   ③ エスケープハッチ新規ゼロ … 追加行の eslint-disable / as any / @ts-ignore を fail
//   ④ カバレッジ閾値不変  … 閾値数値の下方改変を fail
//   ⑤ 自己改変の禁止      … CLAUDE.md / PROMPT.md / .harness.yml / テストへの変更を fail
//   ⑥ diff 1500 行上限    … 追加+削除の合計が 1500 超で fail
//   ⑦ グラフ改変検出      … グラフ依存。Phase 1 はスキップ(pass-with-warning)
// 1 項目でも違反があれば gate.out JSON {reason, hint?, gate:"50-loop-audit"} を出し exit 2。
// 全通過なら stdout 空・exit 0。
import { existsSync } from 'node:fs';
import { readStdinJson, writeStdoutJson, diag, str } from '../lib/io.js';
import { run } from '../lib/exec.js';

const GATE = '50-loop-audit';
const maxDiffLines = Number(process.env['HALO_MAX_DIFF_LINES'] ?? '1500');

function fail(reason: string, hint?: string): never {
  writeStdoutJson(hint === undefined || hint === '' ? { reason, gate: GATE } : { reason, hint, gate: GATE });
  process.exit(2);
}

function isTestFile(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  if (/\.test\.|_test\./.test(base) || /^test_.*\.py$/.test(base)) return true;
  return path.startsWith('tests/') || path.includes('/tests/');
}

function isProtectedFile(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  // .claude/settings*.json は hooks/allow で実効権限を拡張できるため保護対象 (S2, D4 §2)。
  if (path.includes('.claude/') && /^settings(\.local)?\.json$/.test(base)) return true;
  return base === 'CLAUDE.md' || base === 'PROMPT.md' || base === '.harness.yml';
}

const input = await readStdinJson().catch(() => undefined);
const workdir = str(input, 'workdir');
if (workdir === undefined || !existsSync(workdir)) fail(`workdir 不正: '${workdir ?? ''}'`);
if (run('git', ['-C', workdir, 'rev-parse', '--git-dir']).code !== 0)
  fail(`workdir が git リポジトリではない: ${workdir}`);

// 比較基準(D4 §4.2): worktree 作成時 HEAD の `base` が渡れば `git diff <base>` で
// committed + uncommitted の両方を検査する(executor が自分でコミットしても回避不能)。
// 無ければ後方互換で `git diff HEAD`(作業ツリー未コミット差分のみ)へ倒す。
const base = str(input, 'base');
const diffTarget = base !== undefined && base !== '' ? base : 'HEAD';

// intent-to-add: 未追跡の新規ファイルも diff に現れるようにする(作業ツリーは変更しない)。
run('git', ['-C', workdir, 'add', '-A', '-N']);

// diffTarget(base or HEAD)からの差分を検査対象とする。
const numstat = run('git', ['-C', workdir, 'diff', diffTarget, '--numstat']).stdout;
const namestatus = run('git', ['-C', workdir, 'diff', diffTarget, '--name-status']).stdout;
const diff = run('git', ['-C', workdir, 'diff', diffTarget]).stdout;

// ⑥ diff 1500 行上限
let total = 0;
for (const line of numstat.split('\n')) {
  const [add, del] = line.split('\t');
  if (add !== undefined && /^[0-9]+$/.test(add)) total += Number(add);
  if (del !== undefined && /^[0-9]+$/.test(del)) total += Number(del);
}
if (total > maxDiffLines) fail(`diff ${total} 行 > ${maxDiffLines}。タスクを分割せよ`);

// ②/⑤ ファイル単位検査(name-status: A/M/D/R…)
for (const line of namestatus.split('\n')) {
  if (line === '') continue;
  const parts = line.split('\t');
  const status = parts[0] ?? '';
  let path = parts[1] ?? '';
  // リネーム(R###)は新パスを対象にする
  if (status.startsWith('R') && parts[2] !== undefined && parts[2] !== '') path = parts[2];
  if (path === '') continue;
  // ⑤ 自己改変(ルール類)の禁止 — 変更種別を問わず fail
  if (isProtectedFile(path)) {
    const base = path.split('/').pop() ?? path;
    fail(`${base} への自己改変が検出された（変更: ${path}）`, 'ハーネスのルール類は L2 上限・人間承認が必要');
  }
  // ② テストファイルの削除・変更は fail(新規追加 A は許可)
  if (isTestFile(path) && status !== 'A') {
    fail(`テストファイル ${path} が変更/削除された（status=${status}）`, 'テストの改変は禁止（新規追加のみ許可）');
  }
}

// ③ エスケープハッチ新規ゼロ(追加行のみ、+++ ヘッダは除外)
const addedLines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
const hatchRe = /eslint-disable|as any|@ts-ignore/;
const hatchLine = addedLines.find((l) => hatchRe.test(l));
if (hatchLine !== undefined) {
  const hatch = hatchRe.exec(hatchLine)?.[0] ?? '';
  fail(`新規エスケープハッチ（${hatch}）が追加された`, '既存維持は可、新規追加はゼロ強制');
}

// ④ カバレッジ閾値の下方改変(threshold 系キーワード行の数値を比較)
const thRe = /coverage|threshold|branches|statements|functions|lines/i;
const firstNum = (l: string): number | undefined => {
  const m = /[0-9]+/.exec(l);
  return m === null ? undefined : Number(m[0]);
};
const remTh = diff.split('\n').filter((l) => l.startsWith('-') && thRe.test(l) && /[0-9]/.test(l));
const addTh = diff.split('\n').filter((l) => l.startsWith('+') && thRe.test(l) && /[0-9]/.test(l));
if (remTh.length > 0 && addTh.length > 0) {
  let rmax = -1;
  let amin = 100000;
  for (const l of remTh) {
    const n = firstNum(l);
    if (n !== undefined && n > rmax) rmax = n;
  }
  for (const l of addTh) {
    const n = firstNum(l);
    if (n !== undefined && n < amin) amin = n;
  }
  if (rmax >= 0 && amin < 100000 && amin < rmax) {
    fail(`カバレッジ閾値が ${rmax} → ${amin} に改変された`, '閾値の下方変更は禁止');
  }
}

// ①⑦ グラフ依存検査(spec_refs 実在照会 / グラフ改変検出)は Phase 1 ではスキップ。
// kg:// の実在照会は D6 の私有プラグイン(knowledge MCP)管轄。空許容で pass-with-warning。
diag('loop-audit: ①spec_refs 実在 / ⑦グラフ改変検出 は Phase 1 でスキップ（pass-with-warning）');

// 全通過 — stdout は空、exit 0。
process.exit(0);
