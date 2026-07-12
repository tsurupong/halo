// 後方互換の再エクスポート。実体は @tsurupong/halo-core へ昇格済み (Phase 2 繰越タスク)。
export type {
  CheckStatus,
  CheckResult,
  DoctorReport,
  CommandProbe,
  DoctorProbes,
} from '@tsurupong/halo-core';
export {
  checkTriggerLiveness,
  checkSkeleton,
  checkHarnessValid,
  checkGh,
  checkClaude,
  checkGit,
  checkLockStop,
  checkPlacement,
  checkDisk,
  aggregate,
  runAll,
} from '@tsurupong/halo-core';
