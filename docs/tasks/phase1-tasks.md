# Phase 1 実装タスクリスト（骨格の証明）

| 項目 | 内容 |
|---|---|
| 文書バージョン | 1.0 |
| 対象 | **Phase 1 のみ**（要件定義書 v1.8 §9 のロードマップ表 Phase 1 行が権威） |
| Phase 1 の狙い | 「賢さゼロでも壊れない骨格（構造・安全装置・計測）」の実体化（要件 §9 原則1）。**AUTONOMY=L1 固定** |
| 実装方針 | TDD（各タスクの完了条件にテストを含む）。1 タスク = 1 エージェントセッション（目安 1〜3 ファイル） |

## 基準文書

| 記号 | 文書 | 本タスクリストでの用途 |
|---|---|---|
| 要件 | HALO要件定義書 v1.8 | §8 リポジトリ構成 / §9 Phase 1 範囲（権威） / §11.1 安全不変条件 |
| D1 | docs/design/d1-contract-spec.md | 9 ポート I/O 型・JSON Schema・plugin.json・実行規約・kg:// |
| D2 | docs/design/d2-core-design.md | core 9 モジュール・loop 状態機械・runPort・preflight・budget・discovery・worktree |
| D3 | docs/design/d3-cli-spec.md | 6 コマンド・委譲マップ・終了コード規約 |
| D4 | docs/design/d4-security-design.md | loop-audit 7 検査・保護対象（gate-loop-audit の内容確定） |
| D5 | docs/design/d5-plugin-dev-guide.md | 見本プラグイン実装骨子・contract test の書き方 |
| D8 | docs/design/d8-test-strategy.md | vitest / executor モック / contract test / CI |

## Phase 1 のスコープ境界（要件 §9）

- **作る**: CLI エントリ（flock / プリフライト / STOP / TIMEOUT）、core（loop + runPort, TS）、task-source 最小実装、executor（使い捨て worktree ライフサイクル）、runtime 1 種のみ（node-pnpm）、gate（runtime 委譲 + **loop-audit = 自己改変禁止、初日から必須**）、on-fail（記録のみ）、sink（progress-log のみ）、Windows タスクスケジューラ起動経路。
- **入れない（後 Phase へ除外）**: context.d（空のまま）、MCP / mcp.d 実装、グラフ全部（codegraph / knowledge / KuzuDB / 陳腐化検出）、evaluator（40-ai-review）、PR 作成（15-create-pr）、10-git-commit、並列 worktree、30-suggest-sign / recent-failures 再注入運用（Phase 2）、kind:docs / docs-md runtime（Phase 3）。
- **Phase 1 完了基準**: ①無人起動→N イテレーション→自動終了の 1 サイクル（dry-run: MAX_ITER=1 から）②L1 の計画報告が毎晩 logs/ に残り採点できる ③gate fail の reason が次イテレーションへ再注入される ④STOP / flock / TIMEOUT が実際に効く。

> **注**: sink は Phase 1 では `20-progress-log`（minAutonomy: L1）のみ。`10-git-commit` / `15-create-pr` はコアの autonomy フィルタ実装（M3）では L1 でスキップされる対象として扱い、プラグイン実体は Phase 2/3 まで作らない。ただし autonomy モジュールの L1/L2/L3 判定ロジック自体は Phase 1 で実装・テストする（安全装置の一部）。

---

## M1. monorepo scaffold（pnpm workspace / tsconfig / vitest）

| ID | タスク | 成果物（パス） | 依存 | 主参照 | 完了条件（テスト含む） |
|---|---|---|---|---|---|
| T01 | pnpm workspace ルート初期化（`pnpm-workspace.yaml`・ルート `package.json`・`.gitignore`・`.npmrc`） | `/pnpm-workspace.yaml`, `/package.json`, `/.gitignore`, `/.npmrc` | — | 要件 §8.1 | `pnpm install` が 3 パッケージ（core/cli/contracts）を認識しエラーなく完了。ルート scripts に `build`/`test`/`lint` が定義され空実行が通る |
| T02 | 共有 TypeScript 設定（`tsconfig.base.json` + 各パッケージ `tsconfig.json`） | `/tsconfig.base.json`, `/packages/{core,cli,contracts}/tsconfig.json` | T01 | 要件 §8.1, D2 §1 | `tsc -b` が全パッケージで型エラーなく通る（空 index でも可）。strict 有効 |
| T03 | vitest 設定 + カバレッジ設定（ワークスペース共通） | `/vitest.config.ts`（or 各パッケージ）, `/package.json` test script | T01 | D8 §1.1, §5 | `pnpm test` がゼロテストでも exit 0。`--coverage` が起動する |
| T04 | 3 パッケージの package.json 雛形（`halo` CLI / `@halo/core` / `@halo/contracts`、依存関係・bin・exports） | `/packages/{core,cli,contracts}/package.json` | T01 | 要件 §8.1, D3 §0 | cli が core・contracts を workspace 依存として解決。cli の `bin.halo` が定義され `node_modules/.bin/halo` が生成される |
| T05 | Lint/format 基盤（eslint + prettier、ルート設定） | `/eslint.config.js`, `/.prettierrc` | T01 | 要件 コーディング規約 | `pnpm lint` が空パッケージで exit 0 |

**M1 は T01 が完了すれば T02〜T05 を並列実行可能。**

---

## M2. packages/contracts（D1 の型 + JSON Schema 生成）

単一の真実の源は TS 型定義、JSON Schema は生成物（D1 §6.1）。

| ID | タスク | 成果物（パス） | 依存 | 主参照 | 完了条件（テスト含む） |
|---|---|---|---|---|---|
| T06 | ポート I/O の TS 型定義（task-source in/out, context out/Fragment, executor in/out, gate in/out, sink in, on-fail in, runtime in） | `/packages/contracts/src/ports.ts` | T02, T04 | D1 §1.1〜1.7 | 全型が D1 の表と一致（必須/任意フィールド・enum 値）。`tsc` 通過。型の単体（型テスト or サンプル値の代入）で必須欠落がコンパイルエラーになる |
| T07 | plugin.json / .harness.yml / kg:// URI の TS 型 | `/packages/contracts/src/manifest.ts` | T06 | D1 §2, §1.8, §4 | plugin.json の `port` enum 8 値・`minAutonomy` enum・`version` semver 型が D1 と一致。harness-yml の `kinds` 構造が一致 |
| T08 | JSON Schema 自動生成スクリプト（TS 型 → `*.json`, Draft 2020-12, `$id` 規約） | `/packages/contracts/scripts/gen-schema.ts`, `/packages/contracts/package.json`（gen script） | T06, T07 | D1 §6.1, 付録 A, D8 §3.3 | `pnpm --filter @halo/contracts gen` が D1 付録 A の 12 スキーマを出力。`$id` が `https://halo.dev/contracts/<port>.<io>.json` |
| T09 | 生成済み Schema のコミット + 乖離検出テスト（再生成して差分ゼロ検証） | `/packages/contracts/schemas/*.json`, `/packages/contracts/src/schema-drift.test.ts` | T08 | D8 §3.3, §5.1 | 再生成結果がコミット済み `*.json` と差分ゼロ。意図的に型を変えると drift テストが fail する（回帰確認） |
| T10 | Schema エクスポート配線（`@halo/contracts` から型と `*.json` を import 可能に） | `/packages/contracts/src/index.ts`, package.json exports | T08 | D1 §6.2, D5 §4.1 | 他パッケージから `import { GateOut } from '@halo/contracts'` と `import gateOut from '@halo/contracts/gate.out.json'` の双方が解決 |

**依存順**: T06 → T07（並列可: T06 完了後）→ T08 → {T09, T10 並列}。

---

## M3. packages/core の 9 モジュール

依存順（D2 付録 A）: `config`/`logger`/`lock` → `discovery`/`runPort` → `preflight`/`budget`/`autonomy` → `loop`。各モジュールは純粋関数を副作用境界から分離（D2 §1, D8 §1.1）。

| ID | タスク | 成果物（パス） | 依存 | 主参照 | 完了条件（テスト含む） |
|---|---|---|---|---|---|
| T11 | `logger` モジュール（`iter_N.json` 整形・stderr 退避整形・gate 通過率記録） | `/packages/core/src/logger.ts` + `.test.ts` | T04 | D2 §1.1(#9), D8 §1.2(#9) | 純粋整形関数の単体テスト（フィールド欠落既定・機微情報非混入）。カバレッジ ≥85% |
| T12 | `config` モジュール（プロファイル/env/.harness.yml/plugin.json 読込・上書き規則 CLI>profile>既定の正規化） | `/packages/core/src/config.ts` + `.test.ts` | T11, T07 | D2 §1.1(#1), §9, D3 §2.1 | マージ順序・必須欠落エラー・上書き優先順のテスト。カバレッジ ≥90% |
| T13 | `lock` モジュール（`$TMPDIR/halo.lock` flock・取得/解放・残留検出の純粋判定部） | `/packages/core/src/lock.ts` + `.test.ts` | T11 | D2 §1.1(#8), 要件 §4.4 | 二重取得拒否・残留検出ロジックのテスト。カバレッジ ≥85%。**T11 完了後 T12 と並列可** |
| T14 | `discovery` モジュール（`ports/<port>.d/` 走査・order 昇順安定ソート・有効化判定） | `/packages/core/src/discovery.ts` + `.test.ts` | T12 | D2 §6, D1 §2 | 数字プレフィックス昇順・order 優先・重複時の名前順安定ソート・削除反映のテスト。単一ポート 0 件でコア停止判定。カバレッジ ≥90% |
| T15 | `discovery` の `.harness.yml` 上向き探索・kind 解決 | `/packages/core/src/harness-resolve.ts` + `.test.ts` | T14 | D2 §7, D1 §1.8 | 親方向探索・`.git` 停止・不在時 needs-human・kind 未定義/runtime 不在時 needs-human のテスト |
| T16 | `runPort` モジュール（spawn・stdin JSON 投入・stdout パース・境界 Schema 検証・timeoutSec 強制・stderr 回送・終了コード伝播） | `/packages/core/src/run-port.ts` + `.test.ts` | T12, T10 | D2 §3, D1 §3, §6.2 | stdin 直列化・終了コード写像（0/2/その他）・stdout パース失敗の扱い・timeout 付与のテスト（子プロセスはモック/フィクスチャスクリプト）。カバレッジ ≥85%。**T14 と並列可** |
| T17 | `budget` モジュール（`logs/` 当日実績集計・上限比較の都度計測） | `/packages/core/src/budget.ts` + `.test.ts` | T11 | D2 §5, D8 §1.2(#6) | 当日分集計・上限超過真偽・境界値（丁度上限・空ログ）のテスト。カバレッジ ≥90%。**T13 完了後、logger のみ依存で並列可** |
| T18 | `autonomy` モジュール（sink `minAutonomy` × 現在 AUTONOMY のフィルタ、未宣言=最安全側 L3） | `/packages/core/src/autonomy.ts` + `.test.ts` | T12 | D2 §2.5, D1 §1.5, D8 §1.3 | L1/L2/L3 と有効/スキップの写像・未宣言 L3 扱いのテスト（D8 §1.3 の例を含む）。カバレッジ ≥95%。**T16 と並列可** |
| T19 | `preflight` モジュール（軽量段: STOP/lock/予算残/ready 有無、重量段: 作業ツリー clean/ディスク/グラフ鮮度は Phase 1 は no-op スタブ） | `/packages/core/src/preflight.ts` + `.test.ts` | T13, T17, T14 | D2 §4, D3 §5.1 | 軽量段の判定順序・短絡・各停止条件で exit 0 のテスト。重量段は git clean/ディスクのみ（グラフ鮮度は Phase 4 スタブ）。カバレッジ ≥90% |
| T20 | `loop` 状態機械（next→context→execute→gate→sink/onFail、4 実行戦略、retry 再注入、5 終了条件） | `/packages/core/src/loop.ts` + `.test.ts` | T16, T18, T19 | D2 §2, §3.6, D8 §2 | 状態遷移・executor status 分岐（done/stuck/timeout）・gate 論理 AND・context マージ（priority 降順切詰め）・retry reason 再注入・終了条件 5 種のテスト。カバレッジ ≥90% |
| T21 | ループ回帰テスト（executor/gate/task-source モック = 固定 JSON、課金ゼロ E2E 近似） | `/packages/core/src/loop.regression.test.ts`, `/packages/core/test/mocks/*` | T20 | D8 §2.1〜2.4 | 成功/gate fail 再注入/stuck/timeout/タスクなし の 5 経路と終了条件 5 種を固定 JSON で再現。D8 §2.4 の retry 再注入例が通る |

**並列可グループ**: {T12, T13}（T11 後） / {T14, T16, T18, T17}（各依存充足後） / T15（T14 後）。T19→T20→T21 は直列。

---

## M4. packages/cli（6 コマンド）

CLI はロジックを持たず core へ委譲（D3 §0, §6）。

| ID | タスク | 成果物（パス） | 依存 | 主参照 | 完了条件（テスト含む） |
|---|---|---|---|---|---|
| T22 | CLI エントリ + 引数パーサ + グローバルフラグ（`--cwd/--json/--quiet/--verbose/--version/--help`）+ 終了コード写像（0/1/3） | `/packages/cli/src/index.ts`, `/packages/cli/src/exit-codes.ts` + `.test.ts` | T04, T20 | D3 §1, §2.0, §5 | 未知コマンド=exit 3・`--version`/`--help`=exit 0 の写像テスト。stdout/stderr 分離 |
| T23 | `run <profile>` コマンド（プロファイル解決 + フラグ上書き → preflight.light/heavy → loop.run、`--max-iter/--autonomy/--timeout/--daily-budget/--dry-run`） | `/packages/cli/src/commands/run.ts` + `.test.ts` | T22, T19 | D3 §2.1, §6, 要件 §9 | フラグ→core 呼び出しの写像テスト（core はモック）。プリフライト即終了=exit 0・異常=exit 1。`--dry-run`=max-iter 1。L1 プロファイルへの `--autonomy L3` で警告 |
| T24 | `project init` コマンド（`.harness.yml` 雛形・`.halo/` 骨格・`.gitignore` 追記、不足分補完） | `/packages/cli/src/commands/init.ts`, `/packages/core/src/scaffold.ts` + `.test.ts` | T22, T12 | D3 §3 | 生成物が要件 §8.2 の骨格と一致・既存温存（冪等）・`--no-gitignore` のテスト。`profiles/*.env` 3 種と `prompts/code.md` 生成 |
| T25 | `stop`/`resume` コマンド（`.halo/STOP` の touch/rm、冪等） | `/packages/cli/src/commands/stop.ts`, `/packages/core/src/killswitch.ts` + `.test.ts` | T22 | D3 §2.4, §6 | STOP 生成/削除・冪等・`--reason` 記録のテスト。**T23 と並列可** |
| T26 | `status` コマンド（budget.remaining + logger.lastRun + トリガー一覧、`--json`） | `/packages/cli/src/commands/status.ts` + `.test.ts` | T22, T17 | D3 §2.5, §6 | 予算残/直近実績/`--json` 整形の写像テスト。**T25 と並列可** |
| T27 | `trigger install/uninstall/list` コマンド（discovery.resolveTrigger/resolveBin → アダプタ spawn、`fire` 絶対パス埋め込み） | `/packages/cli/src/commands/trigger.ts` + `.test.ts` | T22, T14 | D3 §2.3, §6, D1 §1.9 | アダプタ名/プロファイル検証・spawn 終了コード写像・冪等 uninstall のテスト（アダプタはモック） |
| T28 | `doctor` コマンド（§4 の 9 検査、`--json/--fix`、FAIL で exit 1） | `/packages/cli/src/commands/doctor.ts`, `/packages/core/src/doctor.ts` + `.test.ts` | T22, T15 | D3 §4, §5.2 | 各検査 OK/WARN/FAIL 集計→終了コード写像テスト。`gh`/`claude`/`git` 存在検査・トリガー生存・WSL2 配置制約。外部コマンドはモック |

**並列可**: T24〜T28 は T22 完了後、それぞれの core 依存が揃えば概ね並列。{T23, T25, T26, T27, T28}。

---

## M5. 見本プラグイン（Phase 1 最小セット）

要件 §9 と D5 §3 から Phase 1 に必要な最小セットを選定。**PR 作成・git-commit・evaluator・context・mcp は除外**。各プラグインは contract test 必須（D5 §4, D8 §3）。

| ID | タスク | 成果物（パス） | 依存 | 主参照 | 完了条件（テスト含む） |
|---|---|---|---|---|---|
| T29 | task-source-github（`op=next/complete/fail`、ready→in-progress ラベル、3 回 fail で needs-human） | `/plugins/task-source-github/{plugin.json,index.sh}` + contract test | T10 | D5 §3.1, D1 §1.1 | `gh` をモック/スタブし next/complete/fail の 3 経路。タスクなし=`{"task_id":null}`+exit 0。出力が `task-source.out.json` 適合。入力が `task-source.in.json`（oneOf）適合 |
| T29b | executor-claude（`claude -p` headless アダプタ、入力 `{prompt,workdir,budget}`→出力 `{status,summary,cost?}`、STUCK マーカー検出、`--strict-mcp-config`） | `/plugins/executor-claude/{plugin.json,run.sh or .mjs}` + contract test | T10 | D5 §2.3, D1 §1.3, §5.2 | 入力 `executor.in.json` 適合・出力 `executor.out.json` 適合（status enum）。STUCK マーカー→`status:"stuck"` 変換。claude はモックし課金ゼロで契約検証。worktree ライフサイクル自体は core（T20/D2 §8）が駆動 |
| T30 | runtime-node-pnpm（`setup.sh`/`check.sh`/`test.sh`、pnpm offline・tsc/eslint・vitest、exit 0/2） | `/plugins/runtime-node-pnpm/{plugin.json,setup.sh,check.sh,test.sh}` + contract test | T10 | D5 §3.2, D1 §1.7 | check/test が exit 0=pass・exit 2=fail を返す（フィクスチャ worktree で確認）。共通入力 `runtime.in.json` 適合。store は ext4 側前提 |
| T31 | gate-typecheck / gate-test ラッパー（`10-typecheck`/`30-test`、採用 runtime の check.sh/test.sh へ委譲する薄いラッパー） | `/plugins/gate-runtime-check/{10-typecheck,30-test}/{plugin.json,run.sh}` + contract test | T30 | D5 §2.4, D1 §1.4 | runtime へ委譲し終了コードを伝播。fail 時 `gate.out.json` 適合の reason 出力。**T30 完了後、T32 と並列可** |
| T32 | gate-loop-audit（`50-loop-audit`、自己改変禁止 7 検査、diff 1500 行超 fail。Phase 1 は kg:// 実在検証をスキップ/空許容） | `/plugins/gate-loop-audit/{plugin.json,audit.sh or .mjs}` + contract test | T10, D4 | D5 §3.3, 要件 §11.1, D4 | 保護対象（CLAUDE.md/PROMPT.md/.harness.yml/テスト）変更を fail・eslint-disable/as any/@ts-ignore 新規追加 fail・diff 1500 行超 fail のテスト。fail 時 `gate.out.json` 適合。**初日から必須の安全不変条件** |
| T33 | sink-progress-log（`20-progress-log`、minAutonomy: L1、L1 計画報告を logs/ へ構造化保存） | `/plugins/sink-progress-log/{plugin.json,log.sh}` + contract test | T10 | D5 §2.5, D1 §1.5, 要件 §9完了基準② | 入力 `sink.in.json` 適合・plugin.json に `minAutonomy:"L1"`・logs/ へ追記（採点可能な形式）。ベストエフォート |
| T34 | on-fail-record（`10-record-failure`、failure-catalog.md へインシデント追記のみ。escalate/suggest-sign は Phase 1 対象外だが escalate=needs-human は task-source 側で担保） | `/plugins/on-fail-record/{plugin.json,record.sh}` + contract test | T10 | D5 §2.6, D1 §1.6, 要件 §9 | 入力 `on-fail.in.json` 適合・failure-catalog.md へ日時/タスク/gate/理由/対処 形式で追記。ベストエフォート |
| T35 | trigger-schedule（Windows タスクスケジューラ、`install.sh`/`uninstall.sh`/`fire`、`.bin/halo run <profile>` 絶対パス） | `/plugins/trigger-schedule/{plugin.json,install.sh,uninstall.sh,fire}` + contract test | T10 | 要件 §9, §4.4, D1 §1.9 | `fire` が `halo run <profile>` を絶対パスで起動・install/uninstall の終了コード（JSON Schema 検証なし、D8 §3.2 注） |
| T36 | trigger-polling（高頻度定時起動、ready 0 件即終了と対、`install/uninstall/fire`） | `/plugins/trigger-polling/{plugin.json,install.sh,uninstall.sh,fire}` + contract test | T10 | D5 §3.4, D1 §1.9 | install/uninstall 終了コード・`fire` 絶対パス起動。**T35 と並列可**。※要件 §9 は schedule を必須、polling は初期実装として同梱 |

**並列可**: T29, T30, T32, T33, T34, T35, T36 は T10 完了後ほぼ全並列（T31 のみ T30 依存）。

---

## M6. テスト整備（D8: unit / loop 回帰 / contract / CI 雛形）

| ID | タスク | 成果物（パス） | 依存 | 主参照 | 完了条件（テスト含む） |
|---|---|---|---|---|---|
| T37 | contract test ハーネス（配布 Schema × 全見本プラグイン I/O、ajv 標準） | `/plugins/*/contract.test.ts` or `/test/contract/`, 共通ユーティリティ | T29〜T36 | D8 §3, D5 §4 | 全見本プラグインの入力例/期待出力を該当 Schema で検証。trigger は終了コードのみ。ローカルで `pnpm test:contract` が green |
| T38 | CI パイプライン雛形（unit / loop-regression / contract を PR 必須、e2e-smoke はリリース前・任意） | `/.github/workflows/ci.yml` | T21, T37, T09 | D8 §5.1, §5.2 | unit/loop-regression/contract の 3 ジョブが PR で走り課金ゼロ。Schema 乖離検出（T09）を contract ジョブに含む。カバレッジは warn |
| T39 | E2E dry-run スモークの骨子（MAX_ITER=1、実 GitHub/実 executor は手動トリガー・Phase 1 は疎通確認雛形のみ） | `/test/e2e/smoke.md` or `/test/e2e/smoke.test.ts`（skip 既定） | T38 | D8 §4, 要件 §9完了基準① | スモーク検査項目 8 点（D8 §4.2）を手順化。CI では既定 skip（課金回避）、手動で 1 周が回る雛形 |

**並列可**: T37 と（T09 が済んでいれば）CI 雛形 T38 の骨子着手は部分並列可だが、T38 の緑化は T37 完了後。

---

## サマリ（マイルストーン別タスク数）

| マイルストーン | タスク数 | ID |
|---|---|---|
| M1 monorepo scaffold | 5 | T01〜T05 |
| M2 contracts | 5 | T06〜T10 |
| M3 core 9 モジュール | 11 | T11〜T21 |
| M4 CLI 6 コマンド | 7 | T22〜T28 |
| M5 見本プラグイン | 9 | T29, T29b, T30〜T36 |
| M6 テスト整備 | 3 | T37〜T39 |
| **合計** | **40** | |

## クリティカルパス

T01 → T02/T04 → T06 → T07 → T08 → T10 → T16 → T20 → T21 → T38。
安全不変条件（T32 gate-loop-audit）は「初回の無人実行前に存在必須」（要件 §11.1）のため、M5 の中で優先度最上位。M4 の `run`（T23）と M5 の task-source/executor/gate/runtime/sink/on-fail/trigger が揃って初めて Phase 1 完了基準①の 1 サイクル無人起動が検証可能になる。

---

## 繰越（Phase 2 フォローアップ）

Phase 1 で `packages/cli` 内に暫定配置した core-ext 4 モジュールは、Phase 2 で `packages/core` へ昇格する。D3 §6 委譲マップ整合のため、CLI は「引数→委譲」のみを持つ原則（D3 §0）へ収束させる。

| 項目 | 現状（Phase 1） | Phase 2 での移設先 | 理由 |
|---|---|---|---|
| scaffold（`project init` / `doctor --fix` の骨格生成） | `packages/cli/src/core-ext/scaffold.ts` | `packages/core` | 生成物定義は CLI 非依存のドメインロジック。D3 §6 委譲マップは core を想定 |
| killswitch（STOP 配置/除去） | `packages/cli/src/core-ext/killswitch.ts` | `packages/core` | 実行制御の中核。CLI は薄い委譲に留めるべき |
| doctor（9 検査の probe 集約） | `packages/cli/src/core-ext/doctor.ts` | `packages/core` | 自己診断ロジックは core 責務。probe の OS 依存部のみ CLI に残す |
| triggers（install/uninstall/list 委譲・discovery） | `packages/cli/src/core-ext/triggers.ts` | `packages/core` | trigger discovery は core の port 解決と同型。D1 §1.9 / D3 §2.3 整合 |

> **前提**: Phase 1 では core に該当ヘルパが無いため CLI 側へ暫定配置した（各モジュール冒頭コメント参照）。移設時は既存の純粋関数/fs シーム構造を保ち、CLI 側は再エクスポート経由で後方互換を維持する。
