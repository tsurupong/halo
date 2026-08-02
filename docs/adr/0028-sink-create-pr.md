# ADR-0028: sink-create-pr の前倒し実装

**Date**: 2026-08-02
**Status**: accepted (implemented 2026-08-02, issue #45)
**Deciders**: tsurupong, Claude

## Context

D1 §1.5 は create-pr sink を「Phase 1 以降へ延期」としており、bundled sink は
`sink-git-commit`(ローカルコミットのみ、push はしない)と `sink-progress-log` の
2つに留めていた。ADR-0026 / PR #24 で executor の外部送信禁止(`git push*` /
`gh *` 全面禁止)を実装した結果、executor が越権で push・PR 作成する経路は
塞がったが、これは同時に「L2+ で本来 sink が担うはずの外部公開経路」がまだ
実装されていないことも露呈させた。2026-08-02 実施の実 GitHub E2E スモーク
(#7/#8) で、issue → HALO 実行 → gate pass までは通るものの、worktree の変更が
`sink-git-commit` によるローカルコミットで止まり、リモートへの反映も PR 作成も
発生しないため issue→PR の無人完走が不可能であることが判明した。

## Decision

`sink-create-pr` を単一 sink として前倒し実装し、bundled plugin として同梱する。

1. AUTONOMY によって挙動を分岐する: `L2` は draft PR (`gh pr create --draft`)、
   `L3` は通常 PR。`minAutonomy: L2` とし、L1 では実行されない
   (`shouldRunSink`、既存の autonomy フィルタをそのまま利用)。
2. push は `--force-with-lease -u origin <branch>` を用いる。ハーネスは同一
   ブランチで worktree を作り直しながら複数周回することがあり、ローカル履歴が
   毎周異なっても(外部から誰も触れていない限り)成功する必要があるため。
3. 既存 PR の有無は `gh pr view <branch> --json url -q .url` で確認し、あれば
   `gh pr create` を呼ばない(重複PR防止)。
4. 得られた PR URL(新規作成・既存いずれも)は `<workdir>/.halo-pr-url` に
   書き込む。run-wiring の `resolvePrUrl` はこのファイルを最優先で読み、
   無ければ ADR-0016 の `commit:<sha>` 判定へフォールバックする — sink と
   コアの間の完了参照の受け渡しをプロセス境界越しのファイルで行う
   (sink は core と別プロセスで実行される、entry 契約 ADR-0018)。
5. plugin order は `30`(`sink-git-commit`=10、`sink-progress-log`=20 の後、
   ローカルコミット→進捗ログ→PR作成の順で実行される)。

## Alternatives Considered

### Alternative 1: D1 §1.5 の予定通り Phase 1 以降へ延期する
- **Pros**: 計画の変更なし。実装コストゼロ。
- **Cons**: ADR-0026 で executor の越権 push を封じた結果、L2+ の外部公開経路が
  代替不在のまま無くなっており、issue→PR の無人完走という要件の中核機能が
  実運用で欠落したままになる。
- **Why not**: 「夜間無人稼働で品質ゲートを通過した成果物を継続的に生成する」
  というプロジェクト目的(CLAUDE.md)に対し、PR 作成という最終成果物の反映
  経路が無いのは受け入れがたい。E2E スモークで実際に issue→PR が完走しない
  ことを確認済み。

### Alternative 2: sink-git-commit を拡張して push・PR 作成も担わせる
- **Pros**: 新規プラグインを増やさずに済む。
- **Cons**: sink-git-commit は「ローカルコミットのみ、push はしない」という
  ADR-0016 由来の単純な責務を持つ。push・PR 作成という外部公開の責務を混ぜると
  L1 専用の既定有効化(minAutonomy 無しで常時実行)と L2+ 限定の外部公開を
  1プラグイン内で分岐する必要が生じ、autonomy フィルタ(`shouldRunSink` は
  プラグイン単位の `minAutonomy` のみを見る)の設計と噛み合わない。
- **Why not**: 責務分離を優先し、既存の sink 単位 autonomy フィルタをそのまま
  使える独立プラグインとした。

## Consequences

### Positive
- issue→実行→gate pass→PR 作成までの無人完走経路が L2+ で復活する。
- PR URL の受け渡しがファイル経由になり、resolvePrUrl のロジックが
  sink 実装の詳細(git/gh 呼び出し)から独立する。

### Negative
- bundled sink がもう1つ増え、`halo enable` 済みプロジェクトでの動作確認範囲が
  広がる。

### Risks
- `--force-with-lease` は「外部から誰も触れていない」ことが前提。複数の
  HALO インスタンスが同一ブランチを同時に扱う運用では push が失敗し得るが、
  失敗時は diag して exit 0(ベストエフォート)であり、次周回で再試行される。
