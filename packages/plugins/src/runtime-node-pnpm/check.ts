// runtime node-pnpm: 静的検査。tsc --noEmit と eslint。どちらかが失敗したら exit 2。
import { runRuntime } from './common.js';

await runRuntime('check', [
  { cmd: 'pnpm', args: ['exec', 'tsc', '--noEmit'] },
  { cmd: 'pnpm', args: ['exec', 'eslint', '.'] },
]);
