# 設計書: sh ランチャー全廃 — `entry` 実行契約への一本化

日付: 2026-07-16
状態: ユーザー承認済み(案A採用)
対象バージョン: v0.3.0(破壊的変更)

## 1. 目的と背景

v0.2.0(ADR-0017 / D11)で全同梱プラグインの実装ロジックは TypeScript 化したが、起動口として薄い POSIX sh ランチャー(`exec node dist/... "$@"`)を残した。これにより以下の環境依存が残存している:

- exec-bit / shebang 依存: NTFS で exec-bit が落ちる問題への回避コード(`packages/core/src/discovery.ts:317-343` の shebang 検出と `['sh', path]` フォールバック)、`halo enable` の chmod(`packages/cli/src/commands/enable.ts:93`)
- `sh` バイナリ自体への依存(Windows ネイティブ実行不可)
- ランチャー .sh ファイル 28 個(`plugins/*` 16 + `.halo/ports/*` 12)の管理コスト

本設計では **リポジトリ内の .sh ファイルを完全ゼロ** にし、実行契約を「core が自プロセスの Node で JS エントリを直接 spawn する」方式へ一本化する。

## 2. スコープ

### 対象(すべて実施)

1. plugin.json 実行契約の変更: `exec` 廃止 → `entry` 導入(破壊的変更、旧契約サポートなし)
2. ランチャー .sh 全 28 個の削除
3. `halo enable` の sh 生成廃止
4. discovery の shebang / exec-bit フォールバック削除
5. スケジューラ登録コマンドの node 直接化
6. `.halo/ports/task-source.d/task-source-local/run.sh`(62行 bash)の TS プラグイン化
7. `scripts/e2e-dry-run.sh`(130行)の Node スクリプト化
8. `packages/core/test/mocks/*.sh` の Node モック化
9. ADR-0018 の起草(ADR-0017 のランチャー節を supersede)、D11 の該当節更新

### 対象外

- in-process import 化(案C): プロセス分離・watchdog(ADR-0013)・contract fixtures の stdio 契約は現状維持
- 非 Node ランタイムのプラグイン対応(execArgv 拡張): 需要が出た時点で別 ADR
- CI ワークフロー構成の変更(sh ステップの削除が波及する範囲のみ修正)

## 3. 新しい実行契約

### 3.1 plugin.json

```json
{
  "name": "@halo/plugin-trigger-polling",
  "version": "1.0.0",
  "port": "trigger",
  "entry": "./dist/trigger-polling/fire.js"
}
```

- `entry`: plugin.json からの相対パス、または絶対パスで JS モジュール(実行スクリプト)を指す。
- `exec` フィールドは削除。`exec` を持つ plugin.json は discovery でエラー(明示的な移行メッセージ付き)。
- `timeoutSec` 等の他フィールドは変更なし。
- 複数エントリを持つプラグイン(例: trigger-polling の install/uninstall/fire、runtime-node-pnpm の check/setup/test)は、従来どおりポート種別ごとの規約ファイル名で解決している箇所を `entries` マップに正規化する:

```json
{ "port": "trigger", "entries": { "install": "./dist/.../install.js", "uninstall": "./dist/.../uninstall.js", "fire": "./dist/.../fire.js" } }
```

単一エントリのポートは `entry`(文字列)のみ。`entry` と `entries` は排他。

### 3.2 core の起動方式(runPort)

`packages/core/src/runPort.ts` の spawn を次の形へ変更:

```
spawn(process.execPath, [entryAbsPath, ...args], { shell: false, env: {...process.env, HALO_PLUGIN_DIR} })
```

- `process.execPath` を使うため PATH 解決・node バージョン不一致が発生しない(cron/systemd 起動時の PATH 欠落問題の根絶)。
- exec-bit・shebang・chmod への依存が消える。Windows ネイティブでもそのまま動く。
- stdio 契約(stdin/stdout JSON、exit code)、timeout、watchdog、contract fixtures は不変。

### 3.3 環境変数

- `HALO_LAUNCHER_DIR` を廃止し、core が `HALO_PLUGIN_DIR`(plugin.json のあるディレクトリの絶対パス)を注入する。
- 参照箇所の移行(3 プラグイン):
  - `packages/plugins/src/gate-runtime-check/delegate.ts:20` — runtime スクリプト解決。runtime も TS 化されるため `HALO_PLUGIN_DIR` 起点の .js 解決 + `spawnSync(process.execPath, [scriptPath])` に変更(`spawnSync('sh', ...)` を廃止)。
  - `packages/plugins/src/trigger-polling/install.ts:8` / `trigger-schedule/install.ts:8` — スケジューラへ登録する fire コマンドを「`process.execPath` の絶対パス + fire.js の絶対パス」の組で登録する形に変更。

### 3.4 `halo enable`(packages/cli/src/commands/enable.ts)

- sh ランチャー生成(`launcherScript()`、行 34-40)と chmod(行 93)を削除。
- 新動作: 対象ディレクトリ(例: `.halo/ports/<port>.d/<name>/`)に、`entry`/`entries` を **インストール先から解決可能な絶対パス** に書き換えた plugin.json のみを生成する。
- registry(`packages/plugins/src/registry.ts`)の各エントリ定義を `exec: "./run.sh"` 形式から `entry`/`entries` の dist パス形式へ更新。

### 3.5 discovery(packages/core/src/discovery.ts)

- `isShellShebang()`(行 317-321)、`resolveExecArgv()` の sh フォールバック(行 331-343)を削除。
- `isExecutable()` probe は entry 方式では不要になるため、`entry` の存在確認(ファイル実在チェック)に置換。
- `exec` フィールド検出時は「v0.3.0 で entry 契約に移行しました」というエラーで fail-fast。

## 4. 付随する TS 化・Node 化

### 4.1 task-source-local(新規同梱プラグイン)

- 現状: `.halo/ports/task-source.d/task-source-local/run.sh`(62行 bash、selfhost 専用)。
- 移行: `packages/plugins/src/task-source-local/` に TS 実装(op=next/complete/fail、md キュー queue→done 移動)+ Vitest テスト + `contract.fixtures.json` を新設し、正規の同梱プラグイン(`plugins/task-source-local/`)に昇格する。
- selfhost 環境(`.halo/ports/`)は `halo enable task-source-local` で再生成。旧 run.sh は日付付きアーカイブ(`.halo/ports-archive-2026-07-16/` 方式)へ退避。

### 4.2 e2e-dry-run

- `scripts/e2e-dry-run.sh` → `scripts/e2e-dry-run.mjs`(Node >= 22 前提、依存なしの素の ESM)。挙動は同等(モック環境でのドライラン)。

### 4.3 core テストモック

- `packages/core/test/mocks/*.sh` → 同等の `.mjs` モックへ置換。テスト側の spawn も新契約(node + entry)で呼ぶよう更新。これにより新契約自体がテストで常時検証される。

## 5. エラーハンドリング

- `entry` が指すファイルが存在しない → discovery 時点で fail(プラグイン名・パスを含むエラー)。
- 旧 `exec` フィールド検出 → 移行手順を示すエラーメッセージで fail-fast(黙って無視しない)。
- スケジューラに登録済みの旧 sh パス → `halo enable` 再実行時に再登録で上書き。doctor に「登録コマンドが .sh を指している」旧設定検出チェックを追加する(WARN 扱い)。

## 6. テスト戦略

- 既存 480 テストを新契約で green に(ランチャー関連テストは削除、entry 契約テストに置換)。
- contract fixtures はプラグイン挙動の契約なので原則不変。起動方式の変更は runPort / discovery / enable の単体テストでカバー。
- task-source-local は新規 Vitest テスト + fixtures を追加。
- 最終確認: `find product -name '*.sh'` が 0 件、`grep -r 'HALO_LAUNCHER_DIR\|\.sh' packages` が想定外 0 件、selfhost ループ(halo run)の実動作確認。

## 7. ドキュメント

- ADR-0018「sh ランチャー廃止と entry 実行契約」新規作成(ADR-0017 の launcher 節を supersede)。
- D11 §3(launcher 生成)を entry 方式に改訂。
- CLAUDE.md の構造説明(「薄いPOSIX shランチャー」記述)を更新。

## 8. リリース

- バージョン: 4 パッケージとも v0.3.0(破壊的変更)。
- npm publish・git push は従来どおりユーザー承認/ユーザー実行。
