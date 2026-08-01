# ADR-0025: task-source 契約への claim/release セマンティクス追加

**Date**: 2026-07-29
**Status**: accepted (implemented 2026-07-29, PR #29)
**Deciders**: tsurupong, Claude

## Context

現行の task-source 契約 (D1 §1.1) の `op=next` は「次の ready タスクを 1 件返す」だけで、
返したタスクを「処理中」としてマークする義務を実装に課していない。同梱の
task-source-local は complete まで queue/ にファイルを残す設計であり、単一直列ループ
(D2 §2) では「失敗タスクが queue 先頭に残る → 次イテレーションで同一タスクが再取得される」
というソート順の副産物として正しく動く。しかしこの正しさは契約ではなく実装の偶然に
依存しており、(1) 並列ワーカー化 (Phase 5、`write_set` フィールドが既に予約済み) では
複数ワーカーが同一タスクを同時取得して二重実行する、(2) 直列運用でも「いまどのタスクが
処理中か」が task-source の状態として観測できない、という 2 つの問題がある。

## Decision

task-source 契約に「claim(占有)」の意味論を追加する:

1. `op=next` は選択したタスクを **claim 済み(処理中)** としてマークしてから返す。
   claim は原子的でなければならない(local 実装は `queue/ → doing/` の atomic rename、
   github 実装は `ready → in-progress` ラベル付け替え)。claim 済みタスクは以後の
   `op=next` で返してはならない。
2. 新 op `release` を追加する: `{op: "release", task_id, reason}`。claim を解除して
   タスクを ready に戻す。core は「実行が成果に至らず、かつエスカレーション閾値
   未達」の失敗経路 (D2 §2.4) の末尾で `release` を呼ぶ。閾値到達時は従来通り
   `fail` がエスカレーション (needs-human) を担い、release は呼ばない。
3. `complete` / `fail` は claim 済みタスクに対する終端操作として意味論を明確化する
   (complete = claim 解除 + 完了記録、fail = 失敗記録、閾値到達時は隔離)。
4. クラッシュ耐性: claim したまま launch が異常終了したタスクの回収は task-source
   実装の責務とする (local: doctor/preflight による doing/ の stale 判定 → queue/ へ
   戻す。github: in-progress ラベルの stale 判定)。core は関与しない。

契約バージョンは op 追加 (受理側が知らない op を拒否できる後方互換の拡張) として
MINOR 扱いとする (ADR-0018 の contract.fixtures.json に release ケースを追加)。

## Alternatives Considered

### Alternative 1: 現状維持 (claim なし、直列前提を維持)
- **Pros**: 変更ゼロ。単一ループでは実害がない。
- **Cons**: 並列化 (Phase 5) の前提が立たない。処理中状態が外部から観測不能。
  「同一タスクが再試行される」根拠が実装のソート順依存のまま。
- **Why not**: `write_set` で並列を予告している以上、占有の意味論の欠落は設計負債。

### Alternative 2: core 側で claim を管理 (task-source は無変更)
- **Pros**: プラグイン実装に負担をかけない。
- **Cons**: core が「タスクの状態」を持つことになり、「タスクの所在と状態は
  task-source が所有する」というポート境界 (D1 §1.1) を壊す。core のプロセスが
  複数になった瞬間 (B案: マルチプロセス並列) に core 側 claim 自体が競合する。
- **Why not**: 状態の所有権が二重化し、単一障害点が増えるだけで根本解決にならない。

### Alternative 3: claim 専用 op (`op=claim`) を next と分離
- **Pros**: 取得と占有を分けられ、覗き見 (peek) が可能になる。
- **Cons**: next→claim の 2 相にすると、その間の競合窓が生まれ原子性が壊れる。
  ユーザー実装プラグインに正しい 2 相実装を要求するのは酷。
- **Why not**: 「next = 原子的 claim + 返却」の 1 相の方が実装も検証も単純。

## Consequences

### Positive
- 並列ワーカー化 (Phase 5) の前提となる排他が契約レベルで保証される。
- `doing/` (または in-progress ラベル) により処理中タスクが観測可能になり、
  watchdog / doctor / status の情報源が増える。
- ユーザーが自作する task-source にも「何を保証すべきか」が明文で伝わる。

### Negative
- 契約変更のため、同梱 2 実装 (local/github) + fixtures + D1/D5 の改訂が必要。
- ユーザー自作の既存 task-source は release を知らない → core は release の
  非対応 (非 0 exit) を best-effort として握りつぶす移行措置が要る。

### Risks
- claim したまま死ぬ launch による「幽霊 in-progress」— 回収責務を task-source に
  明記 (Decision #4) し、doctor の検査項目に追加することで緩和する。
- rename の原子性は同一ファイルシステム内でのみ保証される — local 実装の
  queue/ と doing/ は同一ディレクトリ配下 ($HALO_TASKS_DIR) に置く制約を D5 に明記。

## 実装スコープ (別 PR)

contracts (`ports.ts` + schema + fixtures) → core (`loop.ts` の release 呼び出し) →
plugins (task-source-local / task-source-github) → docs (D1 §1.1, D2 §2.4, D5) の順。
本 ADR は起票のみで実装を含まない。
