# ADR-0031: deny 注入のベンダ中立化(抽象 deny 意図と executor 固有形式の分離)

**Date**: 2026-08-08
**Status**: proposed
**Deciders**: tsurupong, Claude

## Context

ADR-0019 の層1(ex-ante 権限バリア)は core/src/executor-settings.ts が deny パターンを
`Read(...)` / `Write(...)` / `Bash(...)` という Claude Code 固有のツール名記法で生成し、
`claude --settings` が読む形式に固定している(issue #58)。このため:

1. 非 claude executor に差し替えると層1が**無警告で無効化**され、gate-loop-audit
   (層2, ex-post)だけが残る。ADR-0019 は二層を mandatory と規定している。
2. doctor c13 のドリフト検査(doctor.ts:493 → executor-settings.ts:183-184)も同じ
   Claude 記法ベースラインとの突き合わせであり、層1が効いていなくても形式上 OK を
   出し続けるため気付けない。
3. gate-loop-audit の保護対象(CLAUDE.md / PROMPT.md / .harness.yml /
   .claude/settings*.json、gate-loop-audit/main.ts:72-74)も Claude 前提で、Codex なら
   AGENTS.md 等の保護が必要になる。

## Decision

deny 生成を二段に分離し、ベンダ知識を executor プラグイン側へ移す:

1. **抽象 deny 意図(core)**: core は「secret 読取禁止 / 自己改変禁止 / 危険コマンド
   禁止」の 3 カテゴリを、ツール記法に依存しない抽象表現(対象パスパターン +
   操作種別 read/write/exec)で保持する。パターンの権威は引き続き core 単一リスト
   (ADR-0019 §Risks の乖離防止を維持)。
2. **変換器(executor プラグイン)**: executor プラグインが manifest の aux に
   settings 変換エントリを宣言し、抽象 deny 意図 → 自ベンダの settings 形式へ変換する。
   executor-claude は現行の Claude Code 記法(Read/Write/Bash + --settings)を生成する
   変換器を持つ(現行挙動の移設であり、既定構成の動作は変えない)。
3. **層1不在の可視化(doctor)**: 変換器を宣言しない executor が有効な場合、doctor は
   「層1(ex-ante deny)不在 — 層2(gate-loop-audit)のみで運用」を **WARN** で明示する。
   FAIL にしないのは、層2が残る縮退運用を許容しつつ無警告状態だけを排除する趣旨。
   c13 ドリフト検査は「有効 executor の変換器が生成したベースライン」との比較に改める。
4. **保護対象パス集合の設定可能化**: gate-loop-audit の保護対象(エージェント設定
   ファイル群)を、executor プラグインが manifest で宣言する追加保護パス
   (例: Codex なら AGENTS.md)とマージして構成できるようにする。既定集合
   (CLAUDE.md / PROMPT.md / .harness.yml / .claude/settings*.json)は維持する。

## Alternatives Considered

### Alternative 1: 現状維持(Claude 記法固定)
- **Pros**: 変更ゼロ。executor-claude 単独運用では問題ない
- **Cons**: 非 claude executor で層1が無警告消失する。ADR-0019 の mandatory 二層に反する
- **Why not**: 安全不変条件の無警告な喪失は HALO の設計上許容できない

### Alternative 2: core に全ベンダの変換器を持つ(claude/codex を core 内 switch)
- **Pros**: プラグイン契約の変更が不要
- **Cons**: core がベンダ知識を抱え込み、サードパーティ executor に対応できない
- **Why not**: ADR-0018(プラグイン自己記述)・ADR-0030 と同じ理由で、ベンダ知識は
  プラグイン側に置く

### Alternative 3: 層1を諦め、層2(gate-loop-audit)だけを正とする
- **Pros**: 実装が最も簡単
- **Cons**: ex-post 検査のみでは「実行されてしまった後」しか検出できない。
  ADR-0019 の受理理由(事前強制の必要性)を放棄することになる
- **Why not**: 既定構成(claude)で現に機能している安全層を自ら外す理由がない

## Consequences

### Positive
- executor 差し替え時の安全層の状態(層1あり/なし)が常に可視化される
- サードパーティ executor が自前の変換器で層1に参加できる
- deny パターンの権威は core 単一リストのまま(乖離防止を維持)

### Negative
- executor ポートの aux 契約拡張(manifest + contracts スキーマ + fixtures)が必要
- executor-settings / doctor c13 / gate-loop-audit の 3 箇所に跨る変更で、
  既存テストの書き換えを伴う — 実装は無人ループに投入せず人間セッションで行う

### Risks
- 変換器の実装誤りで deny が弱まる → c13 を「変換器出力 vs 実 settings」の比較に
  改めることで、変換器出力自体の妥当性は contract fixtures で担保する
- 抽象表現が特定ベンダの表現力に引きずられる → 3 カテゴリ(read/write/exec ×
  パスパターン)の最小語彙から始め、必要になるまで拡張しない

## Implementation Tasks(分割案)

1. core: 抽象 deny 意図の型とリスト定義(現 DENY_* 定数の抽象化、needs-human)
2. contracts + plugins: executor aux への変換器エントリ追加、executor-claude へ
   現行記法生成を移設(needs-human、c13 テスト変更あり)
3. core: doctor の層1不在 WARN + c13 の比較先変更(needs-human)
4. plugins: gate-loop-audit の保護対象パスを manifest 宣言とマージ(kind:code)

## Notes

ADR-0030(doctor の executor 検査ポート駆動化)と対で、executor のベンダ中立化を
構成する。manifest 拡張(requires / aux)は両 ADR で整合させること。
