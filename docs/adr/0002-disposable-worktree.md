# ADR-0002: 使い捨て worktree 方式の採用

**Date**: 2026-07-09
**Status**: accepted
**Deciders**: 本人（HALO要件定義書 v1.5 §4.2③ より記録）

## Context

AI の作業ディレクトリを人間の作業ディレクトリから物理分離し、タスク間の状態汚染を防ぎたい。またフレッシュコンテキスト原則（1イテレーション1タスク）をファイルシステムにも適用し、bubblewrap サンドボックスの書込境界を明確化したい。

## Decision

1 Issue = 1 ブランチ = 1 worktree とし、`add → setup → 実行 → (pass: PR / fail: 3回確定) → remove --force` の使い捨てライフサイクルで運用する。bubblewrap の書込許可範囲を worktree に一致させる。

## Alternatives Considered

### 代替案1: 固定作業ディレクトリの使い回し（git reset で掃除）
- **Pros**: 依存インストールを再利用でき setup が速い
- **Cons**: 前タスクの残骸（未追跡ファイル・キャッシュ）が次タスクへ漏れる。cleanup ロジック自体がバグ源になる
- **Why not**: 状態汚染ゼロと「後始末が削除一発」を優先。setup 高速化は runtime 側の要件（リンクベース共有）で解決

### 代替案2: リポジトリの都度 clone
- **Pros**: 分離は完全
- **Cons**: clone コストが大きく、ブランチ衝突防止の仕組みを別途持つ必要がある
- **Why not**: worktree なら同一ブランチの二重チェックアウトを git 自体が禁止し、並列時の衝突防止を無料で得られる

## Consequences

### Positive
- 状態汚染ゼロ、失敗時の後始末が `worktree remove --force` 一発
- サンドボックス境界 = タスク作業スコープとなり、監査上「このタスクが触れた場所」が明確

### Negative
- setup がタスクごとに毎回走るため、各 runtime に「依存の実体化の高速性」が要件として課される
- wt/・ストア・cache/ を WSL2 ext4 側に置く配置制約が生じる（リンク共有は同一FS内のみ有効）

### Risks
- 共有ビルドキャッシュの破損による誤り → 正しさは gate が検出する前提で許容
