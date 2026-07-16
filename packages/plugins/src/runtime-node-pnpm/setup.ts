// runtime node-pnpm: 依存の実体化。pnpm --offline でストアからハードリンク共有し
// 高速に node_modules を実体化する。store は ext4 側前提(D1 §1.7 / D5 §3.2)。
import { runRuntime } from './common.js';

// ストアは ext4 側(WSL2 制約)。呼び出し側が PNPM_STORE_DIR を注入していれば尊重する。
const storeDir = process.env['PNPM_STORE_DIR'];
const storeArgs = storeDir !== undefined && storeDir !== '' ? ['--store-dir', storeDir] : [];

await runRuntime('setup', [
  { cmd: 'pnpm', args: ['install', '--offline', '--frozen-lockfile', ...storeArgs] },
]);
