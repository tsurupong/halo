# ADR-0008: トリガーはポーリング方式を採用（webhook 不採用）

**Date**: 2026-07-09
**Status**: accepted
**Deciders**: 本人（HALO要件定義書 v1.5 §4.4 より記録）

## Context

コアループの起動方式が必要。実行環境は WSL2 単一マシンで、公開エンドポイントを持たない。GitHub Issue の投入からタスク実行までの遅延と、受け口常駐のコスト・セキュリティリスクのトレードオフがある。

## Decision

trigger は交換可能なアダプタ（install / uninstall / fire の3スクリプト）とし、初期実装は `schedule/`（Windows タスクスケジューラ、WSL2 VM 起動を兼ねる一次トリガー）と `polling/`（15分間隔の高頻度起動 + プリフライトの「ready タスク 0 件なら即終了」）とする。webhook は不採用。

## Alternatives Considered

### 代替案1: webhook（GitHub Issue イベントの直接受信）
- **Pros**: 遅延最小（イベント駆動）
- **Cons**: 受け口の常駐プロセスとトンネル（公開導線）が必要。公開入力→ローカル実行の導線はプロンプトインジェクション面で危険
- **Why not**: ポーリング + 0件即終了で実質的なタスク存在駆動が実現でき、15分の遅延は夜間無人稼働の用途で問題にならない。遅延要件が実測で問題化した場合のみ再検討（trigger 差し替えのみで対応可能な構造は確保済み）

### 代替案2: 常駐デーモン（systemd timer / cron 常時監視）
- **Pros**: WSL2 内で完結
- **Cons**: WSL2 VM は自動停止するため、VM 停止中はトリガー自体が発火しない
- **Why not**: Windows タスクスケジューラを一次トリガーにすることで VM 起動を兼ねる必要がある

## Consequences

### Positive
- 公開エンドポイントゼロでインジェクション導線を作らない
- run.sh 以下はトリガーが何かを知らないため、将来 webhook / manual への差し替えがファイル操作のみで可能

### Negative
- 最大15分（ポーリング間隔）のタスク着手遅延
- 高頻度起動に伴い、日次予算・flock・軽量プリフライトによる総量制御が必須になる（run.sh 標準装備として対応）

### Risks
- スケジュール多重起動による worktree 破壊 → flock 排他 + プロファイル TIMEOUT で回避
