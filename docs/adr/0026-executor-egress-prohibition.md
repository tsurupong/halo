# ADR-0026: executor の外部送信禁止 (egress deny)

**Date**: 2026-07-29
**Status**: proposed
**Deciders**: tsurupong, Claude

## Context

2026-07-29 の実 GitHub E2E スモーク (test/e2e/smoke.md ②、sandbox: halo-e2e-sandbox)
で、autonomy L1 の実行にもかかわらず executor 内のエージェントが worktree から
`git push` を実行し、`gh pr create` で PR まで作成した (Issue T-1 / PR #2)。credential
helper 不通に対し `gh auth git-credential` へ自力で切り替えて push を成功させており、
偶発ではなく再現性のある経路である。

原因は責務境界と権限の不一致にある。設計上、executor はタスクを worktree 内で
処理するだけであり、成果の外部反映 (commit・push・PR 作成) は executor 処理後の
動作として sink が担う (ADR-0006: 自律度は sink フィルタで実装、ADR-0016)。しかし
ADR-0019 層1 の deny リストは `git push --force*` / `git push -f*` しか塞いでおらず、
プレーンな `git push` と `gh` 系コマンドが素通しだった。`~/.config/gh` は読み取り
deny 対象 (D4 §2.2) だが、`gh` バイナリの実行自体は禁止されておらず、認証済み
環境がそのまま使えてしまう。結果として「L1 = 進捗ログ / draft PR のみ」の建前が
executor の裁量で無効化される。

## Decision

executor に注入する deny (ADR-0019 層1) に、**autonomy レベルと無関係に常時適用
される外部送信禁止**を追加する:

1. `Bash(git push*)` — force に限らず push 全面禁止。worktree 内での add/commit は
   引き続き許可 (成果の一次形態はローカルコミット、ADR-0016)。
2. `Bash(gh *)` — gh CLI の全面禁止。executor のタスク処理に gh は不要であり
   (Issue 取得は task-source、PR 作成は sink の責務)、部分許可は迂回の温床になる。
3. `Bash(git remote*)` — リモート先の付け替えによる迂回の防止。

これらは autonomy 非依存とする。L3 で push/PR を無人許可する場合も、実行主体は
sink であって executor ではない — 自律度の引き上げは「executor に権限を返す」
ことではなく「sink の有効範囲を広げる」ことで表現する (ADR-0006 の再確認)。

事後検証として、gate-loop-audit に「worktree のブランチがリモートへ push 済みで
ないこと」の検査を追加するかは実装時に判断する (二層防御、ADR-0019 と同型)。

## Alternatives Considered

### Alternative 1: autonomy レベル連動で deny を切り替える (L3 では executor の push を許可)
- **Pros**: 設定が一箇所で済み、L3 運用時の sink 実装が不要になる。
- **Cons**: 「executor はタスクを処理するだけ、処理後の動作は sink が定める」という
  ポート責務 (ADR-0006) を壊す。executor の成果反映は記録 (iter log / 配送参照) を
  経由しないため、何が外に出たかをハーネスが把握できない。
- **Why not**: 今回の実測がまさにこれの危険性を示した — 配送参照は commit SHA しか
  記録されず、PR #2 の存在をハーネスは関知していない。

### Alternative 2: ネットワーク遮断 (OS レベルの egress 制御)
- **Pros**: コマンド列挙より原理的に強い。
- **Cons**: OS レベルサンドボックスは ADR-0024 で非採用と決定済み。executor は
  モデル API への通信が必須で、選択的遮断は WSL2/ポータビリティ要件と衝突する。
- **Why not**: ADR-0024 の決定を覆す材料がない。deny 注入 + 事後 gate の既存二層
  (ADR-0019) の延長で対処できる。

### Alternative 3: 認証情報の分離 (executor 環境から gh/git 認証を剥がす)
- **Pros**: 権限がなければ迂回のしようがない。最小権限の原則に最も忠実。
- **Cons**: git 認証は worktree の親リポジトリ設定・OS の credential store 経由で
  漏れやすく、「剥がしきれたこと」の検証が難しい。ハーネス自身 (task-source/sink)
  は認証が必要なため、プロセス毎の環境分離の実装コストが大きい。
- **Why not**: 方向としては正しく将来の強化候補だが、まず deny で契約を明文化し
  即効性を取る。本 ADR は Alternative 3 の将来採用を妨げない。

## Consequences

### Positive
- 「executor = 処理、sink = 反映」の責務境界が権限レベルで強制され、自律度
  (ADR-0006) の意味が実態と一致する。
- 外部に出る成果が必ず sink (= autonomy フィルタ + 記録) を通るため、無人運用の
  監査可能性が回復する。

### Negative
- executor が「push まで済ませる」ことで得ていた見かけの効率は失われる (設計上
  意図しない効率なので許容)。
- L3 の無人 PR 作成には push/PR sink の実装が前提になる (現状未実装、ロードマップ
  上はユーザー実装領域。同梱リファレンスの要否は別途判断)。

### Risks
- deny パターンの網羅漏れ (例: `git -c ... push` 形式、エイリアス経由)。緩和:
  実装時にパターンを executor-settings.test.ts で列挙検証し、事後 gate 検査の
  追加を検討する。
- executor がタスク遂行上 gh を正当に必要とするケース (例: Issue 本文の追加取得)。
  緩和: 必要情報は task-source が body/context で渡す設計であり、不足があれば
  context プラグインの拡張で対応する (executor への権限返却では対応しない)。

## 関連

- ADR-0006 (自律度の sink フィルタ実装) — 本 ADR はその境界の権限的強制
- ADR-0019 (事前強制 + 事後 gate の二層) — 層1 deny リストの拡張として実装
- ADR-0020 (executor 権限プロファイル) — allowedTools 側の整合確認が必要
- ADR-0024 (OS レベルサンドボックス非採用) — Alternative 2 の却下根拠
