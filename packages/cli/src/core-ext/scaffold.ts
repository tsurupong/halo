// project init の生成物 (D3 §3): `.harness.yml` 雛形・`.halo/` 骨格・`.gitignore` 追記。
// 既存ファイルは上書きせず不足分のみ補完する冪等生成 (D3 §3 冒頭)。core に scaffold
// モジュールが無いため CLI 側に置く。純粋な「生成物の定義」+ fs シームで書き込む。
import type { CliFs } from './fs.js';

/** `.halo/ports/` 配下に用意する空の有効化ディレクトリ (要件 §8.2)。 */
export const PORT_DIRS = [
  'task-source.d',
  'context.d',
  'executor.d',
  'gate.d',
  'runtime.d',
  'sink.d',
  'on-fail.d',
  'trigger.d',
  'mcp.d',
] as const;

/** init が用意する 3 プロファイル (要件 §4.4)。値は調整可能な初期値 (要件 §11.2)。 */
export const PROFILE_TEMPLATES: Record<string, string> = {
  'continuous.env': [
    '# continuous — 高頻度ポーリング × 低自律度 × 中予算 (要件 §4.4 / D2 §9)',
    'AUTONOMY=L1',
    'MAX_ITER=20',
    'TIMEOUT=3h',
    'DAILY_MAX_ITERATIONS=60',
    '',
  ].join('\n'),
  'daytime-l1.env': [
    '# daytime-l1 — 日中・低自律度の安全運用 (要件 §4.4 / D2 §9)',
    'AUTONOMY=L1',
    'MAX_ITER=10',
    'TIMEOUT=90m',
    'DAILY_MAX_ITERATIONS=30',
    '',
  ].join('\n'),
  'nightly.env': [
    '# nightly — 夜間バッチ・長時間 × 中予算 (要件 §4.4 / D2 §9)',
    'AUTONOMY=L1',
    'MAX_ITER=40',
    'TIMEOUT=8h',
    'DAILY_MAX_ITERATIONS=80',
    '',
  ].join('\n'),
};

const PROMPT_TEMPLATES: Record<string, string> = {
  'code.md': [
    '# code kind プロンプト雛形',
    '',
    'このリポジトリで自律的にコード改善タスクを 1 件処理してください。',
    '差分は小さく、テストを通し、PR を 1 本作成します。',
    '',
  ].join('\n'),
  'docs.md': [
    '# docs kind プロンプト雛形',
    '',
    'ドキュメントの改善タスクを 1 件処理してください。',
    '',
  ].join('\n'),
};

export const GITIGNORE_MARKER = '.halo/';
const GITIGNORE_BLOCK = [
  '',
  '# HALO ローカル状態 (永続状態はすべて .halo/ 配下・要件 §8.2)',
  '.halo/',
  '',
].join('\n');

export interface HarnessYmlOptions {
  kinds: readonly string[];
  runtime: string;
}

/** `.harness.yml` 雛形本文を生成する (D1 §1.8 準拠, D3 §3.1)。純粋。 */
export function renderHarnessYml(options: HarnessYmlOptions): string {
  const runtime = options.runtime || 'node-pnpm';
  const kinds = options.kinds.length > 0 ? options.kinds : ['code'];
  const lines = [
    '# .harness.yml — HALO 管理宣言 (コミット対象)。kind ごとに runtime とプロンプトを割り当てる',
    'kinds:',
  ];
  for (const kind of kinds) {
    lines.push(`  ${kind}:`);
    lines.push(`    runtimes: [${runtime}]`);
    lines.push(`    prompt: .halo/prompts/${kind}.md`);
  }
  lines.push('');
  return lines.join('\n');
}

export interface ScaffoldOptions {
  /** プロジェクトルート。 */
  cwd: string;
  fs: CliFs;
  kinds: readonly string[];
  runtime: string;
  /** false で `.gitignore` 追記をスキップ (--no-gitignore)。 */
  gitignore: boolean;
}

export interface ScaffoldResult {
  created: string[];
  skipped: string[];
}

function join(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/$/, '') : p.replace(/^\/|\/$/g, '')))
    .join('/');
}

/**
 * `.harness.yml` / `.halo/` 骨格 / `.gitignore` を冪等に生成する。既存ファイルは
 * 温存し不足分のみ書く (D3 §3)。生成/温存したパスを相対で返す。
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { cwd, fs, runtime, gitignore } = options;
  const kinds = options.kinds.length > 0 ? [...new Set(options.kinds)] : ['code'];
  const created: string[] = [];
  const skipped: string[] = [];

  const writeIfAbsent = async (rel: string, content: string): Promise<void> => {
    const abs = join(cwd, rel);
    if (await fs.exists(abs)) {
      skipped.push(rel);
      return;
    }
    const dir = abs.slice(0, abs.lastIndexOf('/'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(abs, content);
    created.push(rel);
  };

  const ensureDir = async (rel: string): Promise<void> => {
    const abs = join(cwd, rel);
    if (await fs.isDirectory(abs)) {
      skipped.push(`${rel}/`);
      return;
    }
    await fs.mkdir(abs, { recursive: true });
    created.push(`${rel}/`);
  };

  // .harness.yml (kind/runtime 指定を反映)
  await writeIfAbsent('.harness.yml', renderHarnessYml({ kinds, runtime }));

  // .halo/ports/*.d — 空の有効化ディレクトリ (.gitkeep で存在を保証)
  for (const port of PORT_DIRS) {
    await writeIfAbsent(join('.halo/ports', port, '.gitkeep'), '');
  }

  // profiles/*.env — 3 種の初期値入り雛形
  for (const [name, body] of Object.entries(PROFILE_TEMPLATES)) {
    await writeIfAbsent(join('.halo/profiles', name), body);
  }

  // prompts/<kind>.md — .harness.yml の prompt パスと整合
  for (const kind of kinds) {
    const body = PROMPT_TEMPLATES[`${kind}.md`] ?? PROMPT_TEMPLATES['code.md']!;
    await writeIfAbsent(join('.halo/prompts', `${kind}.md`), body);
  }

  // env-templates/ と logs/ (.gitkeep のみ)
  await writeIfAbsent(join('.halo/env-templates', '.gitkeep'), '');
  await writeIfAbsent(join('.halo/logs', '.gitkeep'), '');
  await ensureDir('.halo/graphs');

  // .gitignore 追記 (冪等)
  if (gitignore) {
    await appendGitignore(cwd, fs, created, skipped);
  }

  return { created, skipped };
}

async function appendGitignore(
  cwd: string,
  fs: CliFs,
  created: string[],
  skipped: string[],
): Promise<void> {
  const abs = join(cwd, '.gitignore');
  if (await fs.exists(abs)) {
    const existing = await fs.readFile(abs);
    if (existing.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_MARKER)) {
      skipped.push('.gitignore');
      return;
    }
    const sep = existing.endsWith('\n') ? '' : '\n';
    await fs.writeFile(abs, `${existing}${sep}${GITIGNORE_BLOCK}`);
    created.push('.gitignore (追記)');
    return;
  }
  await fs.writeFile(abs, `${GITIGNORE_BLOCK.replace(/^\n/, '')}`);
  created.push('.gitignore');
}

/** doctor --fix が呼ぶ骨格補完 (D3 §4 検査 2, §6 scaffold.repair)。生成は scaffold と同じ冪等ロジック。 */
export async function repairSkeleton(
  options: Omit<ScaffoldOptions, 'gitignore'>,
): Promise<ScaffoldResult> {
  return scaffold({ ...options, gitignore: false });
}
