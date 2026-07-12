// 後方互換の再エクスポート。実体は @halo/core へ昇格済み (Phase 2 繰越タスク)。
export type { HarnessYmlOptions, ScaffoldOptions, ScaffoldResult } from '@halo/core';
export {
  PORT_DIRS,
  PROFILE_TEMPLATES,
  GITIGNORE_MARKER,
  renderHarnessYml,
  scaffold,
  repairSkeleton,
} from '@halo/core';
