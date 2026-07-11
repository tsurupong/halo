# ADR-0007: runtime は「言語」ではなく「成果物種別」を吸収する

**Date**: 2026-07-09
**Status**: accepted
**Deciders**: 本人（HALO要件定義書 v1.5 §4.2⑦⑧ より記録）

## Context

HALO のユースケースはアプリ開発だけでなく、設計書・ADR の作成修正も含む。文書タスクを特別扱いすると、コア・executor・gate に文書用の分岐が増殖する。

## Decision

runtime プラグインの抽象を「言語」ではなく「成果物の種類」とし、コード（node-pnpm / python-uv / rust）と文書（docs-md）を同列の runtime として扱う。docs-md の check は markdownlint + リンク切れ + ADR テンプレート準拠、test は用語集整合チェック（ナレッジグラフ照合）とする。タスクは Issue ラベル `kind:<name>` と `.harness.yml` の kinds 定義で runtime とプロンプトを切り替える。

## Alternatives Considered

### 代替案1: 文書用の別ループ（docs 専用パイプライン）
- **Pros**: コード用ループがシンプルに保てる
- **Cons**: ループ二重管理。安全装置・ログ・トリガーがすべて重複する
- **Why not**: 「静的検査 + 動的検証で gate する」という構造は文書もコードも同型。抽象を一段上げれば1本のループで済む

### 代替案2: 暗黙の runtime 自動検出（detect.sh）
- **Pros**: `.harness.yml` 不要で導入が楽
- **Cons**: 検出誤りが誤った gate 実行につながり、原因切り分けが困難
- **Why not**: `.harness.yml` 必須（なければ needs-human）の明示宣言方式を採用。再現性を優先

## Consequences

### Positive
- 新種別（go / java / スライド等）対応がディレクトリ追加のみで完結
- 用語集整合チェックによりユビキタス言語が自動ゲート化される
- docs⇔code の双方向反映（docs マージ→再インデックス、code 変更→陳腐化検出→docs Issue 起票）が同一機構に乗る

### Negative
- 文書の「test」概念（用語集整合）は初期は粗く、厳密度は docs タスク 10 件の実績後に調整

### Risks
- 用語集チェックの過剰 block → block は禁止語違反のみ、未登録用語は提案に留める初期方針で緩和
