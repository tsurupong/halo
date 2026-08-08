# ADR-0030: doctor の executor 検査ポート駆動化と SINGLE_PORTS の扱い

**Date**: 2026-08-08
**Status**: proposed
**Deciders**: tsurupong, Claude

## Context

executor ポート契約(contracts/src/ports.ts)自体はベンダ非依存だが、周辺 2 箇所が
claude を暗黙の前提にしている(issue #57):

1. **doctor**: core/src/doctor.ts:27 の `REQUIRED_COMMANDS = ['node','git','claude']` と
   `checkClaude`(doctor.ts:162-178, 呼び出し :602)により、claude 不在環境では
   有効な executor が別に存在しても doctor が FAIL で exit 1 する。応答検査も
   `CommandProbe.claudeResponds()`(doctor.ts:52)として claude 固定。
2. **単一 executor 制約**: core/src/discovery.ts:40 の `SINGLE_PORTS` に executor が
   含まれ、enabled な executor は常に 1 つのみ。ADR-0029 で導入した
   `kinds.<name>.executor`(contracts/src/manifest.ts:86)による kind 別ルーティングは
   「複数の executor を有効化して kind ごとに選ぶ」意図であり、この制約と矛盾する
   (現状は 1 つしか有効化できないため、選択肢が常に 1 つ)。

Codex 等の非 claude executor への差し替え・併用を可能にするには、この 2 点の
設計判断が必要。

## Decision

### 1. doctor の executor 存在検査をポート駆動化する

- `REQUIRED_COMMANDS` から `claude` を外し、`['node','git']` とする。
- executor プラグインが manifest で必要コマンドを宣言する: manifest に任意フィールド
  `requires.commands: string[]` を追加(contracts のスキーマ拡張。未宣言は検査なし、
  後方互換)。executor-claude は `["claude"]` を宣言する。
- doctor は「有効化済みの各 executor プラグイン」の宣言コマンドを検査する:
  `checkClaude` → `checkExecutorCommand(plugin)` へ一般化し、
  `CommandProbe.claudeResponds()` → `commandResponds(cmd)` へ置き換える。
- executor が 1 つも有効化されていない場合は従来どおり discovery 検査(c系)で
  検出されるため、doctor 側の追加検査は行わない。

### 2. SINGLE_PORTS から executor を外し、複数有効化を許可する

- `SINGLE_PORTS` は task-source のみとする(claim 機構 ADR-0025 の一意性は維持)。
- 複数 executor 有効時の選択規則は ADR-0029 の `selectExecutor` に既に定義済み:
  kind に `executor` 指定があれば完全一致で選択、未指定はポート先頭
  (discovery order)。この規則を変更しない — つまり「複数有効化 + kind ルーティング」
  が正、単一有効化は従来互換の特例となる。
- doctor は複数 executor 有効時、kind 定義のどれからも参照されない executor を
  WARN で報告する(誤設定の可視化。FAIL にはしない)。

## Alternatives Considered

### Alternative 1: 現状維持(claude 直書き + 単一 executor)
- **Pros**: 変更ゼロ。既定構成(executor-claude 単独)では実害がない
- **Cons**: 非 claude executor 環境で doctor が虚偽の FAIL を返す。ADR-0029 の
  kind ルーティングが実質機能しない
- **Why not**: executor プラグイン差し替え可能というポート設計(D1 §3)と矛盾したまま
  になるため

### Alternative 2: doctor に executor 名の if 分岐を追加(claude なら claude 検査、codex なら codex 検査)
- **Pros**: manifest スキーマ変更が不要
- **Cons**: core が個別ベンダ知識を持ち続け、サードパーティ executor で再び壊れる
- **Why not**: 検査対象の知識はプラグイン自身が宣言すべき(ADR-0018 の manifest
  自己記述原則)

### Alternative 3: SINGLE_PORTS 維持 + kind ルーティング廃止(ADR-0029 巻き戻し)
- **Pros**: 制約の矛盾は消える
- **Cons**: kind 単位の executor 使い分け(実装は claude、文書は別)ができなくなる
- **Why not**: ADR-0029 の受理理由がそのまま生きているため

## Consequences

### Positive
- claude 非依存の環境(Codex 等)でも doctor が正しく診断できる
- 複数 executor の併用が可能になり、ADR-0029 の kind ルーティングが本来の意図で機能する
- manifest の `requires.commands` は runtime 等他ポートにも将来転用できる

### Negative
- contracts の manifest スキーマ拡張(スキーマ再生成 + fixtures 更新)が必要
- 既存 doctor テスト(checkClaude 前提)の書き換えが必要 — gate-loop-audit 検査②に
  抵触するため、実装は無人ループに投入せず人間セッションで行う

### Risks
- `requires.commands` 未宣言の executor は存在検査をすり抜ける → doctor が
  「宣言なし(検査スキップ)」を INFO/WARN で明示して緩和
- 複数 executor 有効化で意図しない先頭選択が起きる → 未参照 executor の WARN と
  ADR-0029 のサイレントフォールバック禁止で緩和

## Implementation Tasks(分割案)

1. contracts: manifest `requires.commands` 追加 + スキーマ再生成(kind:code)
2. core: doctor の REQUIRED_COMMANDS 縮小・checkExecutorCommand 化・
   commandResponds 化(needs-human、既存テスト変更あり)
3. core: SINGLE_PORTS から executor 除外 + 未参照 executor WARN(needs-human)
4. plugins: executor-claude の manifest に requires.commands 宣言(kind:code)
