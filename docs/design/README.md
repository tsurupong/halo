# HALO 詳細設計書

出典: [HALO要件定義書 v1.8](../HALO要件定義書.md)（2026-07-09）。設計判断の背景は [ADR 索引](../adr/README.md) を参照。
文書体系は [HALO設計書一覧.md](../HALO設計書一覧.md)（D1〜D9）に従う。

> 注意: 01〜06 は v1.5 時点の内容を含む（bash コア前提など）。v1.8 で確定したコア TypeScript 化・specs/ 廃止と矛盾する箇所は、D 体系の各設計書（d1-, d4- …）を正とする。

| # | セクション | 対応要件 | 関連 ADR |
|---|---|---|---|
| 01 | [コアループとポート](01-core-loop-and-ports.md) — 9ポートのJSONコントラクト、helpers.sh 仕様、fail 再注入シーケンス、conf.d 活性化規約 | §3〜4.3 | 0001, 0006 |
| 02 | [executor / worktree / runtime](02-executor-worktree-runtime.md) — claude -p 実行仕様、使い捨て worktree 状態遷移、.harness.yml スキーマ、runtime 4種差分表 | §4.2③⑦⑧ | 0002, 0007 |
| 03 | [gate / sink / on-fail](03-gate-sink-onfail.md) — loop-audit 6項目検査、evaluator 懐疑度方針、自律度別 sink 対応表、失敗学習ループ | §4.2④⑤⑥, §7, §11 | 0004, 0006 |
| 04 | [起動層（trigger / プロファイル / プリフライト）](04-trigger-profiles-preflight.md) — schedule/polling トリガー、プロファイル3種の環境変数、2段プリフライト、日次予算算出 | §4.4 | 0008, 0006 |
| 05 | [コンテキスト層（グラフ基盤）](05-context-layer-graphs.md) — CGC+KuzuDB 再インデックス、ナレッジグラフ Cypher DDL、knowledge MCP ツール仕様、Agentic Graph RAG | §5, §11.1 | 0003, 0005 |
| D1 | [コントラクト仕様書](d1-contract-spec.md) — 9ポート I/O 型、plugin.json、exit code 規約、kg:// URI、STUCK マーカー、JSON Schema 検証（v1.8 準拠・最保守的に変更管理） | §3〜4, §11.1 | 0001, 0009〜0011 |
| D2 | [コア詳細設計書](d2-core-design.md) — 9モジュール分割、loop 状態機械、runPort、プリフライト2段、budget 都度計測、discovery、worktree ライフサイクル | §3〜4, §8 | 0002, 0009, 0010 |
| D3 | [CLI 仕様書](d3-cli-spec.md) — 6コマンド体系、フラグ上書き規則、project init 生成物、doctor 検査、終了コード規約、core 委譲マップ | §4.4, §8.2 | 0010 |
| D4 | [セキュリティ設計書（骨子）](d4-security-design.md) — bubblewrap、deny 標準セット、fine-grained PAT、loop-audit 7 検査、グラフ書込制御、インジェクション対策、MCP 権限（v1.8 準拠） | §6, §7, §11.1 | 0004, 0011 |
| D5 | [プラグイン開発ガイド](d5-plugin-dev-guide.md) — 最小プラグイン（TS/bash）、ポート別実装ポイント、見本4種解説、contract test、配置方法 | §4, §8 | 0001 |
| D6 | [グラフ設計書](d6-graph-design.md) ◆私有 — KuzuDB DDL、kg:// 解決、CGC 再インデックス、陳腐化検出→自動起票、用語集チェック、MCP ツール、要件投入手順 | §5 | 0003, 0005, 0011 |
| D7 | [運用ランブック（骨子）](d7-ops-runbook.md) — 自律度昇降格、needs-human フロー、failure-catalog/sign 昇格、予算監視、トラブルシュート（実測値は Phase 1〜2 後に記入） | §7, §9 | 0006, 0012 |
| D8 | [テスト戦略書](d8-test-strategy.md) — core 単体（vitest）、ループ回帰（executor モック）、contract test、E2E、CI 構成 | §9 | 0010 |
| 06 | [セキュリティ / コスト制御 / 可観測性](06-security-cost-observability.md) — bubblewrap 仕様、遮断操作一覧、PAT スコープ、コストパラメータ表、iter_N.json スキーマ | §6, §10 | 0004, 0008 |
