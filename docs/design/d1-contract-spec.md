# D1. コントラクト仕様書（HALO Contracts Specification）

| 項目 | 内容 |
|---|---|
| 文書バージョン | 1.0 |
| 前提 | HALO要件定義書 v1.8 を最上位文書とする |
| 位置づけ | **公開 API の正式定義**。`packages/contracts` の README を兼ねる |
| 公開/私有 | 公開（OSS） |
| 変更管理方針 | **全文書中で最も保守的に変更管理する。semver 厳守、破壊的変更 = メジャー**（後述 §7） |
| ステータス | 実装着手前の確定対象（contracts の型定義と同時進行） |

> 本書は要件定義書 §3.2（設計原則）・§4（ポート仕様）を実装可能な粒度へ落としたものであり、要件と矛盾する内容は導入しない。数値パラメータ（retry 上限 3・max-turns 40・timeout 15 分等）は要件 §11.2 に従い「仮の初期値」として扱い、本書では **初期値** と明示する。

---

## 0. スコープと不変条件

HALO のコアループ（`packages/core`）とすべてのプラグインは、**プロセス境界を挟んで「stdin に JSON、stdout に JSON、終了コードで判定」の統一コントラクト**で通信する（要件 §3.2 原則2）。このコントラクトは OSS としての公開 API であり、以下を最重要の不変条件とする。

1. **言語非依存**: コアは TypeScript（npm 配布、`npx halo`）で実装するが、プラグインは任意言語（bash / Python / Node いずれも可）。コントラクトがプロセス境界にあることで、コアの実装言語からプラグインを独立させる。
2. **プロセス境界の固定**: 各プラグインは 1 プロセスとして起動され、stdin/stdout/終了コード以外の通信手段（共有メモリ・グローバル状態・環境変数への副作用の相互依存等）を前提にしない。
3. **ディレクトリ規約による活性化**: `ports/<port名>.d/` に置けば有効、削除すれば無効。数字プレフィックスで実行順を制御する（`conf.d` 方式、§2 各ポート・§6）。

> **v1.5 → v1.8 の変更点**: コアの実装言語が bash（`core/loop.sh` + `core/helpers.sh`）から TypeScript（npm 配布）へ変更された。本書ではコア内部の bash 実装（`helpers.sh` の関数群等）には言及せず、**プロセス境界のコントラクトのみ**を規定する。プラグインの実装言語は引き続き任意であり、本書中の bash 例はプラグイン実装例として有効である。

---

## 1. 9 ポート別 I/O 型

ポートは要件 §4.1 の 9 種（+ 補助 `mcp.d`）である。各ポートの JSON Schema は `packages/contracts` に配置し、TS 型と相互生成する（§6）。`$id` は `https://halo.dev/contracts/<port>.<io>.json` を採る。

すべての入力はプラグインの **stdin** に 1 個の JSON オブジェクトとして渡され、出力を要求するポートは **stdout** に 1 個の JSON オブジェクトを返す。判定は原則として**終了コード**で行う（§3）。

### ポート責務一覧

| # | ポート | 単一/複数 | 出力 stdout | 判定方式 |
|---|---|---|---|---|
| ① | task-source | 単一（先頭のみ） | あり（op=next のみ） | 終了コード |
| ② | context | 複数（全実行・マージ） | あり（fragments） | 常に success 扱い |
| ③ | executor | 単一（先頭のみ） | あり（status） | stdout の status + 終了コード |
| ④ | gate | 複数（全実行・論理 AND） | fail 時のみ | 終了コード（0=pass / 2=fail） |
| ⑤ | sink | 複数（全実行・独立） | なし | ベストエフォート |
| ⑥ | on-fail | 複数（全実行・独立） | なし | ベストエフォート |
| ⑦ | runtime | 束（setup/check/test） | なし | 終了コード（0/2） |
| ⑧ | kind | ポート非該当（`.harness.yml` 宣言） | — | — |
| ⑨ | trigger | 束（install/uninstall/fire） | なし | 終了コード |
| 補 | mcp.d | ポート非該当（構成断片） | — | — |

> ⑧ kind は「タスク種別による runtime・プロンプト切り替え」であり、実行可能プラグインではなく `.harness.yml` の宣言である（§1.8）。ポート番号としては 9 個に数えるが、I/O コントラクトを持つのは 8 ポート + mcp.d である。

---

### 1.1 ① task-source

タスクの取得・完了・失敗報告を担う。入力は `op` による判別（oneOf）。

**入力（stdin）**

| op | 追加フィールド | 意味 |
|---|---|---|
| `next` | なし | 次の ready タスクを 1 件取得 |
| `complete` | `task_id`, `pr_url` | タスク完了を記録 |
| `fail` | `task_id`, `reason`, `retry_count` | タスク失敗を記録 |

**出力（stdout、`op=next` のみ）**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `task_id` | `string \| null` | ✓ | `null` はタスク不在（ready 0 件）。この場合コアは exit 0 で即終了 |
| `title` | `string` | | タスク表題 |
| `body` | `string` | | タスク本文（要件記述。Phase 1〜3 は要件を直接記載） |
| `kind` | `string` | | `kind:<name>` ラベル由来。無指定時は `code`（§1.8） |
| `spec_refs` | `string[]` | | 凍結要件への参照（**kg:// URI**、§4）。loop-audit が実在検証する |
| `write_set` | `string[]` | | Phase 5 の並列衝突回避用（任意） |

`complete` / `fail` は副作用のみで出力を要求しない（exit 0 = 成功）。

**例（入力 op=next / 出力）**

```json
{"op": "next"}
```
```json
{
  "task_id": "T-012",
  "title": "ログイン失敗時のレート制限を追加",
  "body": "...",
  "kind": "code",
  "spec_refs": ["kg://document/auth-login", "kg://decision/rate-limit-policy"]
}
```

**例（タスクなし）**

```json
{"task_id": null}
```

**GitHub Issues アダプタの挙動**（要件 §4.2①）:

- `next`: `gh issue list --label ready` の先頭を取得し `in-progress` ラベルへ付け替え（多重取得防止のロック）。
- `complete`: PR 本文の `Closes #番号` によりマージ時に自動クローズ。
- `fail`: リトライ回数を Issue コメントに記録。同一 Issue で **3 回**（初期値）失敗したら `needs-human` ラベルを付与し人間へエスカレーション（無限ループ遮断）。

**入力 JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/task-source.in.json",
  "title": "task-source input",
  "oneOf": [
    { "type": "object", "required": ["op"],
      "properties": { "op": { "const": "next" } }, "additionalProperties": false },
    { "type": "object", "required": ["op", "task_id", "pr_url"],
      "properties": { "op": { "const": "complete" },
        "task_id": { "type": "string" }, "pr_url": { "type": "string", "format": "uri" } },
      "additionalProperties": false },
    { "type": "object", "required": ["op", "task_id", "reason", "retry_count"],
      "properties": { "op": { "const": "fail" },
        "task_id": { "type": "string" }, "reason": { "type": "string" },
        "retry_count": { "type": "integer", "minimum": 0 } },
      "additionalProperties": false }
  ]
}
```

**出力 JSON Schema（op=next）**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/task-source.out.json",
  "title": "task-source output (op=next)",
  "type": "object",
  "required": ["task_id"],
  "properties": {
    "task_id": { "type": ["string", "null"],
      "description": "null はタスク不在（ready 0 件）。コアは exit 0 で即終了" },
    "title": { "type": "string" },
    "body": { "type": "string" },
    "kind": { "type": "string", "default": "code" },
    "spec_refs": { "type": "array", "items": { "type": "string", "format": "uri" },
      "description": "kg:// URI。loop-audit が実在検証する" },
    "write_set": { "type": "array", "items": { "type": "string" } }
  }
}
```

---

### 1.2 ② context

実行前の静的コンテキスト注入。全 context プラグインが実行され、コアが `fragments` を priority 降順に連結、トークン上限（要件 §3.2 原則4、100k 未満）で切り詰める。

**入力（stdin）**: task-source の `op=next` 出力そのもの（タスク情報）。

**出力（stdout）**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `fragments` | `Fragment[]` | ✓ | コンテキスト断片の配列 |

`Fragment`:

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `source` | `string` | ✓ | `codegraph` / `knowledge` / `recent-failures` 等 |
| `content` | `string` | ✓ | 注入するテキスト |
| `priority` | `integer` | ✓ | 大きいほど優先。コアが降順連結しトークン上限で切詰め |

**例**

```json
{
  "fragments": [
    { "source": "codegraph", "content": "影響範囲: src/order.ts → src/payment.ts", "priority": 10 },
    { "source": "recent-failures", "content": "直近: 30-test で境界値未考慮", "priority": 5 }
  ]
}
```

> **ハイブリッド方式**（要件 §4.2②）: context プラグインは軽い要約（影響範囲サマリ）のみ事前注入し、深掘りは実行中に AI 自身が MCP ツールで取得する。

**出力 JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/context.out.json",
  "title": "context output",
  "type": "object",
  "required": ["fragments"],
  "properties": {
    "fragments": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["source", "content", "priority"],
        "properties": {
          "source": { "type": "string" },
          "content": { "type": "string" },
          "priority": { "type": "integer" }
        },
        "additionalProperties": false
      }
    }
  }
}
```

---

### 1.3 ③ executor

プロンプトの実行。初期アダプタは `claude -p`（headless）。

**入力（stdin）**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `prompt` | `string` | ✓ | 実行プロンプト（context 連結・前回失敗の再注入済み） |
| `workdir` | `string` | ✓ | 使い捨て worktree の絶対パス |
| `budget` | `object` | ✓ | 実行予算 |
| `budget.max_turns` | `integer` | ✓ | ターン上限（初期値 40） |
| `budget.timeout_sec` | `integer` | ✓ | タイムアウト秒（初期値 900） |

**出力（stdout）**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `status` | `"done" \| "stuck" \| "timeout"` | ✓ | `done` 以外はコアの失敗経路へ（on-fail 起動） |
| `summary` | `string` | ✓ | 実行結果の要約 |
| `cost` | `object` | | コスト情報（ccusage 相当）。可観測性用に任意 |

**例（入力 / 出力）**

```json
{
  "prompt": "...",
  "workdir": "/tmp/halo-wt-issue-12",
  "budget": { "max_turns": 40, "timeout_sec": 900 }
}
```
```json
{ "status": "done", "summary": "レート制限ミドルウェアを追加、テスト 3 件追加", "cost": { "usd": 0.42 } }
```

**実行コマンドの骨子**（要件 §4.2③）:

```bash
claude -p "$PROMPT" \
  --mcp-config "$HALO_ROOT/.halo/mcp.json" \
  --strict-mcp-config \
  --allowedTools "mcp__codegraph__*,mcp__knowledge__*,Edit,Write,Bash" \
  --max-turns 40
```

- `--strict-mcp-config` によりハーネス管理の `mcp.json` のみを読む（ツール可視範囲の確定＝再現性・セキュリティ）。
- `mcp.json` は `ports/mcp.d/*.json` をマージして起動時に生成する（§1.10）。
- worktree ライフサイクル（add → runtime 検出 → setup → 実行 → remove）は要件 §4.2③ に従い、bubblewrap の書込許可を `workdir` に一致させる。

**入出力 JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/executor.in.json",
  "title": "executor input",
  "type": "object",
  "required": ["prompt", "workdir", "budget"],
  "properties": {
    "prompt": { "type": "string" },
    "workdir": { "type": "string" },
    "budget": {
      "type": "object",
      "required": ["max_turns", "timeout_sec"],
      "properties": {
        "max_turns": { "type": "integer", "default": 40 },
        "timeout_sec": { "type": "integer", "default": 900 }
      }
    }
  }
}
```
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/executor.out.json",
  "title": "executor output",
  "type": "object",
  "required": ["status", "summary"],
  "properties": {
    "status": { "enum": ["done", "stuck", "timeout"] },
    "summary": { "type": "string" },
    "cost": { "type": "object" }
  }
}
```

---

### 1.4 ④ gate

成果物の合否判定。**判定は出力ではなく終了コード**（exit 0 = pass / exit 2 = fail、Claude Code hooks と同一規約）。コアは gate.d を番号順に全実行し、1 つでも fail なら全体 fail（論理 AND）とし、fail の reason を次イテレーションのプロンプトへ再注入する（§5）。

**入力（stdin）**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `task_id` | `string` | ✓ | タスク ID |
| `workdir` | `string` | ✓ | 検査対象の worktree 絶対パス |
| `changed_files` | `string[]` | ✓ | 変更ファイル一覧 |

**出力（stdout、fail 時のみ）**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `reason` | `string` | ✓ | 例: `coverage 87% < 90%` |
| `hint` | `string` | | 例: `src/order.ts のテスト不足` |
| `gate` | `string` | | 失敗したゲート名（例: `30-test`） |

- gate.d の `10-typecheck` / `20-lint` / `30-test` は実コマンドを持たず、採用 runtime の `check.sh` / `test.sh` へ委譲する薄いラッパー（§1.7）。
- `40-ai-review`（evaluator agent）・`50-loop-audit`（自己改変禁止等の構造検査、要件 §11.1）も同列のゲート。
- evaluator は「懐疑的」に調整するが、correctness / 要件に影響するギャップのみを指摘させ過剰指摘を防ぐ（初期値、要件 §11.2）。

**例（入力 / fail 出力）**

```json
{ "task_id": "T-012", "workdir": "/tmp/halo-wt-issue-12", "changed_files": ["src/order.ts"] }
```
```json
{ "reason": "coverage 87% < 90%", "hint": "src/order.ts のテスト不足", "gate": "30-test" }
```

**入出力 JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/gate.in.json",
  "title": "gate input",
  "type": "object",
  "required": ["task_id", "workdir", "changed_files"],
  "properties": {
    "task_id": { "type": "string" },
    "workdir": { "type": "string" },
    "changed_files": { "type": "array", "items": { "type": "string" } }
  }
}
```
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/gate.out.json",
  "title": "gate output (fail only)",
  "type": "object",
  "required": ["reason"],
  "properties": {
    "reason": { "type": "string" },
    "hint": { "type": "string" },
    "gate": { "type": "string" }
  }
}
```

---

### 1.5 ⑤ sink

合格後の副作用（自律度でフィルタ）。合格後のみ実行され、1 つの sink が失敗しても他の sink は続行する（ベストエフォート）。

**入力（stdin）**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `task_id` | `string` | ✓ | タスク ID |
| `workdir` | `string` | ✓ | 成果物の worktree 絶対パス |
| `summary` | `string` | ✓ | executor の実行要約 |

**出力**: なし（副作用のみ）。

**自律度フィルタ**: 各 sink は `plugin.json` の `minAutonomy` で最低必要自律度を宣言する（§2）。コアは現在の `AUTONOMY` 未満の sink をスキップする。

| AUTONOMY | 有効な sink（初期構成） |
|---|---|
| L1 | `20-progress-log` のみ |
| L2 | `20-progress-log` + `10-git-commit` + `15-create-pr`（**draft PR**） |
| L3 | L2 の全 sink + `15-create-pr`（**通常 PR**、本文に `Closes #番号`） |

自律度レベルは累積的である（L3 ⊇ L2 ⊇ L1）。上位レベルは下位レベルで有効な sink をすべて実行する。

`15-create-pr` の `minAutonomy` は `L2` であり、単一の sink が `AUTONOMY` env を読んで **L2 では draft PR・L3 では通常 PR** を作り分ける（draft/normal をレベル別の別 sink に分割しない）。

初期構成: `10-git-commit` / `15-create-pr` / `20-progress-log`。将来: `30-reindex-graph`（マージ後の再インデックス）、`35-reindex-knowledge`（docs マージ後のナレッジグラフ再インデックス）。

**入力 JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/sink.in.json",
  "title": "sink input",
  "type": "object",
  "required": ["task_id", "workdir", "summary"],
  "properties": {
    "task_id": { "type": "string" },
    "workdir": { "type": "string" },
    "summary": { "type": "string" }
  }
}
```

---

### 1.6 ⑥ on-fail

失敗時の処理。gate fail または executor の stuck/timeout 時に番号順で全実行する（ベストエフォート、個別失敗は他へ波及しない）。

**入力（stdin）**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `task_id` | `string` | ✓ | タスク ID |
| `reason` | `string` | ✓ | 失敗理由 |
| `retry_count` | `integer` | ✓ | リトライ回数（0 以上） |
| `gate` | `string` | | 失敗ゲート名。executor 起因時は `stuck`/`timeout` |
| `workdir` | `string` | | 対象 worktree 絶対パス |

**出力**: なし（副作用のみ）。

初期構成:

- `10-record-failure`: `.halo/failure-catalog.md` にインシデント形式（日時 / タスク / 失敗ゲート / 理由 / 対処）で追記。
- `20-escalate`: `retry_count` が閾値（初期値 3）に達したら `needs-human` ラベル付与と in-progress 解除。
- `30-suggest-sign`: 失敗ログから PROMPT への sign 候補を生成し `.halo/signs-proposed.md` に出力（採用は人間が判断）。

失敗カタログは context.d（`30-recent-failures`）が読み取り、直近の失敗パターンを次イテレーションへ注入する（「失敗 → 記録 → 再注入」の学習経路）。

**入力 JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/on-fail.in.json",
  "title": "on-fail input",
  "type": "object",
  "required": ["task_id", "reason", "retry_count"],
  "properties": {
    "task_id": { "type": "string" },
    "reason": { "type": "string" },
    "retry_count": { "type": "integer", "minimum": 0 },
    "gate": { "type": "string" },
    "workdir": { "type": "string" }
  }
}
```

---

### 1.7 ⑦ runtime

成果物種別固有のセットアップと検査コマンドの提供。**runtime が吸収するのは「言語」ではなく「成果物の種類」**であり、コード（node-pnpm / python-uv / rust）と文書（docs-md）を同列に扱う。他ポートと異なりディレクトリ束だが、各スクリプトのコントラクトは同一（stdin JSON + 終了コード）。

```
ports/runtime.d/<name>/
├── setup.sh    # env 注入 + 依存実体化 + キャッシュ外出し設定
├── check.sh    # 静的検査（exit 2 = fail）
└── test.sh     # 動的検証（exit 2 = fail）
```

- 選択は `.harness.yml` の宣言による（`detect.sh` は持たない）。
- gate.d の `10-typecheck` / `20-lint` / `30-test` は採用 runtime の `check.sh` / `test.sh` へ委譲する薄いラッパー。
- `setup.sh` は依存の実体化を高速に行うこと（node-pnpm ハードリンク / python-uv リンク / rust 共有 `CARGO_TARGET_DIR`）。

**共通入力（setup/check/test）**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `workdir` | `string` | ✓ | 対象 worktree 絶対パス |
| `changed_files` | `string[]` | | check/test の対象絞り込み用（任意） |

**判定**: `check.sh` / `test.sh` は exit 0 = pass / exit 2 = fail。

初期実装:

| runtime | setup | check | test |
|---|---|---|---|
| `node-pnpm` | pnpm `--offline`（ハードリンク共有） | tsc / eslint | vitest |
| `python-uv` | `uv sync`（リンクベース） | mypy / ruff | pytest |
| `rust` | 共有 `CARGO_TARGET_DIR` | cargo check / clippy | cargo test |
| `docs-md` | ほぼ noop | markdownlint + リンク切れ + ADR テンプレート準拠 | 用語集整合チェック |

> **配置制約（WSL2）**: リンクベースの依存共有は同一ファイルシステム内でのみ有効なため、worktree・各ストア・cache は WSL2 の ext4 側（`/home` 配下）に置く。`/mnt/c/` 配下への配置は禁止。

**共通入力 JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/runtime.in.json",
  "title": "runtime script input (setup/check/test 共通)",
  "type": "object",
  "required": ["workdir"],
  "properties": {
    "workdir": { "type": "string" },
    "changed_files": { "type": "array", "items": { "type": "string" } }
  }
}
```

---

### 1.8 ⑧ kind（`.harness.yml`）

kind はポートスクリプトではなく、対象リポジトリのルートに**必須**の `.harness.yml` の宣言である。コアは Issue の `kind:<name>` ラベル（無指定時 `code`）から定義を引き、使用する runtime 群とプロンプトテンプレートを決定する。`.harness.yml` が存在しないリポジトリはタスクを実行せず `needs-human`（暗黙の自動検出は行わない）。

```yaml
# .harness.yml（対象リポジトリのルートに必須・コミット対象）
kinds:
  code:
    runtimes: [node-pnpm]
    prompt: prompts/code.md
  docs:
    runtimes: [docs-md]
    prompt: prompts/docs.md
```

**`.harness.yml` JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/harness-yml.json",
  "title": ".harness.yml",
  "type": "object",
  "required": ["kinds"],
  "properties": {
    "kinds": {
      "type": "object",
      "minProperties": 1,
      "additionalProperties": {
        "type": "object",
        "required": ["runtimes", "prompt"],
        "properties": {
          "runtimes": { "type": "array", "minItems": 1, "items": { "type": "string" },
            "description": "runtime.d 配下のディレクトリ名" },
          "prompt": { "type": "string", "description": "プロンプトテンプレートのパス" }
        }
      }
    }
  }
}
```

---

### 1.9 ⑨ trigger

コアの起動（halo CLI を呼ぶ唯一の入口）。3 スクリプト束で、stdin JSON コントラクトは持たない（引数はプロファイル名のみ）。

```
ports/trigger.d/<name>/
├── install.sh   # トリガーの登録（スケジューラ登録・timer 有効化等）
├── uninstall.sh # 解除
└── fire         # OS へ登録する起動エントリ（node_modules/.bin/halo run <profile> の絶対パス）
```

- `fire` は halo CLI（`node_modules/.bin/halo`）を起動する唯一の入口であり、CLI 以下（プリフライト・loop・ポート群）はトリガーが何であるかを知らない。
- 無人実行では `npx` を経由せず `.bin` への絶対パスを直接叩く（バージョン固定・ネットワーク非依存）。
- 初期実装: `schedule/`（Windows タスクスケジューラによる定時起動）、`polling/`（高頻度定時起動 + 「ready タスク 0 件なら即終了」）。将来: `webhook/` / `manual/`（`fire` 以下は無変更で差し替え可）。

> **起動プロファイル**（要件 §4.4）はループの実行設定（自律度・上限・タスクフィルタ・予算）を束ねた環境変数ファイル群であり、`.halo/profiles/` に置く。トリガーは `halo run <profile>` をプロファイル名指定で起動するだけとする。プロファイルの内部形式は D2/D3 の管轄とし、本書のコントラクト対象外とする。

---

### 1.10 補 mcp.d

ポートではなく executor に渡す MCP 構成断片。`ports/mcp.d/*.json` をマージして起動時に `.halo/mcp.json` を生成し、`claude -p --mcp-config <mcp.json> --strict-mcp-config` で読ませる。各断片は MCP サーバー定義オブジェクト（`mcpServers` キー配下）に準拠する。

```json
{
  "mcpServers": {
    "codegraph": { "command": "...", "args": ["..."] }
  }
}
```

---

## 2. plugin.json マニフェスト仕様

各プラグインは自身のディレクトリに `plugin.json` を持ち、コアがプラグインを起動する際のメタデータを宣言する。

> **v1.8 での位置づけ**: v1.5-era の設計書 01 は自律度宣言を「sink ファイル冒頭のメタコメント `# min-autonomy: L3`」で表現していた。v1.8 では **`plugin.json` の構造化フィールド `minAutonomy`** に統一する（bash 以外の言語でも宣言でき、機械検証しやすいため）。メタコメント方式は互換のための代替表現として D5 プラグイン開発ガイドで扱う。

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `name` | `string` | ✓ | プラグイン識別子（`@halo/plugin-*` 等） |
| `version` | `string` | ✓ | プラグイン自身の semver |
| `port` | `string` | ✓ | 属するポート（`task-source` / `context` / `executor` / `gate` / `sink` / `on-fail` / `runtime` / `trigger`） |
| `exec` | `string` | ✓ | 実行体への相対パス（bash / node / python いずれも可） |
| `order` | `integer` | | 実行順（数字プレフィックス相当。省略時はファイル名の数字プレフィックスに従う） |
| `minAutonomy` | `"L1" \| "L2" \| "L3"` | | sink 等の自律度フィルタ。未宣言時は最も安全側（= L3 とみなし L1/L2 ではスキップ） |
| `timeoutSec` | `integer` | | 当該プラグインの実行タイムアウト（初期値はポート既定に従う） |
| `env` | `object` | | 起動時に注入する環境変数（キー = 変数名、値 = 既定値 or 参照） |

**例（sink プラグイン）**

```json
{
  "name": "@halo/plugin-sink-create-pr",
  "version": "1.0.0",
  "port": "sink",
  "exec": "./15-create-pr.sh",
  "order": 15,
  "minAutonomy": "L2",
  "timeoutSec": 120,
  "env": { "GH_TOKEN": "${HALO_GH_TOKEN}" }
}
```

> `15-create-pr` は `minAutonomy: "L2"` で有効化され、`AUTONOMY` env を読んで L2 では draft PR・L3 では通常 PR を作り分ける（単一 sink で分岐）。

**`plugin.json` JSON Schema**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://halo.dev/contracts/plugin.json",
  "title": "plugin manifest",
  "type": "object",
  "required": ["name", "version", "port", "exec"],
  "properties": {
    "name": { "type": "string" },
    "version": { "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$" },
    "port": { "enum": ["task-source", "context", "executor", "gate",
      "sink", "on-fail", "runtime", "trigger"] },
    "exec": { "type": "string" },
    "order": { "type": "integer" },
    "minAutonomy": { "enum": ["L1", "L2", "L3"] },
    "timeoutSec": { "type": "integer", "minimum": 1 },
    "env": { "type": "object", "additionalProperties": { "type": "string" } }
  },
  "additionalProperties": false
}
```

> runtime / trigger はディレクトリ束（固定名スクリプト）であり、`exec` は束のエントリ（runtime は省略可、trigger は `fire`）を指す。番号プレフィックスは付けず、選択は `.harness.yml` の宣言（runtime）/ trigger の install（trigger）による。

---

## 3. 実行規約

すべてのプラグインは以下の統一規約で実行される。

### 3.1 終了コード

| 終了コード | 意味 | コアの扱い |
|---|---|---|
| `0` | pass / 正常 | 成功として続行 |
| `2` | fail | 判定的失敗（gate: 差し戻し、runtime check/test: fail） |
| その他（`1` 含む） | エラー（異常終了） | 安全側に倒して fail 扱い。プラグイン不在（構成不備）はコア停止 |

- **gate / runtime check・test**: exit 0 = pass、exit 2 = fail（Claude Code hooks と同一規約）。exit 2 以外の異常終了も安全側に倒して fail とみなす。
- **task-source `next`**: 「タスクなし」を意図する `{"task_id": null}` + exit 0 は正常。
- **executor**: 判定は stdout の `status` で行い（`done` 以外は失敗経路）、プロセス自体の異常終了はエラー扱い。
- **sink / on-fail**: ベストエフォート。個別プラグインの非 0 終了は他プラグインの実行を妨げない。

### 3.2 stdin / stdout

- **stdin**: 各プラグインへは 1 個の JSON オブジェクトを stdin で渡す。
- **stdout**: 出力を要求するポート（task-source next / context / executor / gate fail 時）は stdout に 1 個の JSON オブジェクトを返す。**stdout は JSON 専用チャネル**であり、デバッグ出力等を混在させてはならない（パース失敗の原因）。

### 3.3 stderr の扱い

- **stderr は診断・ログ専用**とし、コントラクト上の意味を持たない。
- コアはプラグインの stderr を捕捉し、当該イテレーションの構造化ログ（`.halo/logs/iter_N.json`）へ退避する（要件 §6.3）。
- stderr の内容で合否は判定しない（判定は終了コード / status）。プラグインは人間可読な進捗・警告を stderr へ書いてよい。

---

## 4. kg:// URI 形式（spec_refs のノード ID 参照）

`spec_refs` はナレッジグラフの文書/決定ノード ID を指す**ファイルパスではない**参照であり、`kg://` スキームで表現する（要件 §4.2①）。

### 4.1 形式

```
kg://<node-type>/<node-id>
```

| 要素 | 説明 | 例 |
|---|---|---|
| `<node-type>` | ナレッジグラフのノード種別（要件 §11.1 の 5 種に対応） | `document` / `decision` / `term` / `context` / `aggregate` |
| `<node-id>` | 種別内で一意のスラグ（kebab-case 推奨） | `auth-login` / `rate-limit-policy` |

**ノード種別**（要件 §11.1 のナレッジグラフ 5 種）:

| node-type | 対応ノード | 用途 |
|---|---|---|
| `context` | 境界づけられたコンテキスト | 対象ドメインの境界参照 |
| `aggregate` | 集約 | 実装コンポーネントとの橋渡し起点 |
| `term` | ドメイン用語 | ユビキタス言語の語彙参照 |
| `document` | 文書 | 設計書・要件・受け入れ条件の参照 |
| `decision` | 決定 | ADR 等の決定ノード参照 |

**例**

```
kg://document/auth-login
kg://decision/rate-limit-policy
kg://aggregate/order
```

### 4.2 検証

- **実在検証**: loop-audit（gate `50-loop-audit`）がループ開始時にグラフを照会し、`spec_refs` の各 kg:// URI が実在するノードを指すことを検証する（要件 §11.1）。実在しない参照は fail（構造系チェック①）。
- **解決実装**: kg:// URI からグラフノードへの解決は私有プラグイン（knowledge MCP）の管轄であり、D6 グラフ設計書で規定する。コントラクトとしては**形式（`kg://<type>/<id>`）と「グラフノードを指す」という意味のみ**を規定する。

> **保留**（要件 §9 経過措置）: グラフ導入前（Phase 1〜3）は `spec_refs` を空とし、要件は Issue 本文に直接記述する。Phase 4 のナレッジグラフ導入をもって kg:// 参照と凍結性担保（要件 §5.3）が有効化される。本節の node-type の網羅性・追加規則は Phase 4 着手時に D6 と整合させる（**保留**）。

---

## 5. STUCK マーカー規約

executor が「これ以上進められない」状態（スタック）を検出した場合の停止規約（要件 §6.2）。

### 5.1 executor 出力による表明

executor は自らのスタックを stdout の `status` で表明する。

| status | 意味 | コアの扱い |
|---|---|---|
| `stuck` | 論理的な行き詰まり（同一箇所の反復・矛盾する制約等） | else 節へ落とし on-fail 起動 |
| `timeout` | `budget.timeout_sec` 超過 | 同上 |

`status != done` はコアの失敗経路（on-fail 起動）へ落ち、`retry_count` が加算される。同一 Issue が閾値（初期値 3）回 fail すると on-fail `20-escalate` が `needs-human` を付与し再注入ループを打ち切る（無限ループ遮断）。

### 5.2 STUCK マーカー（エージェント内からの表明）

エージェント（claude -p）が実行中にスタックを自己申告する手段として、**成果物内に STUCK マーカーを出力**する規約を設ける。executor アダプタはこれを検出して `status: "stuck"` に変換する。

- **マーカー形式**: 実行ログ（stdout の最終メッセージ）または worktree 内の `STUCK` ファイルに、理由を伴って出力する。
- **推奨表現**: 1 行目に `STUCK:` プレフィックス + 理由（例: `STUCK: 依存パッケージのバージョン矛盾を解消できない`）。
- executor アダプタは STUCK 検出時、`summary` に理由を格納し `status: "stuck"` を返す。

> **初期値/保留**: マーカーの厳密な検出方法（最終メッセージのパターン / ファイル存在）は executor アダプタの実装詳細であり、Phase 1 の実装から抽出して確定させる（D2 コア詳細設計・executor アダプタ実装で規定）。本書ではコントラクトとして「executor は stuck を `status: "stuck"` で表明する」ことのみを規定する。

> **キルスイッチとの区別**: `.halo/STOP` ファイル（要件 §4.4）は**人間が**ループを停止させるキルスイッチであり、STUCK マーカー（エージェント/executor が自己申告する行き詰まり）とは別機構である。STOP は各イテレーション冒頭でコアが確認し即 exit 0 する。

---

## 6. JSON Schema 自動生成と非 TS プラグインでの検証

### 6.1 生成の仕組み（TS 型 → JSON Schema 単一ソース）

- コントラクトの**単一の真実の源は `packages/contracts` の TypeScript 型定義**とする。JSON Schema は型定義から自動生成し、両者の乖離を構造的に防ぐ。
- 生成物（`*.json` Schema、Draft 2020-12）は `packages/contracts` に同梱し、公開パッケージの一部として配布する（`$id` は `https://halo.dev/contracts/<port>.<io>.json`）。
- 生成には TS 型 → JSON Schema 変換（例: `ts-json-schema-generator` 相当）を用いる。生成コマンドと CI での乖離検出（生成物がコミット済みと一致するか）は D8 テスト戦略書で規定する。
- TS プラグイン・コアは型定義を直接 import して**コンパイル時**に契約を守る。

### 6.2 非 TS プラグインでの検証

プラグインは任意言語であるため、bash / Python 等の非 TS プラグインは**実行時に JSON Schema で自己検証**する経路を提供する。

| 手段 | 説明 |
|---|---|
| 配布 Schema の参照 | プラグインは `packages/contracts` 同梱の `*.json` Schema を参照し、任意の JSON Schema バリデータ（例: `ajv` CLI、Python `jsonschema`、`check-jsonschema` 等）で stdin/stdout を検証できる |
| contract test | 各見本プラグインの I/O を配布 Schema で検証する contract test を用意する（入力例・期待出力例を Schema に通す）。全見本プラグインが対象（D8 テスト戦略書・D5 プラグイン開発ガイドで規定） |
| コア側の境界検証 | コアはプラグインの stdout を受領した時点で該当出力 Schema に照らして検証し、不正 JSON / スキーマ違反は当該ポートの規約（context: スキップ、gate: 安全側 fail 等）に従って扱う |

> **設計意図**: TS 側はコンパイル時、非 TS 側は実行時（配布 Schema + 汎用バリデータ）で同一のコントラクトを守る。これにより「コアは TS、プラグインは任意言語」（要件 §2.1・§3.2 原則2）を型安全性を犠牲にせず両立させる。生成・検証の具体手順・CI 統合は D8 に委ね、本書は**単一ソース（TS 型）と配布形態（同梱 JSON Schema）**を規定する。

---

## 7. 変更管理（semver ポリシー）

本書が定義するコントラクトは HALO の公開 API であり、**全設計文書中で最も保守的に変更管理する**（要件 §8.1 の公開境界・設計書一覧 D1 の位置づけ）。

| 変更種別 | semver | 例 |
|---|---|---|
| **破壊的変更 = メジャー** | MAJOR | 必須フィールドの追加・削除・改名、型の変更、終了コード規約の変更、ポートの削除、kg:// 形式の非互換変更 |
| 後方互換な機能追加 = マイナー | MINOR | 任意フィールドの追加、新ポート・新 status 値の追加（既存を壊さない範囲）、`plugin.json` 任意フィールド追加 |
| 後方互換な修正 = パッチ | PATCH | 説明文・例の修正、Schema の記述明確化（意味を変えない） |

- コントラクトのバージョンは `packages/contracts` の package version と一致させ、本書の文書バージョンと対応付ける。
- 破壊的変更は既存の全プラグイン（見本 4 種を含む）と対象リポジトリに影響するため、メジャー更新時は移行ガイドを D5 で提供する。
- 初期値/保留として本書がマークした項目（数値パラメータ、kg:// の node-type 追加規則、STUCK マーカーの検出詳細）の確定は、**意味を変えない範囲ならパッチ、契約を変えるならマイナー以上**として扱う。

---

## 付録 A. コントラクト一覧（`packages/contracts` 配置）

| ファイル | ポート | I/O |
|---|---|---|
| `task-source.in.json` | ① | 入力（oneOf: next/complete/fail） |
| `task-source.out.json` | ① | 出力（op=next） |
| `context.out.json` | ② | 出力（fragments） |
| `executor.in.json` | ③ | 入力 |
| `executor.out.json` | ③ | 出力 |
| `gate.in.json` | ④ | 入力 |
| `gate.out.json` | ④ | 出力（fail のみ） |
| `sink.in.json` | ⑤ | 入力 |
| `on-fail.in.json` | ⑥ | 入力 |
| `runtime.in.json` | ⑦ | 入力（setup/check/test 共通） |
| `harness-yml.json` | ⑧ | `.harness.yml` |
| `plugin.json`（schema） | 全 | マニフェスト |

> context の入力は task-source の `op=next` 出力そのものであり専用 Schema を持たない。sink / on-fail / runtime / trigger は副作用中心のため出力 Schema を持たない。trigger / mcp.d は stdin JSON コントラクトを持たない（§1.9・§1.10）。

## 付録 B. 用語

| 用語 | 定義 |
|---|---|
| ポート | コアと外部の接点。stdin/stdout JSON + 終了コードで通信する抽象境界 |
| プラグイン（アダプタ） | ポートの具体実装。`ports/<port>.d/` に配置し活性化 |
| 使い捨て worktree | AI 作業用の一時 git worktree（`$TMPDIR/halo-wt-issue-N/`）。fail 時は削除 |
| 自律度（AUTONOMY） | L1（報告のみ）/ L2（commit + draft PR）/ L3（無人 PR 作成）。sink フィルタで実装 |
| kg:// URI | ナレッジグラフのノード ID 参照形式（§4） |
| STUCK | executor / エージェントが行き詰まりを自己申告する状態表明（§5） |
