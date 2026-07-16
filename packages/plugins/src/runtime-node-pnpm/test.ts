// runtime node-pnpm: 動的検証。vitest run。失敗したら exit 2。
import { runRuntime } from './common.js';

await runRuntime('test', [{ cmd: 'pnpm', args: ['exec', 'vitest', 'run'] }]);
