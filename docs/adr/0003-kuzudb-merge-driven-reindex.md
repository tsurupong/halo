# ADR-0003: KuzuDB 採用とマージ駆動再インデックス（watch 不採用）

**Date**: 2026-07-09
**Status**: accepted
**Deciders**: 本人（HALO要件定義書 v1.5 §5.1〜5.2 より記録）

## Context

コードグラフ（CodeGraphContext）とナレッジグラフのバックエンドが必要。個人検証環境（WSL2 単一マシン）でサーバー常駐を避けたい。また使い捨て worktree 方式（ADR-0002）の下でグラフの更新タイミングを決める必要がある。

## Decision

バックエンドは KuzuDB（組み込み・ファイル1個・サーバー不要）とする。更新は「マージ駆動 + プリフライト」（案A）: ループ起動時に main が前回インデックスから進んでいれば再インデックスする。ループ実行中のグラフは main 基準の read-only スナップショットとして全 worktree で共有し、不変とする。

## Alternatives Considered

### 代替案1: Neo4j
- **Pros**: エコシステム成熟、複数プロセス書込対応
- **Cons**: サーバー常駐・運用コスト。個人検証段階ではオーバースペック
- **Why not**: 必要になってから移行する（保留判断として記録）

### 代替案2: watch モードによるリアルタイム更新
- **Pros**: グラフ鮮度が常に最新
- **Cons**: 監視対象が main ではなく生滅する worktree になり、グラフが中間状態で汚染される
- **Why not**: 使い捨て worktree 方式と構造的に両立しない

## Consequences

### Positive
- サーバー管理ゼロ、グラフDBはファイル1個（graphs/*.kuzu）
- ループ実行中グラフ不変により、イテレーション間のコンテキスト再現性が担保される
- KuzuDB の単一プロセス書込制約を「プリフライト時1回のみ書込」で構造的に回避

### Negative
- マージ〜次回プリフライトの間はグラフが陳腐化する（双方向自動反映で緩和: docs マージ → sink 35-reindex、code 変更 → 陳腐化検出 → kind:docs 自動起票）

### Risks
- 並列時のロック競合 → read-only スナップショット共有で回避（§10）
- Neo4j 移行時の Cypher 方言差 → 初期ツールを 2 つ（search_docs / trace_spec_to_code）に絞り移行面を最小化
