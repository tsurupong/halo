// 後方互換の再エクスポート。実体は @halo/core へ昇格済み (Phase 2 繰越タスク)。
export type { SetStopOptions } from '@halo/core';
export { stopPath, formatStopFile, setStop, clearStop } from '@halo/core';
