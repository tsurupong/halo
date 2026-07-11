# D3. CLI 仕様書（HALO CLI Specification）

| 項目 | 内容 |
|---|---|
| 文書バージョン | 1.0 |
| 前提 | HALO要件定義書 v1.8 / D1 コントラクト仕様書 / D2 コア詳細設計書 |
| 位置づけ | **公開**。`packages/cli` のコマンド定義。無人実行の入口であり、要件 §4.4（起動層・CLI 標準装備の安全装置）§8.2（グローバル状態ゼロ）の実装仕様 |
| 実装 | TypeScript（`packages/cli`、npm 配布）。導入は `npm i -D halo`、実行は `npx halo <command>` またはトリガーからの `node_modules/.bin/halo` 直叩き |
| ステータス | Phase 1 実装と並走（実装から抽出する形でよい） |

> 本書は「CLI の外形（コマンド・引数・終了コード・生成物）」を規定する。判定ロジック・ループ・プリフライトの内部アルゴリズムは D2 コア詳細設計書の管轄であり、本書は **CLI が core のどの関数に委譲するか**（§6）のみを規定する。数値パラメータ（`--max-iter` 既定値等）は要件 §11.2 に従い「初期値」として扱う。

---

## 0. 設計原則：「CLI はロジックを持たない」

CLI は **引数のパース・環境の解決・core 関数の呼び出し・終了コードへの写像**のみを担う薄い層である。プリフライト判定・ループ制御・予算計算・トリガー登録の実処理はすべて `packages/core`（および trigger アダプタ）に存在し、CLI はそれらを呼ぶだけとする。

この原則により以下が保証される。

1. **テスト容易性**: core が純粋関数群（要件 D2 の 9 モジュール）であるため、CLI を介さず単体テストできる。CLI 自体のテストは「引数 → core 呼び出しの写像」に限定される。
2. **再利用性**: 同じ core 関数を CLI・トリガー・将来のプログラム的埋め込みから共通に呼べる。
3. **単一の真実源**: 「何をするか」は core に一元化され、CLI の分岐で挙動が二重定義されない。

> 具体的な委譲先は §6「core 関数への委譲マップ」に一覧化する。

---

## 1. 6 コマンド体系

`halo <command> [subcommand] [args] [flags]` の形をとる。第一階層は 6 コマンド、`project` と `trigger` はサブコマンドを持つ。

| # | コマンド | サブコマンド | 役割 | 主な委譲先（§6） |
|---|---|---|---|---|
| 1 | `run <profile>` | — | プロファイルを指定して 1 回の起動（プリフライト → ループ）を実行する。トリガーが叩く実処理 | `core.preflight` / `core.loop` |
| 2 | `project init` | — | 対象リポジトリを HALO 管理下にする（`.harness.yml` 雛形・`.halo/` 骨格・`.gitignore` 追記の生成） | `core.scaffold` |
| 3 | `trigger` | `install` / `uninstall` / `list` | トリガーアダプタの登録・解除・一覧。実処理は `trigger.d/<name>/{install,uninstall}.sh` へ委譲 | `core.discovery` + trigger アダプタ |
| 4 | `stop` / `resume` | — | キルスイッチ（`.halo/STOP`）の配置・除去。無人実行を端末に入らず停止/再開する | `core.killswitch` |
| 5 | `status` | — | 現在の稼働状態・日次予算残・直近ループ実績・トリガー登録状況を表示 | `core.budget` / `core.logger` |
| 6 | `doctor` | — | 環境健全性の自己診断（トリガー生存・外部コマンド存在・権限） | `core.doctor` |

> `stop` / `resume` は要件 §4.4 の安全装置「キルスイッチ」を CLI から操作する糖衣であり、内部的には 1 コマンドの表裏（STOP ファイルの touch / rm）である。設計書一覧 D3 の「stop|resume」表記に対応する。

---

## 2. 各コマンドの引数・フラグ

### 2.0 グローバルフラグ（全コマンド共通）

| フラグ | 型 | 既定 | 説明 |
|---|---|---|---|
| `--cwd <path>` | path | カレント | 対象リポジトリのルート。上向き探索（`.harness.yml`）の起点 |
| `--json` | bool | false | 出力を機械可読な JSON にする（`status` / `doctor` / `trigger list` で有効） |
| `--quiet` / `-q` | bool | false | 進捗・警告（stderr）を抑制。エラーは抑制しない |
| `--verbose` / `-v` | bool | false | 診断出力を stderr に増やす |
| `--version` | bool | — | CLI（= core / contracts）のバージョンを表示して exit 0 |
| `--help` / `-h` | bool | — | 当該コマンドのヘルプを表示して exit 0 |

> stdout はコマンドの主要出力（`--json` 時は JSON）専用とし、進捗・警告は stderr に出す（D1 §3.2/§3.3 の「stdout は構造化出力専用」原則を CLI にも適用）。

### 2.1 `run <profile>` の引数・上書き規則

`run` は `.halo/profiles/<profile>.env` を読み込み、環境変数として束ねられた実行設定（`AUTONOMY` / `MAX_ITER` / `TIMEOUT` / `DAILY_MAX_ITERATIONS` / `TASK_FILTER` / `KIND_FILTER` 等）を core に渡す。CLI フラグはこのプロファイル値を**一時的に上書き**できる。

| 引数/フラグ | 型 | 既定 | 説明 |
|---|---|---|---|
| `<profile>`（位置引数） | string | 必須 | `.halo/profiles/` 配下のプロファイル名（拡張子なし）。存在しなければ設定エラー（exit 3） |
| `--max-iter <n>` | integer | プロファイルの `MAX_ITER` | 1 回の起動で回す最大イテレーション数を上書き |
| `--autonomy <L1\|L2\|L3>` | enum | プロファイルの `AUTONOMY` | 自律度を上書き（sink フィルタに反映、D1 §1.5） |
| `--timeout <duration>` | duration | プロファイルの `TIMEOUT` | 1 回の起動の実行時間上限を上書き（例: `3h` / `90m`） |
| `--daily-budget <n>` | integer | プロファイルの `DAILY_MAX_ITERATIONS` | 日次イテレーション予算を上書き |
| `--dry-run` | bool | false | `--max-iter 1` 相当の検証実行。起動経路の疎通確認用（要件 §9 Phase 1 の dry-run）。sink は自律度に従うが、初回起動テストでは併せて低自律度を指定する運用 |
| `--profiles-dir <path>` | path | `.halo/profiles` | プロファイル探索ディレクトリの上書き（テスト用） |

#### 上書き規則（優先順位）

値は以下の優先順で解決される（上が強い）。CLI は解決した最終値を core に渡すだけで、優先順位の適用そのものも `core.config.resolve` に委譲する（§6）。

```
1. CLI フラグ（--max-iter 等）          ← 最優先（その 1 回の起動限り）
2. プロファイル env（<profile>.env）     ← 常用値
3. core 既定値（初期値、要件 §11.2）     ← フォールバック
```

- **上書きは非永続**: フラグによる上書きはその起動プロセス限りで、`<profile>.env` ファイルは書き換えない（グローバル状態ゼロ・要件 §8.2 の不変条件）。
- **安全側の下限は上書き不可**: STOP 確認・flock・自己改変防止（loop-audit）は安全不変条件（要件 §11.1）であり、フラグで無効化できない。`--max-iter` を大きくしても日次予算（`--daily-budget`）と TIMEOUT は独立に効く。
- **`--autonomy` の昇格制限**: プロファイルより高い自律度への引き上げは可能だが、Phase 1 は `AUTONOMY=L1` 固定（要件 §9）であり、L1 プロファイルに対する `--autonomy L3` は警告を出す（運用上の事故防止。ブロックはしない）。

### 2.2 `project init` の引数

| フラグ | 型 | 既定 | 説明 |
|---|---|---|---|
| `--kind <name>` | string（反復可） | `code` | 初期 `.harness.yml` に含める kind。例: `--kind code --kind docs` |
| `--runtime <name>` | string | `node-pnpm` | 既定 kind に割り当てる runtime（`.harness.yml` の `runtimes`） |
| `--force` | bool | false | 既存の `.harness.yml` / `.halo/` があっても雛形を再生成（既存ファイルは上書きせず不足分のみ補完。§3 参照） |
| `--no-gitignore` | bool | false | `.gitignore` への追記を行わない |

### 2.3 `trigger <install\|uninstall\|list>` の引数

| サブコマンド | 引数/フラグ | 説明 |
|---|---|---|
| `install <name> <profile>` | `<name>`: `trigger.d` 配下のアダプタ名（`schedule` / `polling` 等）、`<profile>`: 起動プロファイル名 | 当該アダプタの `install.sh <profile>` を呼び OS スケジューラへ登録。冪等（同名は削除→再登録） |
| `uninstall <name> [<profile>]` | 同上。`<profile>` 省略時は当該アダプタの全登録を解除 | `uninstall.sh` を呼ぶ。登録が無くても exit 0（冪等） |
| `list` | `--json` で機械可読出力 | 登録済みトリガーを一覧（アダプタ名 / プロファイル / 登録タスク名 / `fire` の絶対パス / 生存状態） |

- `install` は `fire` に **`node_modules/.bin/halo` の絶対パス**を埋め込む（無人実行で npx を経由しない・バージョン固定、要件 §4.4）。CLI はこの絶対パス解決を `core.discovery.resolveBin` に委譲する。
- `list` の「生存状態」は doctor のトリガー生存検査（§4）と同じ判定（登録された `fire` の絶対パスが現在の `.bin/halo` と一致するか）を用いる。

### 2.4 `stop` / `resume` の引数

| コマンド | フラグ | 説明 |
|---|---|---|
| `stop` | `--reason <text>`（任意） | `.halo/STOP` を作成（内容に理由と日時を記録）。既に存在すれば理由を更新し exit 0（冪等） |
| `resume` | — | `.halo/STOP` を削除。存在しなければ何もせず exit 0（冪等） |

- STOP は各イテレーション冒頭と起動時にコアが確認する（D1 §5.2、要件 §4.4）。`stop` は端末に入らない停止手段であり、Windows エクスプローラーからのファイル配置と等価（CLI はその糖衣）。
- 実行中ループへの即時反映は「次のイテレーション冒頭」で起きる。実行中プロセスの強制終了は行わない（安全な停止点での終了）。

### 2.5 `status` の引数

| フラグ | 説明 |
|---|---|
| `--json` | 状態を JSON で出力（監視スクリプト用） |
| `--profile <name>` | 特定プロファイルの予算・実績に絞る |

出力項目（人間可読モード）: STOP 有無、flock 保持状態（実行中か）、当日イテレーション実績 / 日次予算 / 残、直近ループの終了理由（正常終了 / 上限 / 予算 / TIMEOUT / STOP）、登録トリガー一覧の要約。予算残は `core.budget.remaining`（logs/ 当日実績からの都度計測）に委譲する。

### 2.6 `doctor` の引数

| フラグ | 説明 |
|---|---|
| `--json` | 検査結果を JSON で出力 |
| `--fix` | 自動修復可能な項目（`.halo/` 骨格の欠損補完等）のみ修復を試みる。トリガー再登録は行わない（明示操作に限定） |

---

## 3. `project init` の生成物

`project init` は要件 §8.2「利用時のプロジェクト構成」を初期化する。既存ファイルは**上書きせず不足分のみ補完**する（`--force` でも既存内容は温存し、欠損した骨格のみ生成）。

### 3.1 `.harness.yml` 雛形（プロジェクトルート・コミット対象）

D1 §1.8 の Schema に準拠する。`--kind` / `--runtime` に応じて生成する。

```yaml
# .harness.yml — HALO 管理宣言（コミット対象）。kind ごとに runtime とプロンプトを割り当てる
kinds:
  code:
    runtimes: [node-pnpm]
    prompt: .halo/prompts/code.md
  docs:                      # --kind docs 指定時のみ
    runtimes: [docs-md]
    prompt: .halo/prompts/docs.md
```

### 3.2 `.halo/` 骨格（gitignore 対象・ローカル永続状態）

要件 §8.2 の `.halo/` 構成を空の骨格として生成する。

```
.halo/
├── ports/
│   ├── task-source.d/  context.d/  executor.d/  gate.d/
│   ├── runtime.d/  sink.d/  on-fail.d/  trigger.d/  mcp.d/   # 各 .d は空（有効化リンクを置く場所）
├── profiles/
│   ├── continuous.env      # 頻度×自律度×予算の雛形（要件 §4.4 / D2）
│   ├── daytime-l1.env
│   └── nightly.env
├── prompts/
│   ├── code.md             # kind 別プロンプトテンプレート雛形
│   └── docs.md             # --kind docs 指定時
├── env-templates/          # worktree へ注入する git 管理外ファイル雛形（空）
├── logs/                   # .gitkeep のみ
└── (graphs/ は Phase 4 で非公開プラグインが生成。init は空ディレクトリのみ用意)
```

- `profiles/*.env` は要件 §4.4 の 3 プロファイル（continuous / daytime-l1 / nightly）の初期値入り雛形を出力する（具体値は運用チューニング対象・要件 §11.2）。
- `STOP` / `mcp.json` は実行時に生成される揮発/派生物のため init では作らない。
- `prompts/` テンプレートは `.harness.yml` の `prompt` パスと整合させる。

### 3.3 `.gitignore` 追記

`.halo/` をコミットしないため、以下を追記する（既に存在すれば追記しない・冪等）。

```gitignore
# HALO ローカル状態（永続状態はすべて .halo/ 配下・要件 §8.2）
.halo/
```

- `--no-gitignore` 指定時は追記をスキップする（ユーザーが独自管理する場合）。
- `.gitignore` が存在しなければ新規作成する。

### 3.4 生成しないもの（明示）

`node_modules/.bin/halo`（`npm i` の成果物）、`.claude/settings.json`（D4 セキュリティ設計書の管轄）、グラフ実体（Phase 4）は `project init` の生成対象外である。init は「HALO が読むローカル骨格と宣言」のみを用意する。

---

## 4. `doctor` の検査項目

`doctor` は無人実行前・トラブルシュート時の自己診断であり、各項目を **OK / WARN / FAIL** で報告する。判定ロジックは `core.doctor` に委譲し、CLI は結果を終了コードへ写像する（§5.2）。

| # | 検査項目 | 判定内容 | 不通過時 |
|---|---|---|---|
| 1 | **トリガー生存（パス移動検出）** | OS スケジューラに登録された `fire` の絶対パスが、現在の `node_modules/.bin/halo` と一致するか。リポジトリ移動・再インストールで `.bin` の実体パスが変わると登録が空振りする | FAIL: `trigger install` での再登録を促す |
| 2 | **`.halo/` 骨格の整合** | 要件 §8.2 の必須ディレクトリ（`ports/*.d`・`profiles`・`logs` 等）と `.harness.yml` の存在 | FAIL（`--fix` で欠損補完） |
| 3 | **`.harness.yml` の妥当性** | D1 §1.8 Schema 準拠、`runtimes` が `runtime.d` に実在するか | FAIL |
| 4 | **`gh` の存在・認証・権限** | `gh` バイナリ存在 + `gh auth status` + PR 作成/ラベル操作に足る fine-grained PAT か（要件 §6.1、`repo` フルスコープは WARN） | FAIL（未認証）/ WARN（過剰権限） |
| 5 | **`claude` の存在・実行可否** | executor アダプタが叩く `claude` バイナリの存在と `--version` 応答 | FAIL |
| 6 | **`git` の存在・作業ツリー** | `git` バイナリ存在、対象がリポジトリか、`user.name`/`user.email` 設定 | FAIL |
| 7 | **flock / STOP 残留** | `$TMPDIR/halo.lock` の残留（クラッシュ後の孤児ロック）、意図しない `.halo/STOP` の残存 | WARN |
| 8 | **配置制約（WSL2）** | `.halo/` と worktree 先（`$TMPDIR`）が ext4 側（`/mnt/c/` 配下でない）か（D1 §1.7 の配置制約） | WARN |
| 9 | **ディスク残量** | worktree 展開に足る空き容量（重量プリフライトの事前確認） | WARN |

- 検査 4/5/6 は「存在・権限・応答」を分けて報告する（例: バイナリはあるが未認証 = FAIL、認証済みだが権限過剰 = WARN）。
- `doctor` は外部 API のクレジット probe は行わない（課金・レート消費を避けるため、重量プリフライトの責務に留める）。

---

## 5. 終了コードとエラーメッセージ規約

### 5.1 終了コード

CLI の終了コードは「実行の可否と失敗の種類」を表す。**プラグインの終了コード規約（D1 §3.1: 0=pass / 2=fail）とは別レイヤ**であり、CLI は core の実行結果を以下へ写像する。

| 終了コード | 意味 | 該当例 |
|---|---|---|
| `0` | 正常終了 | ループ正常完了、`--help`/`--version`、`stop`/`resume` 成功、doctor 全 OK、プリフライトによる正当な即終了（STOP 検出・flock 多重起動回避・ready 0 件・予算超過は「正常な非実行」として exit 0） |
| `1` | 実行時エラー | ループ内の回復不能エラー、重量プリフライト不通過（git 汚染・ディスク不足・クレジット枯渇）、trigger install の登録失敗、doctor に FAIL 項目あり |
| `2` | 予約（プラグイン fail 相当） | CLI 自体では通常返さない。D1 のプラグイン fail 規約との衝突回避のため CLI の異常には用いない |
| `3` | 設定・使用法エラー | 不正な引数、未知のプロファイル/トリガー名、`.harness.yml` 不在・不正、未知のコマンド |

> **設計判断**: ポーリング運用では「大半の発火が ready 0 件で即終了」する（要件 §4.4）。これらを異常としないため、**プリフライトによる即終了は exit 0** とする。真の異常（重量プリフライト不通過・ループ内エラー）のみ exit 1 とし、監視側は非 0 のみをアラート対象にできる。

### 5.2 doctor の終了コード

| 状態 | 終了コード |
|---|---|
| 全項目 OK（WARN 含まず） | 0 |
| WARN あり・FAIL なし | 0（監視は `--json` の `warn` 件数で判断） |
| FAIL あり | 1 |

### 5.3 エラーメッセージ規約

要件のコーディング規約（error handling / 入力検証）に従い、以下を満たす。

1. **stderr 出力**: エラー・警告は stderr、主要出力は stdout（`--json` 時も stdout に構造化結果、エラーは stderr）。
2. **1 行サマリ + 対処**: 先頭行に「何が失敗したか」、続く行に「どうすればよいか」を示す。例:
   ```
   error: profile 'continous' not found in .halo/profiles/
   hint: did you mean 'continuous'? run `halo status` to list available profiles.
   ```
3. **機密を漏らさない**: トークン値・絶対パス中の資格情報等を出力しない（要件 §6.1）。`gh` の認証エラーはステータスのみ報告し PAT 値は伏せる。
4. **`--json` 時のエラー形状**: 例外時も可能な限り `{"ok": false, "code": <exit>, "error": "<message>", "hint": "<...>"}` を stdout に出し、監視の機械処理を可能にする。
5. **使用法エラー（exit 3）**: 該当コマンドの短い usage を併記する。

---

## 6. 「CLI はロジックを持たない」原則：core 関数への委譲マップ

各コマンドが呼ぶ core（D2 の 9 モジュール）関数の対応。CLI 側は「引数解決 → 下表の関数呼び出し → 結果を終了コード/出力へ写像」のみを行う。

| コマンド | 主な委譲先（core モジュール.関数） | CLI 側の責務（ロジック非該当） |
|---|---|---|
| `run <profile>` | `config.resolveProfile` + フラグマージ → `preflight.light` → `preflight.heavy` → `loop.run` | プロファイル名とフラグのパース、STOP/予算による exit 0 と異常の exit 1 への写像 |
| `project init` | `scaffold.harnessYml` / `scaffold.haloSkeleton` / `scaffold.gitignore` | `--kind`/`--runtime`/`--force`/`--no-gitignore` の解釈、生成結果の要約表示 |
| `trigger install` | `discovery.resolveTrigger` + `discovery.resolveBin` → アダプタ `install.sh` の spawn | アダプタ名/プロファイル名の検証、spawn 終了コードの写像 |
| `trigger uninstall` | `discovery.resolveTrigger` → アダプタ `uninstall.sh` の spawn | 同上（冪等・未登録でも exit 0） |
| `trigger list` | `discovery.listTriggers` + `doctor.checkTriggerLiveness` | 一覧の整形（人間可読 / `--json`） |
| `stop` / `resume` | `killswitch.set` / `killswitch.clear` | `--reason` の受け渡し、冪等な exit 0 |
| `status` | `budget.remaining` + `logger.lastRun` + `discovery.listTriggers` | 表示整形、`--json` シリアライズ |
| `doctor` | `doctor.runAll`（§4 の各検査）+ `--fix` 時 `scaffold.repair` | 検査結果の OK/WARN/FAIL 集計 → 終了コード写像 |

- CLI は上記関数の**戻り値（構造化結果）**を受け取り、判定はしない。例えば「予算超過か」は `budget.remaining <= 0` を core が返し、CLI はそれを exit 0（正常な非実行）へ写像するだけである。
- トリガーアダプタの実処理（`schedule`/`polling` の `install.sh` 等）は bash であり、CLI はその spawn と終了コード回収のみを担う（D1 §1.9）。
- この委譲マップは D8 テスト戦略書の「CLI テスト = 写像テスト、ロジックテスト = core 単体テスト」の分界点でもある。

---

## 付録 A. コマンド早見表

| コマンド | 用途 | 代表フラグ | 主な終了コード |
|---|---|---|---|
| `halo run <profile>` | 1 回の起動（トリガーが叩く実処理） | `--max-iter` `--autonomy` `--timeout` `--daily-budget` `--dry-run` | 0（正常/即終了）/ 1（異常）/ 3（設定） |
| `halo project init` | リポジトリを HALO 管理下に | `--kind` `--runtime` `--force` `--no-gitignore` | 0 / 3 |
| `halo trigger install <name> <profile>` | トリガー登録 | — | 0 / 1 / 3 |
| `halo trigger uninstall <name> [<profile>]` | トリガー解除（冪等） | — | 0 / 3 |
| `halo trigger list` | 登録一覧 | `--json` | 0 |
| `halo stop` / `halo resume` | キルスイッチ配置/除去 | `--reason` | 0 |
| `halo status` | 稼働状態・予算・実績 | `--json` `--profile` | 0 |
| `halo doctor` | 環境自己診断 | `--json` `--fix` | 0（OK/WARN）/ 1（FAIL） |

## 付録 B. 用語

| 用語 | 定義 |
|---|---|
| プロファイル | `.halo/profiles/<name>.env`。頻度 × 自律度 × 予算を束ねた環境変数群（要件 §4.4） |
| キルスイッチ | `.halo/STOP` ファイル。存在で起動時/各イテレーション冒頭に即終了（要件 §4.4、D1 §5.2） |
| トリガー生存 | 登録された `fire` の絶対パスが現在の `.bin/halo` と一致すること（パス移動で空振りしない状態） |
| 上書き規則 | CLI フラグ > プロファイル env > core 既定値 の優先順位（§2.1、非永続） |
| 委譲マップ | 各コマンドが呼ぶ core 関数の対応表（§6）。CLI はロジックを持たない原則の実体 |
</content>
</invoke>
