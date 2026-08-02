// runtime node-pnpm: 依存の実体化。pnpm --offline でストアからハードリンク共有し
// 高速に node_modules を実体化する。store は ext4 側前提(D1 §1.7 / D5 §3.2)。
import { chmodSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runRuntime } from './common.js';

// ストアは ext4 側(WSL2 制約)。呼び出し側が PNPM_STORE_DIR を注入していれば尊重する。
const storeDir = process.env['PNPM_STORE_DIR'];
const storeArgs = storeDir !== undefined && storeDir !== '' ? ['--store-dir', storeDir] : [];

/** ファイルに実行ビットが無ければ付与する(シンボリックリンクは実体に対して)。 */
function ensureExecutable(path: string): void {
  const real = realpathSync(path);
  const mode = statSync(real).mode;
  if ((mode & 0o111) === 0) chmodSync(real, mode | 0o755);
}

/**
 * node_modules の bin 実行ビットを復元する (issue #42)。対象リポジトリが node_modules を
 * 実行ビット無しの 100644 でコミットしていると、worktree checkout 後の初回テストが
 * EACCES で全滅する(実GitHub E2E で3回連続再発)。setup 成功後の防御として
 * `.bin/*` と各パッケージ直下の `bin/*` に実行ビットを付与する。
 */
function restoreExecBits(workdir: string): void {
  const nm = join(workdir, 'node_modules');
  if (!existsSync(nm)) return;
  // pnpm では node_modules/<pkg> は .pnpm 配下実体への symlink なので、判定は
  // symlink を辿る statSync で行う(壊れた symlink は無視)。
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const binDirs: string[] = [join(nm, '.bin')];
  for (const entry of readdirSync(nm)) {
    if (entry === '.bin' || entry === '.pnpm') continue;
    const pkgDir = join(nm, entry);
    if (!isDir(pkgDir)) continue;
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(pkgDir)) binDirs.push(join(pkgDir, scoped, 'bin'));
    } else {
      binDirs.push(join(pkgDir, 'bin'));
    }
  }
  for (const dir of binDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      try {
        ensureExecutable(join(dir, entry));
      } catch {
        // 壊れたシンボリックリンク等は無視(ベストエフォート)
      }
    }
  }
}

await runRuntime(
  'setup',
  [{ cmd: 'pnpm', args: ['install', '--offline', '--frozen-lockfile', ...storeArgs] }],
  restoreExecBits,
);
