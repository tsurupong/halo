// 後方互換の再エクスポート (entry 契約の aux 解決込み)。実体は @tsurupong/halo-core へ昇格済み
// (Phase 2 繰越タスク)。
export type {
  SpawnResult,
  SpawnAdapter,
  TriggerContext,
  AdapterOutcome,
  TriggerEntry,
} from '@tsurupong/halo-core';
export {
  isSafeName,
  triggerDir,
  resolveBinPath,
  installTrigger,
  uninstallTrigger,
  listTriggers,
} from '@tsurupong/halo-core';
