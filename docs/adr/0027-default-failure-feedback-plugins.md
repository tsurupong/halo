# ADR-0027: `project init` での on-fail-record + context-recent-failures 既定有効化

**Date**: 2026-08-01
**Status**: accepted (implemented 2026-08-01, PR #31)
**Deciders**: tsurupong, Claude

## Context

core の失敗理由再注入 (`lastFailure`, `packages/core/src/loop.ts`, D2 §2.4) は
プロセス内 in-memory の変数であり、同一プロセス内でループが継続する間しか
生存しない。しかし実運用の trigger (trigger-polling / trigger-schedule) は
`halo run` を都度新規プロセスとして起動する (D2 §2 の設計上の前提)。つまり
「直前の失敗理由を次の実行に伝える」経路は、in-memory の `lastFailure` では
プロセス境界を越えられず、`.halo/failure-catalog.jsonl` に失敗を書く
`on-fail-record` と、それを読んで次の実行コンテキストへ再注入する
`context-recent-failures` の組が有効化されていない限り機能しない。

2026-08-01 の実 GitHub E2E で、この組が無効なプロジェクトにおいて同一の
`gate-loop-audit` fail が2回連続で反復されることを確認した。`context-recent-
failures` を有効化した状態で再実行したところ、直前の失敗理由が次のタスク
コンテキストへ再注入され、実行が自己修正して pass した。同梱プラグインは
`halo enable <name>` による opt-in が既定であり、この2プラグインは
「有効化を忘れると症状が実運用でしか顕在化しない」種類の欠落だった。

## Decision

1. `packages/plugins/src/registry.ts` に `DEFAULT_ENABLED_PLUGINS =
   ['on-fail-record', 'context-recent-failures']` を追加する。
2. `halo project init` は scaffold 完了後、`DEFAULT_ENABLED_PLUGINS` を
   `halo enable` と同じ `materializeManifest` ヘルパーで
   `.halo/ports/<port>.d/<name>/plugin.json` として生成する (D11 §3.2a)。
   既存ファイルは上書きしない(§3 全体の冪等規約に合わせる)。
3. **なぜ core や scaffold ではなく CLI (`enable.ts`/`init.ts`) 側に置くか**:
   `packages/core` はゼロ依存を志向しており、`@tsurupong/halo-plugins`
   (同梱プラグインの実装パッケージ) には依存していない。既定有効化ロジックを
   core に置くと `halo-core → halo-plugins` という依存方向が生まれ、
   「core はポート契約のみを知り、個々のプラグイン実装を知らない」という
   既存の依存方向 (D1, D11 §1) が逆転する。CLI 側はすでに `halo enable` で
   `@tsurupong/halo-plugins` に依存しているため、同じ依存方向のまま拡張できる。
4. `halo doctor` に検査 c16 (`checkFailureFeedbackPair`) を追加する:
   `on-fail-record` が有効かつ `context-recent-failures` が無効なら WARN。
   **`doctor --fix` の対象外とする**: `--fix` (`repairSkeleton`) は骨格
   ディレクトリの欠損補完のみを扱う設計 (D3 §2.6) であり、個々のプラグインの
   有効化は対象にしていない。この非対称 (`init` は自動生成するが `--fix` は
   復元しない) は許容し、c16 の WARN と回復手順の提示 (`halo enable
   context-recent-failures`) で救済する。

## Alternatives Considered

### Alternative 1: 現状維持 (既定では何も有効化しない)
- **Pros**: 変更ゼロ。`project init` の「空の骨格を作るだけ」という単純さを保てる。
- **Cons**: 失敗学習ループ (要件§3.2 原則7) が実運用で恒常的に機能しない状態が
  既定になる。ユーザーが `docs/design/d11` を読んで能動的に `halo enable` する
  ことを前提にしており、2026-08-01 の E2E がまさにこの欠落を実証した。
- **Why not**: 「無人ループで品質ゲートを通過した成果物を継続的に生成する」
  というプロジェクトの目的 (CLAUDE.md) に対し、既定構成が目的を達成できない
  のは受け入れがたい。

### Alternative 2: core の `lastFailure` をファイルへ永続化し、trigger 起動でも
  読めるようにする
- **Pros**: プラグイン有効化に依存しない、より根本的な解決。
- **Cons**: core が「プロセスを跨ぐ永続状態」を持つことになり、D1/D2 が前提と
  する「core はプロセス内の状態機械」という境界 (D2 §2.4 の設計思想) を壊す。
  `context-recent-failures` と機能が重複し、二重実装になる。
- **Why not**: 既に `context-recent-failures` が同じ問題を解いており、
  「有効化されていない」ことが真因なら core を変更する必要がない。

### Alternative 3: `doctor` を FAIL にして強制する
- **Pros**: 見落としを構造的に防げる。
- **Cons**: 恒久的に `context-recent-failures` を使わない構成 (例: 失敗学習を
  別経路で行う私有プラグインに置き換える) もあり得るため、FAIL で `run` 全体を
  止めるのは過剰。c14 (watchdog heartbeat) / c15 (幽霊 claim) と同じ基準で
  WARN 止まりにするのが一貫している。
- **Why not**: 既存の doctor 設計 (D3 §4) の重大度基準から逸脱する。

## Consequences

### Positive
- 新規プロジェクトは既定で失敗学習ループが機能する状態から始まる。
- 既存プロジェクトも `halo doctor` の c16 WARN が回復手順とともに検知する。
- `halo enable` の `materializeManifest` を再利用するため、実装の重複がない。

### Negative
- `project init` の生成物が「完全に空の骨格」ではなくなる (D3 §3.2 の記述改訂
  が必要)。`.halo/ports/*.d/` の一部が非空になることを知らないユーザーが
  差分を見て驚く可能性がある → D3 §3.2a に明記して緩和する。
- `entry` は `require.resolve` 由来の絶対パスとして書き込まれるため、
  リポジトリ移動 (別ドライブ・別ディレクトリへの移設) やインストール先の
  変更で陳腐化する。これは `halo enable` が生成する `plugin.json` 全般と
  同種の既知の限界であり (c12 が `.sh` 参照の陳腐化を検出するのと同様)、
  絶対パス切れ自体を検出する専用チェックは本 ADR の範囲外。将来的に必要なら
  別 ADR で扱う。

### Risks
- `@tsurupong/halo-plugins` の解決に失敗する環境 (未インストール・依存壊れ)
  では既定有効化がサイレントにスキップされる。`init` を fatal にしない設計
  (Decision #2) のトレードオフとして許容し、warn メッセージで気づけるように
  する。

## 実装スコープ

`packages/plugins/src/registry.ts` (DEFAULT_ENABLED_PLUGINS) →
`packages/cli/src/commands/enable.ts` (`materializeManifest` の抽出・export) →
`packages/cli/src/commands/init.ts` (既定生成) →
`packages/core/src/doctor.ts` (c16) → docs (D3 §3.2a/§4, D11 §3) の順で
本 PR 内に実装を含む(起票のみの ADR-0025 とは異なり、この ADR は実装込み)。
