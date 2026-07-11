# HALO — Harness for Autonomous Loop Orchestration 要件定義書

| 項目 | 内容 |
|---|---|
| プロダクト名 | **HALO**（Harness for Autonomous Loop Orchestration） |
| 文書バージョン | 1.8（specs/ 廃止: 要件をナレッジグラフへ一元化、凍結性は書き込み制御で担保） |
| 公開方針 | コア + コントラクト + 見本プラグインを OSS 公開。グラフ統合（MCP / KuzuDB / 陳腐化検出）は非公開のプライベートプラグイン |
| 作成日 | 2026-07-09 |
| 対象読者 | 本人（個人検証用）。将来的に社内展開時の叩き台とする |
| ステータス | 実装フェーズ着手可能 |

---

## 1. 背景と目的

### 1.1 背景

- airCloset社の実践事例（ハーネスエンジニアリング：Guides=事前制御 + Sensors=事後制御）に見られる通り、AI自動開発の成否はモデル性能ではなくハーネス設計に依存する。
- 2026年時点で「完全自動開発」は、検証可能な出力（テスト・ビルドの成否）を持つタスクに限れば「レール上での自動」として現実的である。
- 個人検証環境（WSL2/Arch Linux）で最小構成から段階的に構築し、将来的な社内展開の知見を得る。

### 1.2 目的

**HALO** は、AIエージェント（Claude Code headless）が GitHub Issue を起点に **実装 → 品質検証 → PR作成** までを人間の介在なしに反復実行できるようにする、汎用の自律開発ハーネスである。名称は Harness for Autonomous Loop Orchestration の頭字語であり、ループを「囲んで守る輪」（Guides + Sensors）というハーネスの本質を表す。

### 1.3 ゴール / 非ゴール

**ゴール**

- 夜間8時間の無人稼働で、品質ゲートを通過したPRを継続的に生成できる。
- 構成要素（タスク源・コンテキスト源・品質ゲート・実行器・出力先）の追加・削除・差し替えが、コアの変更なしにファイル操作のみで完結する。
- コードグラフ / ナレッジグラフによるコンテキスト供給の効果を、変数を分離して測定できる。

**非ゴール**

- 要件定義・受け入れ判断・PRマージ・本番デプロイの自動化（人間ゲートとして固定する）。
- マルチマシン / クラウド分散実行（将来拡張とする）。
- ToC プロダクトや停止がクリティカルなシステムへの適用。

---

## 2. スコープ

### 2.1 対象

| 項目 | 内容 |
|---|---|
| 開発対象 | **特定プロダクト非依存（汎用）**。`.harness.yml` を置いた任意のリポジトリが対象。ユースケースはアプリ開発・保守・設計書/ADR の作成修正（kind で切り替え） |
| 実行環境 | クロスプラットフォーム（Node.js 20+）。**ハーネスはヘッドレスで完結**（端末マルチプレクサ等に非依存）。bubblewrap サンドボックスと WSL2 対応は Linux 固有のオプション機能 |
| 実装言語 | **コア・CLI・コントラクト型定義は TypeScript**（npm 配布、`npx halo` で導入可能、外部バイナリ依存を排除）。プラグインは任意言語（コントラクトがプロセス境界のため） |
| 公開範囲 | 公開: `packages/core`（loop・run_port・プリフライト・予算）/ `packages/cli` / `packages/contracts`（JSON Schema + TS 型）/ 見本プラグイン。非公開: グラフ統合一式（codegraph・knowledge MCP、KuzuDB スキーマ、陳腐化検出、用語集整合チェック）— すべて context.d / sink.d / mcp.d のプライベートプラグインとして実装 |
| エージェント | Claude Code（headless: `claude -p`）。将来 Agent SDK 版へ差し替え可能とする |
| タスク管理 | GitHub Issues（初期は TASKS.md でも可） |
| 言語 | runtime プラグインで対応（初期: node-pnpm / python-uv / rust）。新言語はディレクトリ追加で拡張 |

### 2.2 対象外

- native Windows / macOS 上での実行（サンドボックス方式が異なるため）
- 複数リポジトリの同時横断開発（Phase 3 以降で検討）

---

## 3. 全体アーキテクチャ

### 3.1 4層構成

```
┌─────────────────────────────────────────────┐
│ L1: オーケストレーション層（bash、ヘッドレス動作）   │
│     halo CLI（プリフライト）/ core loop / タスクキュー              │
├─────────────────────────────────────────────┤
│ L2: 実行層（claude -p headless）               │
│     実装agent / 評価agent / bubblewrapサンドボックス │
├──────────────────────┬──────────────────────┤
│ L3a: コンテキスト層(MCP) │ L3b: 品質ゲート層        │
│  コードグラフ(CGC+KuzuDB) │  Stop hook(test/lint強制) │
│  ナレッジグラフ(設計書/ADR) │  PreToolUse(危険操作遮断) │
├──────────────────────┴──────────────────────┤
│ L4: 永続化層                                   │
│     git履歴 / fix_plan.md / progress.txt / グラフDB │
└─────────────────────────────────────────────┘
```

### 3.2 設計原則

1. **ポート＆アダプタ（ヘキサゴナル）**: コアループはドメインとして固定し、外部との接点をすべてポートとして抽象化する。
2. **統一コントラクト**: 全プラグインは「stdin/stdout の JSON + 終了コード」で通信する。言語非依存（bash / Python / Node いずれでもプラグイン化可能）。**このコントラクトは OSS としての公開 API であり、プロセス境界に置くことでコアの実装言語からプラグインを独立させる（最重要の不変条件）**。
3. **ディレクトリ規約による活性化**: `ports/<port名>.d/` にファイルを置けば有効、削除すれば無効。数字プレフィックスで実行順を制御する（`conf.d` 方式）。
4. **フレッシュコンテキスト原則（Ralph型）**: 1イテレーション1タスク。進捗は LLM のコンテキストではなくファイル（git履歴・fix_plan.md）に永続化する。コンテキストは 100k トークン未満（Dumb Zone 手前）に保つ。
5. **Generator / Evaluator 分離**: 実装エージェントと評価エージェントを独立コンテキスト・独立定義とする。
6. **自律度レベル（L1→L3）**: ループの権限を段階制御する実行時パラメータ `AUTONOMY` を持つ。L1=報告のみ（変更なし・計画/ログ出力のみ）、L2=支援付き（commit + draft PR、人間承認待ち）、L3=無人（PR作成まで自動）。sink.d のフィルタとして実装し、新規ループ・新規プラグイン導入直後は必ず L1 から開始して観察後に昇格する。Phase（機能軸）と自律度（権限軸）は直交する。
7. **失敗からの学習経路の明示化**: 失敗は on-fail ポートで failure-catalog.md にインシデント形式で記録し、context.d 経由で sign として次イテレーションに再注入する。ハーネスが自身の失敗カタログから学ぶループを構造として持つ。

---

## 4. ポート仕様

### 4.1 ポート一覧

| # | ポート | 責務 | 初期アダプタ | 将来アダプタ例 |
|---|---|---|---|---|
| ① | task-source | タスクの取得・完了・失敗報告 | GitHub Issues（`gh` CLI） | TASKS.md / Linear |
| ② | context | 実行前の静的コンテキスト注入 | codegraph要約 / knowledge要約 | 過去PR要約 / アラート情報 |
| ③ | executor | プロンプトの実行 | claude -p（headless） | Agent SDK / 並列worktree版 |
| ④ | gate | 成果物の合否判定 | typecheck / lint / test / AIレビュー / loop-audit | E2E / カバレッジ / セキュリティスキャン |
| ⑤ | sink | 合格後の副作用（自律度でフィルタ） | git commit / PR作成 / ログ | 通知 / グラフ再インデックス |
| ⑥ | on-fail | 失敗時の処理 | 失敗記録 / エスカレーション / sign候補生成 | 通知 / 自動Issue分割 |
| ⑦ | runtime | 成果物種別固有のセットアップと検査コマンドの提供 | node-pnpm / python-uv / rust / docs-md | go / java / スライド等 |
| ⑧ | kind | タスク種別によるruntime・プロンプトの切り替え（.harness.yml） | code / docs | design-review / refactor 等 |
| ⑨ | trigger | コアの起動（halo CLI を呼ぶ唯一の入口） | schedule / polling | webhook / manual |
| 補 | mcp.d | executorに渡すMCP構成断片 | codegraph / knowledge | github MCP |

### 4.2 コントラクト定義

#### ① task-source

```
入力: {"op": "next"}
出力: {"task_id": "T-012", "title": "...", "body": "...", "spec_refs": ["kg://document/auth-login"]}
     ※ spec_refs はナレッジグラフの文書/決定ノード ID を指す（ファイルパスではない）
     タスクなしの場合: {"task_id": null} + exit 0

入力: {"op": "complete", "task_id": "...", "pr_url": "..."}
入力: {"op": "fail", "task_id": "...", "reason": "...", "retry_count": n}
```

GitHub Issues アダプタの挙動:

- `next`: `gh issue list --label ready` の先頭を取得し、`in-progress` ラベルへ付け替え（多重取得防止のロック）。
- `complete`: PR 本文の `Closes #番号` によりマージ時に自動クローズ。
- `fail`: リトライ回数を Issue コメントに記録。**同一 Issue で 3 回失敗したら `needs-human` ラベルを付与し人間へエスカレーション**（無限ループ遮断）。

#### ② context

```
入力: task-sourceの出力（タスク情報）
出力: {"fragments": [{"source": "codegraph", "content": "...", "priority": 10}]}
```

- コアは全 context プラグインを順に実行し、fragments を priority 順に連結、トークン上限で切り詰める。
- **ハイブリッド方式**: 軽い要約（影響範囲サマリ）のみ事前注入し、深掘りは実行中に AI 自身が MCP ツールで取得する。

#### ③ executor

```
入力: {"prompt": "...", "workdir": "/path/to/worktree",
      "budget": {"max_turns": 40, "timeout_sec": 900}}
出力: {"status": "done|stuck|timeout", "summary": "...", "cost": {...}}
```

実行コマンドの骨子:

```bash
claude -p "$PROMPT" \
  --mcp-config "$HARNESS_ROOT/mcp.json" \
  --strict-mcp-config \
  --allowedTools "mcp__codegraph__*,mcp__knowledge__*,Edit,Write,Bash" \
  --max-turns 40
```

- `--strict-mcp-config` により、プロジェクト内 `.mcp.json` やユーザーグローバル設定を無視し、ハーネス管理の `mcp.json` のみを読む（ツール可視範囲の確定＝再現性・セキュリティ）。
- `mcp.json` は `ports/mcp.d/*.json` を jq でマージして起動時に生成する。

**worktree ライフサイクル（使い捨て方式）**

AI の作業はすべて使い捨て worktree で行う。人間の作業ディレクトリと AI の作業スコープを物理的に分離し、フレッシュコンテキスト原則をファイルシステムにも適用する。

```
add → runtime 検出 → setup（runtime 委譲） → 実行 → (pass: PR / fail: そのまま) → remove
```

1. **作成**: `git worktree add $TMPDIR/halo-wt-issue-<N> -b feature/issue-<N>`（1 Issue = 1 ブランチ = 1 worktree）。
2. **kind 解決と runtime 選択**: Issue のラベル（`kind:code` / `kind:docs` 等、無指定時は `code`）から、プロジェクトルートの `.harness.yml`（**必須**）の `kinds` 定義を引き、使用する runtime 群とプロンプトテンプレートを決定する。`.harness.yml` が存在しないリポジトリはタスクを実行せず `needs-human` へ（暗黙の自動検出は行わない）。
3. **setup**: 採用 runtime の `setup.sh` に委譲（env 注入・依存の実体化・キャッシュ設定）。プロジェクト種別固有の知識は executor には持たせない。
4. **実行**: bubblewrap の書込許可範囲を worktree に一致させる（サンドボックス境界 = タスクの作業スコープ）。
5. **掃除**: pass 時は PR 作成後、fail 確定（3回）時はそのまま、`git worktree remove --force` でディレクトリごと削除。cleanup ロジックのバグが構造的に存在しない。

**runtime への抽象要件**: 使い捨て方式では setup がタスクごとに毎回走るため、各 runtime は「依存の実体化を高速に行えること」を満たすこと（実現手段は runtime の実装詳細とする。例: node-pnpm はグローバルストアのハードリンク、python-uv はリンクベースの `uv sync`、rust は共有 `CARGO_TARGET_DIR`）。正しさに影響しないビルドキャッシュ類は 各ツール標準のグローバルキャッシュ（HALO は独自のキャッシュ層を持たない）へ向けてよい（キャッシュ破損による誤りは gate が検出する前提）。

**利点の整理**: 状態汚染ゼロ（前タスクの残骸が次タスクへ漏れない）、失敗時の後始末が削除一発、サンドボックス境界との完全一致（監査上「このタスクが触れた場所」が明確）。同一ブランチの二重チェックアウトを git が禁止するため、並列時のブランチ衝突防止も worktree の仕組み自体が担う。

#### ⑦ runtime

成果物種別ごとの固有設定・コマンドを1ディレクトリに束ねるプラグイン。**runtime が吸収するのは「言語」ではなく「成果物の種類」**であり、コード（node-pnpm / python-uv / rust）と文書（docs-md）を同列に扱う。新種別対応はディレクトリ追加のみで完結し、コア・executor・gate は無変更とする。

```
ports/runtime.d/<name>/
├── setup.sh    # env注入 + 依存実体化 + キャッシュ外出し設定
├── check.sh    # 静的検査（exit 2 = fail）
└── test.sh     # 動的検証（exit 2 = fail）
```

- コントラクトは他ポートと同一（stdin JSON + 終了コード）。runtime の選択は `.harness.yml` の宣言によるため `detect.sh` は持たない。
- gate.d の `10-typecheck.sh` / `20-lint.sh` / `30-test.sh` は実コマンドを持たず、採用 runtime の `check.sh` / `test.sh` へ委譲する薄いラッパーとする。
- 初期実装:
  - `node-pnpm/`: pnpm `--offline`（グローバルストアのハードリンク共有）、tsc / eslint / vitest
  - `python-uv/`: `uv sync`（リンクベース）、mypy / ruff / pytest
  - `rust/`: 共有 `CARGO_TARGET_DIR`、cargo check / clippy / test
  - `docs-md/`: setup はほぼ noop。check = markdownlint + リンク切れ + ADR テンプレート準拠。test = **用語集整合チェック**（文書中のドメイン用語をナレッジグラフの用語集ノードと照合。ユビキタス言語を自動ゲート化する）
- **配置制約（WSL2）**: リンクベースの依存共有は同一ファイルシステム内でのみ有効なため、`wt/`・各ストア・`cache/` はすべて WSL2 の ext4 側（`/home` 配下）に置く。`/mnt/c/` 配下への配置は禁止。

#### ⑧ タスク種別（kind）と .harness.yml

ハーネスをアプリ開発・設計書作成/修正など複数ユースケースに対応させるため、タスクに種別（kind）を持たせる。

```yaml
# .harness.yml（対象リポジトリのルートに必須）
kinds:
  code:
    runtimes: [node-pnpm]
    prompt: prompts/code.md
  docs:
    runtimes: [docs-md]
    prompt: prompts/docs.md
```

- Issue はラベル `kind:<name>` で種別を宣言する（無指定時は `code`）。
- kind はプロンプトテンプレートも切り替える。コード実装用の指示（テスト必須等）と文書用の指示（ADR フォーマット準拠・用語集の語彙使用等）は分離する。
- **docs 系と code 系の接続（双方向）**:
  - docs → code 方向: docs タスクのマージ後、sink（`35-reindex-knowledge.sh`）がナレッジグラフを再インデックスし、以降の code タスクの context に反映される。
  - code → docs 方向: プリフライトのコードグラフ再インデックス時に、設計書が参照するシンボル/パスの陳腐化を検出し、`kind:docs` の修正 Issue を自動起票する。
  - 設計書とコードが互いの変更を検出してタスクを発注し合うことで、ナレッジグラフ陳腐化リスクへの構造的対策となる。

#### ④ gate

```
入力: {"task_id": "...", "workdir": "...", "changed_files": [...]}
判定: exit 0 = pass / exit 2 = fail（Claude Code hooks と同一規約）
出力(failのみ): {"reason": "coverage 87% < 90%", "hint": "src/order.tsのテスト不足"}
```

- コアは gate.d を番号順に全実行し、1 つでも fail なら reason を**次イテレーションのプロンプトに再注入**して差し戻す。
- AI レビュー（evaluator agent）もゲートの 1 つとして同列に扱う。evaluator は「懐疑的」に調整するが、correctness / 要件に影響するギャップのみを指摘させ過剰指摘を防ぐ。

#### ⑤ sink

```
入力: {"task_id": "...", "workdir": "...", "summary": "..."}
```

- 合格後のみ実行。1 つの sink が失敗しても他の sink は続行する。
- 初期構成: `10-git-commit.sh` / `15-create-pr.sh`（`gh pr create`、本文に `Closes #番号`） / `20-progress-log.sh`。
- 将来: `30-reindex-graph.sh`（マージ後のコードグラフ再インデックス）。
- **自律度フィルタ**: 各 sink はメタデータとして最低必要自律度を宣言する（例: `# min-autonomy: L3`）。コアは現在の `AUTONOMY` 未満の sink をスキップする。L1 では `20-progress-log.sh` のみ、L2 では commit + draft PR、L3 で通常 PR 作成が有効になる。

#### ⑥ on-fail

```
入力: {"task_id": "...", "reason": "...", "retry_count": n, "gate": "30-test", "workdir": "..."}
```

- gate fail またはexecutor の stuck/timeout 時に番号順で全実行する。
- 初期構成:
  - `10-record-failure.sh`: `.halo/failure-catalog.md` にインシデント形式（日時 / タスク / 失敗ゲート / 理由 / 対処）で追記。
  - `20-escalate.sh`: retry_count が閾値（3回）に達したら `needs-human` ラベル付与と in-progress 解除。
  - `30-suggest-sign.sh`: 失敗ログから PROMPT.md への sign 候補を生成し `signs-proposed.md` に出力（採用は人間が判断）。
- 失敗カタログは context.d（`30-recent-failures.sh`）が読み取り、直近の失敗パターンを次イテレーションへ注入する。これにより「失敗 → 記録 → 再注入」の学習経路が閉じる。

### 4.3 コアループ（擬似コード）

```bash
task=$(run_port task-source '{"op":"next"}') || exit 0
ctx=$(run_ports_merge context "$task")
prompt=$(build_prompt "$task" "$ctx" "$last_gate_failure")
result=$(run_port executor "{\"prompt\": ..., ...}")
if run_ports_all gate "$task"; then
  run_ports_each sink "$task"
  run_port task-source '{"op":"complete", ...}'
else
  last_gate_failure=$(cat gate_failure.json)  # 次周回で再注入
fi
```

コアは 20 行程度に収め、以降の機能追加はすべてプラグインファイルの追加で完結させる。

### 4.4 起動層（trigger）とスケジューリング

起動系はコアループの外側に位置し、「コアを呼ぶ側」としてポート同様に抽象化する。**トリガーは交換可能なアダプタ**であり、追加削除はファイル操作のみで完結する。

#### ⑨ trigger

```
ports/trigger.d/<name>/
├── install.sh   # トリガーの登録（スケジューラ登録・timer有効化等）
├── uninstall.sh # 解除
└── fire         # OS へ登録する起動エントリ（node_modules/.bin/halo run <profile> の絶対パス）
```

- trigger は halo CLI（`node_modules/.bin/halo`）を起動する唯一の入口であり、CLI 以下（プリフライト・loop・ポート群）はトリガーが何であるかを知らない。無人実行では npx を経由せず .bin への絶対パスを直接叩く（バージョン固定・ネットワーク非依存）。
- 初期実装:
  - `schedule/`: Windows タスクスケジューラによる定時起動（WSL2 VM の起動を兼ねる一次トリガー）
  - `polling/`: 高頻度定時起動（例: 15分間隔）+ プリフライトの「ready タスク 0 件なら即終了」により、実質的なタスク存在駆動を実現する
- 将来実装（トリガー差し替えのみで対応可、CLI 以下は無変更）:
  - `webhook/`: GitHub Issue イベントの直接受信。ただし受け口の常駐とトンネルが必要となり、公開入力→ローカル実行の導線はプロンプトインジェクション面で要注意。遅延要件が実測で問題化した場合のみ検討
  - `manual/`: 手動起動（開発・デバッグ用）

#### 起動プロファイル（profiles/）

ループの実行設定（自律度・上限・タスクフィルタ・予算）を環境変数ファイルとして束ね、トリガーはプロファイル名指定で `halo run <profile>` を起動するだけとする。ポーリング型の導入により、プロファイルは「時間帯」ではなく**「頻度 × 自律度 × 予算」の組み合わせ**として定義する。

| プロファイル | AUTONOMY | トリガー | 用途 |
|---|---|---|---|
| continuous | L3 | polling（15分間隔） | タスク存在駆動の常時消化（本命） |
| daytime-l1 | L1 | polling（日中のみ） | 観察運転（新プラグイン導入後の判断品質確認） |
| nightly | L3 | schedule（深夜1回） | 大きめバッチ・グラフ完全再構築等 |

#### プリフライトの2段化

高頻度起動と両立させるため、プリフライトを軽量/重量に分割する。

- **軽量（毎回・数秒）**: STOP ファイル確認 / flock / ready タスク有無（0 件なら即終了）/ 日次予算残
- **重量（タスクが実在した時のみ）**: git 作業ツリー clean / ディスク残量 / クレジット probe / グラフ鮮度同期（main 進行検出→再インデックス→陳腐化検出）

#### halo CLI 標準装備の安全装置

| 装置 | 実装 | 目的 |
|---|---|---|
| 排他制御 | `flock $TMPDIR/halo.lock` | 多重起動防止（ポーリング間隔より長いイテレーションとの重複回避） |
| キルスイッチ | `.halo/STOP` ファイルの存在で即終了（各イテレーション冒頭で確認） | 端末に入らずファイル配置だけで停止可能にする（Windows エクスプローラーからも可） |
| **日次予算** | 1 日あたりの上限（イテレーション数 or コスト相当）を logs/ の当日実績から算出し、超過時は起動しても即終了 | 高頻度起動での「気づいたら一日中回っていた」を防ぐ。夜間 1 回前提の TIMEOUT=8h を置き換える主たるコスト制御 |
| 実行時間上限 | プロファイルの TIMEOUT で1回の起動を打ち切り | ポーリング間隔との整合、資源占有の防止 |

---

## 5. コンテキスト層（グラフ基盤）要件

### 5.1 コードグラフ

| 項目 | 内容 |
|---|---|
| ツール | CodeGraphContext（CGC） |
| バックエンド | KuzuDB（組み込み・ファイル1個・サーバー不要） |
| 生成方式 | tree-sitter による静的解析（LLM API 不使用・ローカル完結） |
| 更新 | **マージ駆動 + プリフライト**（案A）。ループ起動時のプリフライトで main が前回インデックス時から進んでいれば再インデックスする。`watch` モードは使い捨て worktree 方式と両立しないため不採用（監視対象が main ではなく生滅する worktree になりグラフが汚染される） |
| 提供ツール例 | `find_code` / `analyze_code_relationships` / `find_dead_code` / `execute_cypher_query` |

**並列時の制約**: KuzuDB は単一プロセスからの書き込み前提のため、コードグラフは「main ブランチ基準の read-only スナップショット」を全 worktree で共有する。書き込み（再インデックス）はプリフライト時の1回のみとし、ループ実行中のグラフは不変とする（イテレーション間でコンテキストの再現性も担保される）。

### 5.2 ナレッジグラフ

| 項目 | 内容 |
|---|---|
| 格納対象 | 設計書 / ADR / 用語集（ユビキタス言語） / **仕様・要件・受け入れ条件（一元管理。specs/ ディレクトリは持たない）** |
| バックエンド | KuzuDB（初期。Neo4j への移行は必要になってから） |
| 構築 | 人間設計（社内暗黙知に依存するため）。手書き Cypher で投入 |
| MCP | 自作の薄いサーバー。初期ツールは `search_docs` / `trace_spec_to_code` の 2 つから |

### 5.3 要件の凍結性（specs/ 廃止に伴う担保方式）

要件・仕様はナレッジグラフに一元管理し、専用ディレクトリ（specs/）は持たない。「AI がゴールを書き換えられない」という凍結性は、ファイルの git 管理ではなく**グラフへの書き込み制御**で担保する。

1. **実行中 read-only**: ループ実行中、knowledge MCP はグラフを読み取り専用で開く（KuzuDB 並列制約による「実行中グラフ不変」と同一の機構を安全要件として再利用）。
2. **書き込み経路の限定**: グラフへの書き込みは (a) 人間の手作業、(b) sink 35（docs マージ後の再インデックス = **PR レビューを通過した変更のみ**）の 2 経路に限る。
3. **改変検出**: loop-audit ⑦がグラフファイルのハッシュをループ開始時と照合し、実行中の直接改変を fail として検出する。

要件文書の原本（md 等）を人間がどこで管理するかは HALO の関知外とする（docs/ でも外部ツールでも可。グラフに投入されていればよい）。

### 5.4 Agentic Graph RAG 方針

- グラフ構築側は人間設計、**クエリ側のみエージェント化**する。
- 各 MCP ツールの返却値に「次に呼ぶべきツールの引数」を埋め込み、AI がマルチホップ探索を自律的に組み立てられるようにする（返却値が runbook になる）。
- 検索の各ステップは決定的とし、オーケストレーションのみを AI に委ねる。

### 5.5 橋渡しエッジ

- 設計書ノード ⇔ 実装コンポーネントノードの対応付けが最大の価値源泉。
- 初期は設計書内の明示的リンク（ファイルパス記載）から機械抽出し、不足分は AI 推定 + 人間レビューで補う。

---

## 6. 非機能要件

### 6.1 セキュリティ

| 要件 | 実現方式 |
|---|---|
| ファイルシステム分離 | bubblewrap サンドボックス（作業ディレクトリのみ書込可）。WSL2/Arch でネイティブ動作 |
| Windows パス継承問題の回避 | ループ起動時に PATH を Linux 側のみに洗い直すラッパーを噛ませる |
| 危険操作の遮断 | PreToolUse hook（exit 2）で `rm -rf` / `git push --force` / `.env` 読取を確定ブロック。settings.json の deny と二重化 |
| 機密ファイル保護 | `Read(**/.env)` deny に加え、OS レベルの `sandbox.denyRead`（`~/.ssh` / `~/.aws`）を併用 |
| GitHub 認証 | PR 作成とラベル操作のみ可能な fine-grained PAT に限定。`repo` フルスコープ PAT は使用禁止 |
| MCP サーバーの権限 | MCP サーバーはサンドボックス外（通常ユーザー権限）で動作する点を前提に、knowledge MCP は read-only でグラフを開く |
| プロンプトインジェクション | 公開 Issue を読む構成のため、Issue 本文は信頼しない。ツール許可の最小化と safe outputs（マージ自動化の禁止）で緩和 |

### 6.2 暴走・コスト制御

| 要件 | 実現方式 |
|---|---|
| ターン上限 | `--max-turns 40` |
| イテレーションタイムアウト | timeout 15 分 / iteration |
| イテレーション上限 | MAX_ITER=20 / 夜間バッチ |
| スタック検出 | STUCK マーカー出力で停止。同一 Issue 3 回 fail で `needs-human` |
| コスト監視 | ccusage で日次監視。headless は 2026-06-15 以降、対話用と別のクレジットプール消費のため、夜間稼働前に短時間で消費レートを実測する |
| コスト上限判断 | 月間エージェント支出が $200 を超える場合は直接 API キー + spend limit へ切替を検討 |

### 6.3 可観測性

- 全イテレーションのログを `logs/iter_N.json` に構造化保存。
- 観察は任意のツールで行う（tmux / `tail -f` / `jq` 等）。**ハーネス自体は観察ツールに非依存**であり、構造化ログと STOP ファイルのみを公式インターフェースとする。
- gate 通過率をイテレーション単位で記録し、コンテキストプラグインの ON/OFF 効果測定に使用する。

---

## 7. 人間ゲート（固定）

以下は自動化の対象外とし、常に人間が実施する。

1. 要件定義（仕様の正しさはハーネスでは守れない）
2. Issue の起票と `ready` ラベル付与（＝実行キューへの投入判断）
3. PR のレビューとマージ
4. 本番デプロイ承認
5. 外部 API 接続・機密情報を扱う実装
6. `needs-human` エスカレーションの処理

---

## 8. リポジトリ / ディレクトリ構成

### 8.1 公開リポジトリ（OSS: halo）

```
halo/
├── packages/
│   ├── core/             # loop / run_port / 2段プリフライト / 日次予算（TS）
│   ├── cli/              # halo run|trigger|stop|status（TS）
│   └── contracts/        # 各ポートの JSON Schema + TS 型定義（公開 API）
├── plugins/              # 見本プラグイン（bash/TS 混在、コントラクトの実例を兼ねる）
│   ├── task-source-github/
│   ├── runtime-node-pnpm/
│   ├── gate-loop-audit/
│   └── trigger-polling/
└── docs/                 # アーキテクチャ文書（本書ベース）
```

公開/非公開の境界はプラグイン境界と一致する。グラフ統合一式（codegraph / knowledge MCP・KuzuDB・陳腐化検出）はプライベートプラグインとしてワークスペース側にのみ存在し、コアはコントラクト越しに fragments を受け取るのみでグラフの存在を知らない。

### 8.2 利用時のプロジェクト構成（グローバル状態ゼロ）

HALO はマシングローバルな状態を一切持たない。導入は `npm i -D halo`、撤去は `.halo/` 削除とパッケージ削除で完了する。

```
<対象リポジトリ>/
├── .harness.yml              # コミットされる宣言（kinds / runtimes / prompt 指定）
├── .gitignore                # .halo/ を必ず含める
├── package.json              # halo と公開プラグインを devDependencies に
├── node_modules/
│   ├── .bin/halo             # 実行エントリ（npx halo / トリガーは絶対パス直叩き）
│   └── halo*, @halo/plugin-* # コア・CLI・公開プラグインの実体
├── .halo/                    # gitignore されるローカル状態（HALO の永続状態はすべてここ）
│   ├── ports/                #   プライベートプラグイン（例: グラフ統合）と有効化リンク
│   │   ├── task-source.d/  context.d/  executor.d/  gate.d/
│   │   ├── runtime.d/  sink.d/  on-fail.d/  trigger.d/  mcp.d/
│   ├── profiles/             #   continuous / daytime-l1 / nightly（頻度×自律度×予算）
│   ├── prompts/              #   kind 別テンプレート + sign 蓄積
│   ├── env-templates/        #   worktree へ注入する git 管理外ファイル雛形
│   ├── graphs/               #   code.kuzu / knowledge.kuzu（非公開プラグインの状態）
│   ├── logs/                 #   イテレーション記録・L1 採点・消費実績
│   ├── failure-catalog.md    #   失敗インシデント（on-fail が追記）
│   ├── mcp.json              #   mcp.d からマージ生成される実行時成果物
│   └── STOP                  #   キルスイッチ（ユーザーが配置）
├── CLAUDE.md                 # 200行未満厳守
└── .claude/                  # settings.json（sandbox+deny）/ hooks / agents
```

**HALO の成果物・状態の4分類**

| 分類 | 置き場所 | 例 |
|---|---|---|
| 宣言（コミット対象） | プロジェクトルート | `.harness.yml` / CLAUDE.md |
| 永続状態（gitignore） | `.halo/` | グラフ / logs / sign / failure-catalog |
| 成果物 | GitHub | ブランチ / PR / Issue ラベル・retry コメント（**タスク進行状態の真実の源**） |
| 揮発物（実行中のみ） | OS tmpdir | flock（`$TMPDIR/halo.lock`）/ 使い捨て worktree（`$TMPDIR/halo-wt-issue-N/`。リポジトリ内入れ子による lint/glob 誤検出を構造的に回避） |

**グローバル状態を持たない根拠**: 排他は OS の flock、ビルドキャッシュは各ツール標準のグローバルストア（pnpm store / CARGO_TARGET_DIR 等）、トリガー登録状態は OS スケジューラ自身が台帳、予算は台帳を持たず実行時に都度計測。複数プロジェクト対応は「`.halo/` の存在＝管理下」であり登録簿を持たない（トリガーはプロジェクト単位で `.bin/halo` への絶対パスを登録する）。

---

## 9. 段階的構築ロードマップ

各 Phase の位置づけ: Phase 0-1 = 確定事項（構造と安全）の実体化、Phase 2 = 計測に基づく調整開始、Phase 3 = 自律度の引き上げ、Phase 4 = コンテキスト層の追加、Phase 5 = 並列化。

**経過措置（spec_refs）**: グラフ導入前（Phase 1〜3）は spec_refs を空とし、要件は Issue 本文に直接記述する。Phase 4 のナレッジグラフ導入をもって spec_refs（ノード ID 参照）と凍結性担保（§5.3）が有効化される。

| フェーズ | 期間目安 | 作るもの | 入れないもの | 完了基準 |
|---|---|---|---|---|
| Phase 0<br>環境準備 | 1日 | bubblewrap/socat 導入、settings.json（sandbox + deny rules）、検証用リポジトリの選定と `.harness.yml` 配置（基準: 即ロールバック可・ドメイン把握済み・テスト基盤あり） | — | サンドボックス動作確認。worktree 作成→削除の手動1往復 |
| Phase 1<br>骨格の証明 | 1週 | CLI エントリ（flock/プリフライト/STOP/TIMEOUT）、core（loop + runPort、TS）、task-source 最小実装、executor（使い捨て worktree ライフサイクル）、runtime 1種のみ、gate（runtime 委譲 + **loop-audit=自己改変禁止。安全不変条件のため初日から必須**）、on-fail（記録のみ）、sink（progress-log のみ）、Windows タスクスケジューラ起動経路。**AUTONOMY=L1 固定** | context.d（空）、MCP、グラフ全部、evaluator、PR 作成、並列 | ①無人起動→N イテレーション→自動終了の1サイクル（dry-run: MAX_ITER=1 から）②L1 の計画報告が毎晩 logs/ に残り人間が採点できる（**昇格判断の実測データ収集開始**）③gate fail の reason が次イテレーションへ再注入される ④STOP/flock/TIMEOUT が実際に効く |
| Phase 2<br>計測と調整 | 1週 | 失敗カタログ→sign 再注入の運用開始（on-fail 30-suggest-sign + context.d 30-recent-failures）、PROMPT.md の sign 蓄積、L1 採点データの分析 | グラフ、PR 作成 | 10晩分の採点データが揃い、昇格閾値（11.2）を実測に基づき設定できる。sign 追加により同種失敗の再発が確認可能に減少 |
| Phase 3<br>自律度引き上げ | 2〜4週 | GitHub Issues 駆動の本格化（ラベル運用・3回失敗エスカレーション）、evaluator gate（40-ai-review）、sink の commit / PR 作成（L2: draft → 実測後 L3）、kind:docs と docs-md runtime の初運用 | 並列 | Phase 2 で設定した昇格基準を満たして L2→L3 昇格。Issue → PR の一気通貫を無人達成 |
| Phase 4<br>コンテキスト層 | 2〜4週 | codegraph MCP（CGC + KuzuDB、プリフライト再インデックス=案A）、context.d 10-codegraph（**単独で追加し効果測定**: 有/無の週で gate 通過率比較）、その後 knowledge MCP + 用語集整合チェック、陳腐化検出→kind:docs 自動起票、sink 35-reindex-knowledge | 並列 | グラフ有無の通過率差を定量把握。docs⇔code の双方向反映が1周する（設計書修正→グラフ更新→コードタスクの context に反映） |
| Phase 5<br>並列化 | 1〜2ヶ月 | worktree 並列（2〜3本から）、write-set 宣言による払い出し制御、dogfooding の判断（11.3） | — | 並列時の衝突ゼロ運用。仕様変更 Issue に対し影響範囲を踏まえた実装が可能 |

**原則1（外側から固める）**: 賢さ（コンテキスト層・evaluator）より先に、賢さゼロでも壊れない骨格（構造・安全装置・計測）を確定させる。不安定なループにコンテキスト層を足すと失敗原因の切り分けが不可能になる。

**原則2（1変数ずつ）**: プラグイン追加は1つずつ行い、追加前後の gate 通過率で効果を測る。特にグラフ系は codegraph → knowledge の順に分離して入れる。

**原則3（自律度は Phase と直交）**: 各 Phase の開始時・新規プラグイン導入時は AUTONOMY=L1 に落として観察し、11.2 の基準（実測後に設定）で昇格する。

**Multi-Loop Coordination（Phase 5 の設計要件）**: worktree 並列時のループ衝突対策として、Issue に write-set（変更予定ファイル範囲）を宣言させ、task-source は write-set が重複する Issue を同時に払い出さない。write-set は Issue テンプレートの項目とし、宣言がない Issue はコードグラフの影響範囲解析から推定する。

---

## 10. リスクと対応

| リスク | 影響 | 対応 |
|---|---|---|
| 仕様の解釈ミス（ハーネスをすり抜ける） | 誤った実装が品質ゲートを通過 | spec_refs（グラフノード ID）の明示、受け入れ判断の人間ゲート維持 |
| プロンプトインジェクション（Issue 経由） | 意図しない操作・情報漏洩 | PAT 最小権限、マージ非自動化、ツール許可最小化 |
| KuzuDB ロック競合 | 並列実行時のグラフアクセス失敗 | read-only スナップショット共有 + マージ後再インデックス |
| コンテキスト劣化（Dumb Zone） | 長時間セッションでの品質低下 | 1イテレーション1タスク + フレッシュコンテキスト |
| コスト暴走 | クレジット枯渇 | max-turns / timeout / MAX_ITER / ccusage 日次監視 |
| WSL2 VM の自動停止 | 夜間トリガーの不発 | Windows タスクスケジューラを一次トリガーとし WSL 起動を兼ねる。初回は起動テスト（深夜に1イテレーションだけ走る dry-run）で確認 |
| スケジュール多重起動 | worktree 破壊・二重コスト | flock による排他制御、日次予算による総量制御、プロファイル TIMEOUT |
| ナレッジグラフの陳腐化 | 誤ったコンテキスト供給 | 双方向自動反映: docs マージ → 再インデックス（sink 35）、code 変更 → 陳腐化検出 → `kind:docs` Issue 自動起票（プリフライト） |

---

## 11. 設計判断の分類

「事前に決めるべきか」の基準は**やり直しコスト（一方通行のドアか）**とする。ハーネスの思想は「事前に全部決める」ではなく「変更を安く安全にする構造を事前に作り、中身は回しながら決める」であり、本節はその分類を記録する。

### 11.1 確定（構造・安全に関わる。後から変えるコストが高い）

| 項目 | 決定内容 |
|---|---|
| ナレッジグラフのスキーマ粒度 | ノード 5 種（境界づけられたコンテキスト / 集約 / ドメイン用語 / 文書 / 決定）で止め、エンティティ・フィールドレベルには下ろさない（コードグラフとの二重管理を回避）。橋渡しエッジ `IMPLEMENTED_BY` は集約→ディレクトリパスで張る。エッジは `BELONGS_TO` / `DEFINED_IN` / `IMPLEMENTED_BY` / `SUPERSEDES` / `AFFECTS` の 5 種から開始 |
| 自己改変の禁止（安全不変条件） | loop-audit で CLAUDE.md / PROMPT.md / .harness.yml / テストファイルへのエージェントによる変更を fail とする。dogfooding 導入時もハーネス自身の変更は**恒久的に自律度 L2 上限**（ルールを書き換える主体と縛られる主体の同一化を禁止）。これらは初回の無人実行**前**に存在しなければならない |
| loop-audit の構造系チェック | git diff ベースの静的検査: ①spec_refs のノード実在（グラフ照会） ②テストファイルの削除・変更なし ③`eslint-disable`/`as any`/`@ts-ignore` 新規追加ゼロ ④カバレッジ閾値の改変なし ⑤上記自己改変の禁止 ⑥diff 1500 行超は fail（タスク分割の強制）⑦グラフファイルのハッシュがループ開始時と一致（実行中のグラフ改変検出） |
| 対象プロダクト | **特定プロダクトに依存しない（汎用フレームワーク）**。対応可否は `.harness.yml` の有無と runtime.d の充足のみで決まる。Phase 1 の検証用リポジトリは設計上の決定事項ではなくテストフィクスチャの選択であり、基準（即ロールバック可・ドメイン把握済み・テスト基盤あり）を満たせば何でもよい（候補例: hisseki） |

### 11.2 初期値（仕組みは今作る。数値・細部は運用データで調整するパラメータ）

| 項目 | 初期値（すべて**仮**） | 見直し時期 |
|---|---|---|
| evaluator の懐疑度 | 方針: block する指摘は spec 行の引用 or 失敗シナリオの提示を必須（証拠要求）。severity 3 段で Critical/Major のみ exit 2。スタイル指摘は禁止 | false positive/negative の実測後、プロンプトファイルとして継続調整 |
| 用語集整合チェックの厳密度 | 方針: block は禁止語違反（`deprecated`/`synonyms`）のみ。未登録用語は PR 本文への追加候補提案に留める | docs タスク 10 件の実績後 |
| 自律度昇格の判定 | まず L1 の計画採点を**記録する仕組み**を作る（logs/ に構造化保存、判定は人間）。閾値（妥当率 N%・M 晩連続等）は 10 晩分の実測を見てから引く。**現時点で数値は置かない**（実測なしの閾値は偽の精度） | Phase 2 完了時（10 晩実測後） |
| 降格トリガー | 重大インシデント（自己改変検出・機密アクセス試行）1 件で即 L1 は確定。gate 通過率ベースの降格閾値は実測後に設定 | 同上 |
| retry 上限（needs-human 行き） | **3 回（仮）**。根拠は経験則（1回目は reason 注入で直る、3回同一アプローチで fail はアプローチ自体の誤りを示唆）。retry 回数別の成功率を logs/ に記録し、実測で調整。retry_count に応じて context の注入戦略を変える拡張（「前回と別方針で」指示等）は context.d プラグインで対応可能 | Phase 2 完了時（実測後） |

### 11.3 保留（トリガー条件付き。今決めると害になる）

| 項目 | 保留理由 | 決定トリガー |
|---|---|---|
| モノレポ複数 runtime の gate 実行順・部分失敗 | 遭遇していない問題（YAGNI）。`path:` 交差方式は候補に留める | モノレポ案件の発生時に、その案件を見て決める |
| prompts/<kind>.md の詳細構造 | 共通ベース + kind 差分の 2 層は有力候補だが、sign は失敗から蓄積するもの（Ralph 型）であり事前設計と緊張関係にある | Phase 1〜2 の失敗カタログが溜まった時点で構造を抽出 |
| dogfooding の導入時期 | Phase 1 すら未実行の時点で決める意味がない（L2 上限のみ 11.1 で確定済み） | Phase 3 の完了基準達成時に判断 |
| PR 修正要求への AI 対応（kind:review-fix） | 現設計ではレビューでの修正要求は needs-human 扱い（人間が修正 or ready 戻し）。レビューコメントを新 Issue 化して再ループさせる kind:review-fix は、worktree が既に破棄されている前提での再現手順設計が必要 | 修正要求の needs-human 処理が運用負担として顕在化した時 |
| OSS ライセンス選定・公開手続き | MIT / Apache-2.0 の選定、依存 OSS のライセンス整理、**勤務先の職務発明・OSS 公開ポリシーの確認**（業務領域との近接があるため必須） | 公開リポジトリ作成前（Phase 1 完了までに） |

---

## 12. 参考文献

- airCloset 技術ブログ連載（ハーネスエンジニアリング、Product Graph、Agentic Graph RAG）
- cobusgreyling/loop-engineering（GitHub）: ループパターンカタログ、L1→L3 段階導入、Failure Modes / Anti-Patterns / Multi-Loop Coordination ドキュメント、loop-audit CLI。本書の自律度レベル・on-fail ポート・失敗カタログ・write-set 宣言は同リポジトリの概念を本ハーネスのポート＆アダプタ構造に翻訳したもの
- Anthropic: Effective harnesses for long-running agents / autonomous-coding quickstart
- Geoffrey Huntley: Ralph Wiggum technique（フレッシュコンテキスト原則の出典）
