# D2. コア詳細設計書（HALO Core Design）

| 項目 | 内容 |
|---|---|
| 文書バージョン | 1.0 |
| 前提 | HALO要件定義書 v1.8 / D1 コントラクト仕様書 |
| 位置づけ | `packages/core` の実装仕様（公開 docs/architecture） |
| 公開/私有 | 公開（OSS） |
| ステータス | Phase 1 実装と並走（実装から抽出する形でよい） |

> 本書は要件定義書 §3（全体アーキテクチャ）・§4.3（コアループ）・§4.4（起動層）・§8（ディレクトリ構成）・§11（設計判断の分類）と、D1 コントラクト仕様書（プロセス境界の I/O 型・実行規約）を前提に、`packages/core` の内部設計を実装可能な粒度へ落とす。D1 が「プロセス境界のコントラクト（stdin JSON / stdout JSON / 終了コード）」を規定するのに対し、本書は **コア内部（TypeScript）のモジュール構造とアルゴリズム**を規定する。両者が矛盾する場合は D1 と要件定義書が優先する。
>
> **v1.5 → v1.8 の再構成**: v1.5 期の素材（設計書 01 / 02）はコアを bash（`core/loop.sh` + `core/helpers.sh`）で記述していた。v1.8 ではコアを **TypeScript（npm 配布・`npx halo` / トリガーは `node_modules/.bin/halo` 絶対パス直叩き）** で実装する。本書は bash 前提（`helpers.sh` の関数群・`source`・`jq` マージ等）を除去し、TypeScript モジュールの責務として再構成する。プラグインの実装言語は引き続き任意であり（D1 §0）、コアはプロセス境界越しにのみプラグインと通信する。
>
> **初期値の扱い**: 数値パラメータ（retry 上限 3 / max-turns 40 / timeout 900 秒 / MAX_ITER 20 / diff 1500 行等）は要件 §11.2 に従い **調整可能な初期値** として扱い、コア内にハードコードせず後述 §9 の設定経路（プロファイル・`plugin.json`・環境変数）から注入する。本書中で「初期値」と明記した値は確定値ではない。

---

## 1. モジュール分割

`packages/core` は 9 個の内部モジュールに分割する。各モジュールは高凝集・低結合とし、副作用（プロセス起動・ファイル I/O・時刻取得）を持つのは限られたモジュールに閉じる。純粋関数として書けるロジック（プロンプト組立・fragments マージ・順序ソート・予算集計）は副作用から分離し、単体テスト可能にする（テスト方針は D8）。

### 1.1 モジュール一覧と責務

| # | モジュール | 責務 | 主な副作用 | 依存先 |
|---|---|---|---|---|
| 1 | `config` | プロファイル・環境変数・`.harness.yml`・`plugin.json` の読み込みと正規化。実行時設定（AUTONOMY / MAX_ITER / 予算上限 / タスクフィルタ / 各種初期値）を単一の設定オブジェクトへ確定する | ファイル読取 | logger |
| 2 | `discovery` | `ports/<port>.d/` 配下のプラグイン走査、`order` ソート、有効化判定、`.harness.yml` の上向き探索・解決 | ファイル走査 | config, logger |
| 3 | `runPort` | プラグイン 1 個の起動（spawn）、stdin への JSON 投入、stdout の JSON 受領、`timeoutSec` 強制、stderr のログ回送、終了コード伝播 | プロセス起動 | logger |
| 4 | `loop` | コアループの状態機械（§2）。next → context → execute → gate → sink/onFail の駆動、retry 判定、5 種の終了条件 | なし（他モジュールへ委譲） | 全モジュール |
| 5 | `preflight` | 2 段プリフライト（軽量・重量、§4）。STOP / lock / ready 有無 / 予算残 / 作業ツリー clean / グラフ鮮度同期 | ファイル読取・git | config, budget, lock, discovery |
| 6 | `budget` | 日次予算の都度計測（§5）。`logs/` の当日実績を集計し残量を判定 | ファイル読取・時刻 | config, logger |
| 7 | `autonomy` | 現在の AUTONOMY と各 sink の `minAutonomy` を突き合わせ、実行対象 sink をフィルタ（§2.5・D1 §1.5） | なし | config |
| 8 | `lock` | 多重起動防止の排他ロック（`$TMPDIR/halo.lock`）。取得・解放・残留検出 | ファイルロック | logger |
| 9 | `logger` | 構造化ログ（`logs/iter_N.json`）への書込、stderr 回送先の提供、gate 通過率の記録 | ファイル書込 | config |

> **CLI との関係**: CLI（`packages/cli`）は「ロジックを持たない」原則（D3）に従い、これらコアモジュールの公開関数を呼ぶだけの薄い委譲層である。トリガー（`fire`）は CLI を呼ぶ唯一の入口であり、コアはトリガー種別を知らない（要件 §4.4）。

### 1.2 グローバル状態ゼロの徹底

要件 §8.2 の「マシングローバル状態を持たない」を実装で担保する。コアは静的変数・シングルトンに永続状態を持たず、実行時状態は次の外部に委ねる。

| 状態 | 真実の源 | コア内での扱い |
|---|---|---|
| タスク進行（ready / in-progress / retry） | GitHub（Issue ラベル・コメント） | task-source プラグイン越しに読み書き。コアは保持しない |
| 排他 | OS の flock（`$TMPDIR/halo.lock`） | `lock` モジュールが起動時取得・終了時解放 |
| 予算 | `logs/` の当日実績（台帳を持たない） | `budget` が都度集計（§5） |
| worktree | OS tmpdir（`$TMPDIR/halo-wt-issue-N/`） | 生成→破棄で完結（§8） |
| グラフ鮮度 | main の HEAD と前回インデックス時点 | preflight 重量段で照合（§4） |

---

## 2. loop の状態機械

`loop` モジュールは要件 §4.3 の擬似コードを TypeScript の状態機械として実装する。1 イテレーション 1 タスク（フレッシュコンテキスト原則、要件 §3.2）を厳守し、イテレーション間の状態はコアのメモリではなく **ファイル / git / GitHub** に永続化する。

### 2.1 状態遷移

```
                ┌─────────────────────────────────────────────┐
                │  iteration 開始（iter = 1..MAX_ITER）        │
                └───────────────┬─────────────────────────────┘
                                ▼
                   [PreflightLight]  STOP / lock / ready有無 / 予算残
                    │ 停止条件該当 → 終了（§2.4）
                    ▼
                   [Next]  task-source op=next
                    │ task_id == null → 終了（TASK_EMPTY）
                    ▼
                   [PreflightHeavy]  作業ツリー clean / グラフ鮮度同期
                    ▼
                   [Context]  context.d 全実行 → fragments マージ
                    ▼
                   [BuildPrompt]  task + ctx + last_gate_failure
                    ▼
                   [Execute]  executor（単一・先頭のみ）
                    │ status != done（stuck/timeout）─────┐
                    ▼ status == done                       │
                   [Gate]  gate.d 全実行（論理 AND）        │
                    │ fail（いずれか exit 2）──────────────┤
                    ▼ pass（全 exit 0）                     │
                   [Sink]  autonomy フィルタ後の副作用       │
                    ▼                                       ▼
                   [Complete]  task-source op=complete    [OnFail]  on-fail 全実行
                    │  last_gate_failure = 空               │  last_gate_failure 保持
                    │                                       │  retry_count 加算
                    └───────────────┬───────────────────────┘
                                    ▼
                          次 iteration へ（フレッシュコンテキスト）
```

### 2.2 各状態の処理

| 状態 | 処理 | 委譲先 | 判定 |
|---|---|---|---|
| PreflightLight | STOP ファイル / lock / ready 有無 / 日次予算残（§4.1） | preflight, lock, budget | 停止条件該当で即終了 |
| Next | `{"op":"next"}` を task-source（先頭 1 個）へ | runPort | `task_id == null` → 終了 |
| PreflightHeavy | 作業ツリー clean / ディスク残量 / グラフ鮮度同期（§4.2） | preflight | 異常時は当該タスクを実行せず記録 |
| Context | context.d 全実行、`fragments` を priority 降順連結、トークン上限で切詰め（§2.6） | runPort（各）, discovery | 常に success 扱い（個別失敗はスキップ） |
| BuildPrompt | task 情報・連結 context・前回 gate fail の reason/hint を結合しプロンプト生成 | （純粋関数） | — |
| Execute | executor（先頭 1 個）へ prompt/workdir/budget を投入 | runPort | stdout の `status`（§2.3） |
| Gate | gate.d 全実行、1 つでも exit 2 なら全体 fail（論理 AND） | runPort（各） | 終了コード（0/2） |
| Sink | autonomy フィルタ後、合格時のみ副作用を実行（ベストエフォート） | runPort（各）, autonomy | 個別失敗は他へ波及しない |
| Complete | `{"op":"complete", task_id, pr_url}` を task-source へ | runPort | 副作用のみ |
| OnFail | on-fail 全実行（記録・エスカレーション・sign 候補） | runPort（各） | ベストエフォート |

### 2.3 executor status による分岐

executor の合否は終了コードではなく **stdout の `status`** で判定する（D1 §1.3・§3.1）。

| status | 意味 | loop の遷移 |
|---|---|---|
| `done` | 正常終了 | Gate へ進む |
| `stuck` | 論理的な行き詰まり（STUCK マーカー検出） | OnFail 経路。retry_count 加算 |
| `timeout` | `budget.timeout_sec` 超過 | OnFail 経路。retry_count 加算 |
| （プロセス異常終了） | エラー | 安全側に倒して失敗経路（OnFail）へ |

> STUCK マーカー（エージェント自己申告）から `status: "stuck"` への変換は executor アダプタの責務であり（D1 §5.2）、コアは `status` 値のみを見る。マーカーの検出詳細は Phase 1 実装から抽出する（D1 §5.2 保留）。

### 2.4 gate fail の再注入（retry 判定）

gate fail は 2 経路で次イテレーションへ再注入される（学習経路の中核、要件 §3.2）。

1. **直近 reason の即時再注入**: 最初に fail した gate の出力（`reason` / `hint` / `gate`）を loop が保持し、同一タスクの次イテレーションで BuildPrompt の入力（「前回の失敗」節）として渡す。retry_count に応じた注入戦略の変更（「前回と別方針で」等）は context.d プラグイン側の拡張余地とする（要件 §11.2、コアは reason を渡すだけ）。
2. **失敗カタログ経由の中期再注入**: on-fail `10-record-failure` が `failure-catalog.md` へ追記し、context.d（`30-recent-failures`）が後続イテレーションで読み取る。

**retry_count の判定**: retry_count の管理（インクリメント・閾値到達判定・`needs-human` 付与）は task-source / on-fail プラグインの責務であり、真実の源は GitHub（Issue コメント・ラベル）である。コアは on-fail 入力に `retry_count` を渡すのみで、閾値（**初期値 3**、要件 §11.2）自体を持たない。閾値到達時は on-fail `20-escalate` が `needs-human` を付与し、次の `op=next` で当該タスクが払い出されなくなることで再注入ループが打ち切られる（無限ループ遮断）。

### 2.5 sink の autonomy フィルタ

Sink 状態では `autonomy` モジュールが各 sink の `plugin.json` の `minAutonomy`（D1 §2）と現在の AUTONOMY を突き合わせ、現在値未満の sink をスキップする。`minAutonomy` 未宣言の sink は最も安全側（L3 とみなし L1/L2 ではスキップ、D1 §2）。

| AUTONOMY | 有効な sink（初期構成） |
|---|---|
| L1 | `20-progress-log` のみ |
| L2 | `20-progress-log` / `10-git-commit` / `15-create-pr`（**draft PR**） |
| L3 | L2 の全 sink + `15-create-pr`（**通常 PR**、本文 `Closes #番号`） |

`15-create-pr` は `minAutonomy: "L2"` で有効化され、`AUTONOMY` env を読んで L2 では draft PR・L3 では通常 PR を作り分ける（単一 sink で分岐、D1 §1.5）。自律度は累積的（L3 ⊇ L2 ⊇ L1）。

> v1.5 素材はメタコメント `# min-autonomy: L3` を宣言としていたが、v1.8 では `plugin.json` の `minAutonomy` フィールドに統一する（D1 §2）。コアは `plugin.json` を読んでフィルタする。

### 2.6 context のマージ（純粋関数）

context.d 全プラグインの `fragments` を結合し、`priority` 降順に安定ソート、トークン上限（要件 §3.2 原則4、**100k 未満**を初期値）で切り詰めた単一の `{ fragments: [...] }` を生成する。**`priority` は D1 §1.2 の規定に従い「大きいほど優先」であり、降順（大きい priority が先頭）に連結する**（v1.5 素材の一部記述と逆向きのため、本書は D1 を正とする）。個別プラグインの失敗・不正 JSON はそのプラグインを空 fragments 扱いにしてスキップし、他は続行する（コンテキスト欠落は gate で検出される前提、D1 §1.2）。この結合・切詰めロジックは副作用を持たない純粋関数として実装する。

### 2.7 終了条件（5 種）

loop は次の 5 条件のいずれかで終了する。いずれも **安全側に倒す（副作用を出さない）** を原則とし、exit 0 で正常終了する。

| # | 終了条件 | 検出点 | 終了コード | 備考 |
|---|---|---|---|---|
| 1 | **STOP キルスイッチ** | 各イテレーション冒頭（PreflightLight）で `.halo/STOP` を確認 | 0 | 人間が配置するキルスイッチ（要件 §4.4）。STUCK とは別機構 |
| 2 | **日次予算超過** | PreflightLight で `budget` が残量なしと判定 | 0 | 起動しても走らせない（§5） |
| 3 | **ready タスク 0 件** | Next で task-source が `{"task_id": null}` + exit 0 | 0 | ポーリング型の「タスク存在駆動」を成立させる中核 |
| 4 | **MAX_ITER 到達** | ループカウンタが上限（**初期値 20**）に到達 | 0 | プロファイルの TIMEOUT と併せた総量制御 |
| 5 | **実行時間上限（TIMEOUT）** | イテレーション境界で経過時間がプロファイル TIMEOUT を超過 | 0 | ポーリング間隔との整合・資源占有防止（要件 §4.4） |

> **構成不備は別扱い**: 単一ポート（task-source / executor）のプラグインが 0 件、または必須構成（`.harness.yml`）欠如は「終了条件」ではなく **エラー**として扱う。前者はコア停止（サイレント続行しない）、後者は当該タスクを実行せず `needs-human`（要件 §4.2③・D1 §1.8）。

---

## 3. runPort 仕様

`runPort` はプラグイン 1 個をプロセスとして起動し、D1 の実行規約（stdin JSON / stdout JSON / 終了コード / stderr）を強制する唯一のモジュールである。ポート種別ごとの実行戦略（単一 / 全実行 / マージ / 論理 AND / ベストエフォート）は loop 側が組み立て、runPort は「1 プロセスの起動と契約強制」に責務を限定する。

### 3.1 プロセス起動（spawn）

| 項目 | 仕様 |
|---|---|
| 起動方式 | プラグインの `exec`（`plugin.json`）を子プロセスとして spawn。shell を介さず引数配列で起動する（インジェクション回避） |
| 実行言語 | 任意（bash / Python / Node）。コアは実行体を叩くだけでプラグインの言語を知らない（D1 §0） |
| 作業ディレクトリ | プラグインの配置ディレクトリ、または対象タスクの workdir（ポートに応じ loop が指定） |
| 環境変数 | `plugin.json` の `env` を注入（`${...}` 参照はコアが解決）。無人実行では PATH を Linux 側のみへ洗い直したうえで渡す（要件 §6.1、Windows パス継承問題の回避） |

### 3.2 stdin / stdout

| 方向 | 仕様 |
|---|---|
| stdin | 入力 JSON オブジェクトを 1 個、シリアライズして子プロセスの stdin へ書き込み、EOF で閉じる |
| stdout | 出力を要求するポート（task-source next / context / executor / gate fail 時）は stdout を全量バッファし 1 個の JSON としてパース。**stdout は JSON 専用チャネル**であり、パース失敗は当該ポート規約に従い処理（context: スキップ、gate: 安全側 fail 等、D1 §6.2 コア側境界検証） |
| 境界検証 | 受領した stdout を D1 配布の JSON Schema に照らして検証し、スキーマ違反はポート規約に従い扱う（D1 §6.2） |

### 3.3 timeoutSec の強制

各プラグインの実行タイムアウトは `plugin.json` の `timeoutSec`（未指定時はポート既定の初期値）で決まり、runPort が **プロセス側で強制**する。

- タイムアウト到達時、子プロセスへ終了シグナルを送り（猶予後に強制終了）、当該実行を失敗として扱う。
- executor の `budget.timeout_sec`（**初期値 900**）はプロンプト実行そのもののタイムアウトであり、executor アダプタが `{"status":"timeout"}` を返す経路（D1 §1.3）と、runPort のプロセスタイムアウトは二重の防護とする。runPort のタイムアウトはアダプタが応答しない異常時の最終防壁。

### 3.4 stderr のログ回送

stderr は診断・ログ専用でありコントラクト上の意味を持たない（D1 §3.3）。

- runPort は子プロセスの stderr を捕捉し、`logger` を通じて当該イテレーションの構造化ログ（`logs/iter_N.json`）へ退避する。
- stderr の内容で合否は判定しない（判定は終了コード / status）。プラグインは人間可読な進捗・警告を stderr へ自由に書いてよい。

### 3.5 終了コードの扱い

runPort は子プロセスの終了コードを呼び出し元（loop）へ伝播する。意味づけ（pass/fail/error）は D1 §3.1 に従い loop 側が行う。

| 終了コード | 意味 | loop での典型処理 |
|---|---|---|
| 0 | pass / 正常 | 成功として続行 |
| 2 | fail | gate: 差し戻し、runtime check/test: fail |
| その他（1 含む） | エラー（異常終了） | 安全側に倒して fail 扱い。単一ポートのプラグイン不在はコア停止 |

### 3.6 ポート種別ごとの実行戦略（loop が組み立てる）

runPort（単発）を組み合わせて loop が実現する 4 戦略。v1.5 素材の `run_port` / `run_ports_merge` / `run_ports_all` / `run_ports_each` に相当するが、v1.8 では loop モジュール内の関数として TypeScript 化する。

| 戦略 | 対象ポート | 挙動 | 判定 |
|---|---|---|---|
| 単一 | task-source / executor | `order` 先頭の 1 個のみ実行 | 戻り JSON / status を loop が解釈 |
| マージ | context | 全実行し fragments を priority 降順連結・切詰め（§2.6） | 常に success（個別失敗はスキップ） |
| 論理 AND | gate | 全実行、1 つでも exit 2 なら全体 fail。最初の fail の reason を保持し再注入 | 終了コード（0/2） |
| ベストエフォート | sink / on-fail | 全実行、個別失敗が他へ波及しない。sink は autonomy フィルタ後 | 副作用のみ |

---

## 4. プリフライト 2 段の判定順序

高頻度ポーリング起動と両立させるため、プリフライトを軽量段（毎回・数秒）と重量段（タスクが実在した時のみ）に分割する（要件 §4.4）。loop の状態機械上、軽量段は Next の前（各イテレーション冒頭）、重量段は Next で task_id を得た後に走る。

### 4.1 軽量段（毎回・数秒）

ready タスクが 0 件でも毎回走るため、コストの低い検査のみを置き、1 つでも該当したら即終了（副作用なし）する。**判定順序**は「安価かつ停止すべき度合いの高い順」とする。

| 順 | 検査 | 該当時の挙動 | 委譲先 |
|---|---|---|---|
| 1 | STOP ファイル存在（`.halo/STOP`） | 即 exit 0（キルスイッチ） | preflight |
| 2 | lock 取得（`$TMPDIR/halo.lock`、flock） | 取得失敗（多重起動）は即 exit 0 | lock |
| 3 | 日次予算残（`logs/` 当日実績、§5） | 残量なしは即 exit 0 | budget |
| 4 | ready タスク有無（task-source `op=next`） | `task_id == null` は即 exit 0 | runPort |

> 順序の根拠: STOP は人間の明示停止意図であり最優先。lock はコスト最小の多重起動遮断。予算は task-source 起動（プロセス spawn）より安価に判定できるため ready 判定より前に置く。ready 判定は task-source プロセスを起動するため最後。
>
> 実装注記: lock は起動時に一度だけ取得し保持し続ける（§1.2 の起動時取得・終了時解放）。毎イテレーションの軽量段が実際に再チェックするのは STOP と予算残の 2 つであり（`runLoop` は `isStopPresent` / `isBudgetOk` を反復呼び出しする）、lock の再取得は行わない。上表の #2 は起動時の一度きりの取得を指す。

### 4.2 重量段（タスクが実在した時のみ・1 回）

軽量段を通過し task_id を得た後にのみ走る。実タスクがあるときだけコストを払う。

| 順 | 検査 | 該当時の挙動 | 委譲先 |
|---|---|---|---|
| 1 | git 作業ツリー clean | 未コミット変更があれば当該起動を中止（記録） | preflight |
| 2 | ディスク残量 | 閾値未満は中止（worktree 生成不可） | preflight |
| 3 | クレジット probe | headless の消費レート実測（要件 §6.2）。異常時は中止 | preflight |
| 4 | グラフ鮮度同期 | main が前回インデックスから進んでいれば再インデックス→陳腐化検出→`kind:docs` 自動起票（案A、要件 §5.1・§10） | preflight（グラフは私有プラグイン管轄） |

> **mcp.json の生成タイミング**: executor に渡す `.halo/mcp.json` は `ports/mcp.d/*.json` をマージして生成する（D1 §1.10）。生成は重量段で 1 回行い（軽量段では不要）、`--strict-mcp-config` により唯一の MCP ソースとする。v1.5 素材の `jq` マージは v1.8 では config/discovery モジュールによる deep-merge（後勝ち・番号順）で実装する。

---

## 5. budget の都度計測アルゴリズム

要件 §4.4・§8.2 に従い、日次予算は **台帳を持たず実行時に都度計測** する。真実の源は `logs/` 配下の当日実績であり、コアは集計結果と上限（プロファイルで指定、初期値は据え置き）を比較して残量を判定する。

### 5.1 アルゴリズム

```
budgetRemaining(now, profile):
  today        = ローカル日付(now)                       # 日境界はローカルタイムゾーン
  logs         = logs/iter_*.json のうち mtime/記録日時が today のもの
  usedIters    = count(logs)                             # 当日のイテレーション実行数
  usedCost     = sum(logs[].cost.usd)                    # 記録があれば加算（可観測性用・任意）
  limitIters   = profile.DAILY_MAX_ITERATIONS            # 初期値（プロファイル定義）
  limitCost    = profile.DAILY_MAX_COST_USD              # 初期値（任意・未設定可）
  ok = usedIters < limitIters AND (limitCost 未設定 OR usedCost < limitCost)
  return ok
```

### 5.2 設計上の注意

| 項目 | 方針 |
|---|---|
| 集計対象 | `logs/iter_N.json`（要件 §6.3 の構造化ログ）。1 ファイル = 1 イテレーションを基本単位とする |
| 日境界 | ローカルタイムゾーンの暦日。夜間バッチが日付をまたぐ場合の扱いは初期値として「実行時刻の暦日」とし、実測後に調整可能 |
| コスト計測 | executor 出力の `cost.usd`（ccusage 相当、任意）を加算。未記録の場合はイテレーション数のみで判定（コスト上限は補助的） |
| 二重防護 | 予算は「起動しても即終了」の総量制御であり、`--max-turns` / iteration timeout / MAX_ITER（要件 §6.2）と組み合わせて暴走を多層で防ぐ |
| グローバル状態ゼロ | 台帳（累積カウンタファイル等）を持たないことで、複数プロジェクト・撤去容易性（`.halo/` 削除で完結）を担保する |

> `DAILY_MAX_ITERATIONS` / `DAILY_MAX_COST_USD` は要件 §11.2 の思想に沿う **調整可能な初期値** であり、プロファイル（§9）で与える。コアに固定値を埋め込まない。

---

## 6. discovery の走査・ソート・有効化判定

`discovery` モジュールは `ports/<port>.d/` を走査し、有効なプラグインを `order` 昇順に列挙する。要件 §3.2 の「ディレクトリ規約による活性化（conf.d 方式）」を実装する。

### 6.1 走査対象

プラグインは要件 §8.2 の `.halo/ports/<port>.d/` 配下に置かれる（公開見本は `node_modules/@halo/plugin-*`、私有は `.halo/ports/` に配置・有効化リンク）。discovery は各ポートディレクトリを走査し、`plugin.json` を持つエントリを候補とする。

| ポート | 単位 | エントリ |
|---|---|---|
| task-source / context / executor / gate / sink / on-fail | 単一ファイル（実行体 + `plugin.json`） | `plugin.json` の `exec` |
| runtime / trigger | サブディレクトリ束 | runtime: `setup`/`check`/`test`、trigger: `install`/`uninstall`/`fire`（固定名） |
| mcp.d | 構成断片（`*.json`） | ポート非該当（executor へマージ供給） |

### 6.2 order ソート

- 実行順は `plugin.json` の `order`（整数）昇順。`order` 省略時はファイル名の数字プレフィックス（`NN-name`）に従う。
- 番号が同一の場合は名前順で**決定的**に解決する（非決定を作らない）。安定ソートを用いる。
- 番号は **10 刻み**を基本とし、間への挿入余地を残す運用とする。
- runtime / trigger は番号プレフィックスを付けない。選択は runtime = `.harness.yml` の宣言、trigger = install による（順序ではないため、D1 §1.7・§1.9）。

### 6.3 有効化判定

| 判定 | 有効化 | 無効化（残して OFF） |
|---|---|---|
| 存在 | `ports/<port>.d/` に置く | ディレクトリから削除 |
| 実行可否 | 実行可能な実行体 + 妥当な `plugin.json` を持つ | `.disabled` 等での退避、または実行体を除去 |

効果測定のための ON/OFF はディレクトリ操作のみで行い（要件 §3.2 原則2「1 変数ずつ測る」）、コア・discovery は無変更である。単一ポート（task-source / executor）で有効候補が 0 件の場合はコア停止（構成不備、§2.7）。

---

## 7. 上向き探索（.harness.yml）の解決規則

`.harness.yml` は対象リポジトリのルートに**必須**の宣言であり（D1 §1.8）、kind から runtime 群とプロンプトテンプレートを決定する。discovery はこれを上向き探索で解決する。

### 7.1 探索規則

| 項目 | 規則 |
|---|---|
| 起点 | コア実行時のカレント（対象リポジトリ内の任意ディレクトリを許容） |
| 探索方向 | 起点から親方向へ、`.harness.yml` を発見するまで上る（リポジトリルートに 1 個存在する前提） |
| 停止 | リポジトリルート（`.git` 検出）または filesystem ルートで打ち切り |
| 不在時 | 発見できなければタスクを実行せず `needs-human`（暗黙の runtime 自動検出は行わない、D1 §1.8・要件 §4.2③） |

### 7.2 kind 解決

1. Issue の `kind:<name>` ラベル（無指定時は `code`）を取得する。
2. `.harness.yml` の `kinds.<name>` を引き、`runtimes`（1 つ以上）と `prompt`（テンプレートパス）を得る。
3. 該当 kind が未定義、または `runtimes` の各要素が `runtime.d/<name>/` に実在しないいずれの場合も `needs-human`（再現性優先）。
4. `runtimes` が複数の場合、gate 実行順・部分失敗の扱いは要件 §11.3 で保留。本設計では単一 runtime を前提とし、複数指定時は配列順に setup/check/test を実行する素朴実装に留める。

---

## 8. worktree ライフサイクル

1 Issue = 1 ブランチ = 1 worktree。AI の作業はすべて生滅する worktree 内で行い、人間の作業ディレクトリと物理分離する（要件 §8.2）。フレッシュコンテキスト原則をファイルシステムへも適用し、後始末を「削除一発」に単純化する（cleanup バグを構造的に排除）。

### 8.1 命名規則と配置

| 項目 | 規則 |
|---|---|
| 配置 | `$TMPDIR/halo-wt-issue-N/`（OS tmpdir 直下）。リポジトリ内入れ子を避け、lint/glob の誤検出を構造的に回避（要件 §8.2 揮発物） |
| 命名 | `halo-wt-issue-<N>`（`<N>` は Issue 番号）。ブランチは `feature/issue-<N>` |
| ブランチ | 同一ブランチの二重チェックアウトは git が禁止するため、並列時の衝突防止を無料で得る |

> **v1.5 → v1.8 の配置変更**: v1.5 素材は worktree を `~/halo/wt/issue-N`（`/home` 配下固定）に置いていたが、v1.8 要件 §8.2 は **OS tmpdir（`$TMPDIR/halo-wt-issue-N/`）** を揮発物の置き場と定める。ただしリンクベース依存共有（pnpm store / uv cache / CARGO_TARGET_DIR）は同一ファイルシステム内でのみ有効なため（要件 §4.2⑦・D1 §1.7 WSL2 配置制約）、`$TMPDIR` と各ストア・cache は同一 FS（WSL2 の ext4 側）に置く必要がある。`/mnt/c/` 配下への配置は禁止。

### 8.2 状態遷移（生成→破棄）

| 状態 | 処理 | 対応 loop 状態 |
|---|---|---|
| Created | `git worktree add $TMPDIR/halo-wt-issue-<N> -b feature/issue-<N>` | Next 後・PreflightHeavy |
| KindResolved | `.harness.yml` の kind 解決（§7）。不在/未定義は NeedsHuman | Context 前 |
| SetUp | 採用 runtime 群の `setup`（env 注入・依存実体化・キャッシュ外出し） | Context 前 |
| Running | executor 実行。サンドボックス書込境界を worktree に一致させる（要件 §6.1、D4 管轄） | Execute |
| GateEval | 作業ツリーの未コミット diff を gate へ | Gate |
| Failing→Running | gate reason を再注入し再実行（retry_count < 閾値） | Gate fail → 次 iter |
| Passed→Sink | 合格。commit / PR 作成（autonomy フィルタ後） | Sink |
| Removed | pass（PR 作成後）/ fail 確定 / needs-human いずれも `git worktree remove --force` で痕跡ごと削除 | イテレーション終端 |

> 実装注記: KindResolved・SetUp（kind 解決と runtime setup）の順序保証は `createWorktree` シーム（CLI 側で worktree 生成と併せて実体化）が担い、`runLoop` 本体はこれらを状態として持たない。コアが受け取るのは実体化済み worktree の絶対パスのみで、kind 解決／runtime 選択が Context 実行前に完了していることは CLI/`createWorktree` の責務である（§1.2 委譲）。

### 8.3 破棄の一元化

- 合格しない限り sink（commit / PR）が走らないため、不良成果物が外部へ出る導線は **gate 通過を唯一の関門**として一元化される。
- fail 確定・needs-human・stuck/timeout のいずれでも、変更は使い捨て worktree 内に閉じ、`git worktree remove --force` で削除される。コアは worktree の中身を人間作業ディレクトリへ持ち出さない。
- worktree はグローバル状態を持たない揮発物であり（要件 §8.2）、残骸が生じた場合の掃除は doctor（D3）とランブック（D7）の管轄とする。

---

## 付録 A. モジュール依存図

```
                     ┌──────────┐
                     │   loop   │  状態機械（§2）
                     └────┬─────┘
        ┌──────────┬──────┼───────┬──────────┬─────────┐
        ▼          ▼      ▼       ▼          ▼         ▼
   ┌─────────┐ ┌───────┐ ┌──────┐ ┌────────┐ ┌───────┐ ┌────────┐
   │preflight│ │runPort│ │budget│ │autonomy│ │discov.│ │ config │
   └────┬────┘ └───┬───┘ └──┬───┘ └───┬────┘ └───┬───┘ └───┬────┘
        │  ┌───────┴────────┐ │         │         │         │
        ▼  ▼                ▼ ▼         ▼         ▼         ▼
    ┌──────┐            ┌────────┐   （config は discovery / budget /
    │ lock │            │ logger │     preflight から参照される）
    └──────┘            └────────┘
```

## 付録 B. v1.5 素材からの主な変更点

| 項目 | v1.5 素材（bash） | v1.8（本書・TypeScript） |
|---|---|---|
| コア実装 | `core/loop.sh` + `core/helpers.sh`（bash・約 20 行 + 30 行） | `packages/core` の 9 モジュール（TS） |
| ポート実行関数 | `run_port` / `run_ports_merge` / `run_ports_all` / `run_ports_each`（helpers.sh） | runPort（単発）+ loop 内の 4 戦略関数（§3.6） |
| 自律度宣言 | sink 冒頭メタコメント `# min-autonomy: L3` | `plugin.json` の `minAutonomy`（§2.5・D1 §2） |
| worktree 配置 | `~/halo/wt/issue-N`（/home 固定） | `$TMPDIR/halo-wt-issue-N`（要件 §8.2、同一 FS 制約は維持） |
| mcp.json 生成 | `jq -s` マージ | config/discovery による deep-merge（§4.2） |
| 配布 | ローカルスクリプト | npm 配布（`npx halo` / `.bin/halo` 絶対パス直叩き） |
| lock | `flock /tmp/harness.lock` | `lock` モジュール（`$TMPDIR/halo.lock`） |

## 付録 C. 参照

- HALO要件定義書 v1.8 §3（全体アーキテクチャ）・§4.3（コアループ）・§4.4（起動層・プリフライト 2 段・安全装置）・§6（非機能）・§8（ディレクトリ構成）・§11（設計判断の分類）
- D1 コントラクト仕様書（9 ポート I/O 型・`plugin.json`・実行規約・kg:// URI・STUCK マーカー・JSON Schema 生成）
- D3 CLI 仕様書（コア関数への委譲・doctor・プロファイル形式）／ D4 セキュリティ設計書（サンドボックス・自己改変防止）／ D8 テスト戦略書（純粋関数の単体テスト・ループ回帰）
</content>
</invoke>
