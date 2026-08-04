# ADR-0029: .harness.yml kind への executor 明示指定

**Date**: 2026-08-04
**Status**: accepted (implemented 2026-08-04, issue #51)
**Deciders**: tsurupong, Claude

## Context

executor ポートは他の single 系ポート(task-source)と同様、「有効化済み plugin.json
の先頭(discovery order)を実行する」という run_port/runLoop 共通のポート機構
(D1 §3.1、D2 §3.6)にそのまま従っており、kind 単位で切り替える手段がなかった。
`.harness.yml` の kind 定義(D1 §1.8、D2 §7)が担うのは runtimes と prompt の解決
のみで、executor は事実上 `claude -p` アダプタ 1 種類の固定運用を前提にしていた。
複数の executor アダプタを同梱・選択可能にする(例: 実装用途は claude-headless、
文書レビュー用途は別アダプタ)には、kind から executor を明示指定できる経路が
必要になった。

## Decision

`.harness.yml` の kind 定義に任意フィールド `executor` を追加する:

1. 型はプラグイン名の文字列 (`kinds.<name>.executor: <plugin name>`)。省略可能。
   空文字列は `ConfigError`(`config.ts` `validateKind`)として起動時ではなく
   kind 解決時に拒否する(D2 §7.2)。
2. 解決は有効化済み executor プラグイン一覧との**完全一致**で行う
   (`loop.ts` `selectExecutor`、純粋関数)。
   - 未指定 → 従来通りポート先頭(discovery order の 1 番目、後方互換)。
   - 指定あり・一致 → そのプラグインを使用。
   - 指定あり・不一致(未有効化名) → run 全体は止めず、**該当タスクのみ**
     既存の kind 誤設定(未定義 kind / 存在しない runtime、D2 §7.2 手順3)と
     同一の needs-human エスカレーション経路に載せる。on-fail 実行・
     task-source `fail`・claim release も既存の kind 誤設定処理と同じ経路を
     通るため、claim が占有されたまま残ることはない(ADR-0025)。
3. サイレントフォールバック(未有効化名を黙って先頭 executor に読み替える)は
   禁止。誤設定はエスカレーション理由(指定名 + 有効化済み executor 名一覧)
   として可視化する。
4. 選択は kindPrompt 解決直後、worktree 作成前に行う(D2 §7.2 の kind 解決と
   同じタイミング。実行しないタスクのために worktree を払わない)。

## Alternatives Considered

### Alternative (a): 未有効化名を `LoopError` として run 全体を停止する
- **Pros**: 実装が単純(例外を投げるだけ)。
- **Cons**: `LoopError` は `runLoop` を即座に打ち切るため、その時点で claim
  済みのタスクが `release` されないまま残る — ADR-0025 が「並列化の前提」
  として導入した claim/release セマンティクスが守られない状態になる。
  1 タスクの kind 誤設定で run 全体(他タスクの処理)が止まるのも過剰。
- **Why not**: 誤設定の影響範囲をタスク単位に閉じる既存方針(D2 §7.2 手順3)
  と矛盾し、claim の幽霊化を招く。

### Alternative (b): preflight で全 kind の executor 参照を事前検証する
- **Pros**: 実行前に設定ミスを検出でき、実行時のエスカレーションが減る。
- **Cons**: `.harness.yml` は複数 kind を宣言でき、当該イテレーションで
  実際には使わない kind の設定ミスまで起動条件にしてしまう。D2 §7 の
  kind 解決は「必要になった時点で遅延解決する」方針であり、事前の
  全件検証はこれと衝突する。有効化状態は実行時にも変わり得るため、
  preflight 時点の検証はその後の陳腐化にも弱い。
- **Why not**: 遅延解決方針(D2 §7)を維持し、使われない kind の設定不備で
  起動不能にしないため。

### Alternative (c): 未有効化名の場合は先頭 executor へ暗黙フォールバックする
- **Pros**: run もタスクも止まらず、体験上は「動く」ように見える。
- **Cons**: 意図した executor と異なるアダプタで実行され続けても誰も気づかない。
  誤設定(タイポ等)を隠蔽する点で、Decision #3 が明示的に禁じる挙動そのもの。
- **Why not**: 誤設定の隠蔽は「気づかれないまま動き続ける」害の方が大きい
  (ADR-0004 が「警告だけして継続」を却下した理由と同種)。

## Consequences

### Positive
- kind 単位で executor アダプタを切り替えられ、複数 executor 実装の同梱・
  使い分けが可能になる。
- 誤設定はタスク単位の needs-human エスカレーションとして可視化され、
  claim も既存経路で確実に解放される。

### Negative
- `.harness.yml` のスキーマ・D1/D2 の記述・実装(config.ts / harness.ts /
  loop.ts)の3層改訂が必要になった。

### Risks
- 有効化状態は実行中に変化しないため、実行時点で有効化されている executor
  一覧を都度参照する前提が崩れることはないが、CLI 側 `run-wiring.ts` の
  配線を変更した場合はこの前提を再確認する必要がある(本 ADR の実装では
  `run-wiring.ts` は無変更)。

## References

- D1 §1.8(`.harness.yml` kind スキーマ)
- D2 §7.2(kind Resolution、executor 選択順序を追記)
- `packages/core/src/loop.ts` `selectExecutor`
- issue #51
