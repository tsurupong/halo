// 後方互換の再エクスポート。実体は @tsurupong/halo-core へ昇格済み (Phase 2 繰越タスク)。
export type { HarnessYmlOptions, ScaffoldOptions, ScaffoldResult } from '@tsurupong/halo-core';
export {
  PORT_DIRS,
  PROFILE_TEMPLATES,
  GITIGNORE_MARKER,
  renderHarnessYml,
  scaffold,
  repairSkeleton,
} from '@tsurupong/halo-core';
