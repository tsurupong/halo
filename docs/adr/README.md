# Architecture Decision Records

HALO の設計判断の記録。出典: HALO要件定義書 v1.5（2026-07-09）／ ADR-0009 以降は v1.8（2026-07-11）。
現行の最上位典拠は要件定義書 v1.8 であり、ADR-0009 以降は v1.8 を起点とする（0008 以前は v1.5 時点の判断を記録）。

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [0001](0001-ports-and-adapters-unified-contract.md) | ポート＆アダプタ構造と統一コントラクトの採用 | accepted | 2026-07-09 |
| [0002](0002-disposable-worktree.md) | 使い捨て worktree 方式の採用 | accepted | 2026-07-09 |
| [0003](0003-kuzudb-merge-driven-reindex.md) | KuzuDB 採用とマージ駆動再インデックス（watch 不採用） | accepted | 2026-07-09 |
| [0004](0004-self-modification-prohibition.md) | 自己改変の禁止（安全不変条件） | accepted | 2026-07-09 |
| [0005](0005-knowledge-graph-schema-granularity.md) | ナレッジグラフのスキーマ粒度（ノード5種・エッジ5種で固定） | accepted | 2026-07-09 |
| [0006](0006-autonomy-levels.md) | 自律度レベル（L1→L3）の sink フィルタ実装 | accepted | 2026-07-09 |
| [0007](0007-runtime-as-artifact-kind.md) | runtime は「言語」ではなく「成果物種別」を吸収する | accepted | 2026-07-09 |
| [0008](0008-polling-trigger-over-webhook.md) | トリガーはポーリング方式を採用（webhook 不採用） | accepted | 2026-07-09 |
| [0009](0009-zero-global-state.md) | グローバル状態ゼロ（全状態を対象リポジトリ配下に置く） | accepted | 2026-07-11 |
| [0010](0010-typescript-core.md) | コア・CLI・コントラクトの TypeScript 化（プラグインは任意言語） | accepted | 2026-07-11 |
| [0011](0011-specs-abolition-graph-consolidation.md) | specs/ 廃止とナレッジグラフへの要件一元化 | accepted | 2026-07-11 |
| [0012](0012-no-premature-numeric-fixing.md) | 数値パラメータを事前固定しない（仕組みは今、数値は運用実測で） | accepted | 2026-07-11 |
