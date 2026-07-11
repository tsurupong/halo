# 詳細設計書 05: コンテキスト層（グラフ基盤）

> **v1.8 追随改訂済み（コア TS 化・specs/ 廃止を反映）**。プリフライト/再インデックスを駆動する `run.sh` は `packages/cli`（`halo run`）の起動エントリを指す。v1.8 は要件・仕様を **specs/ ディレクトリではなくナレッジグラフに一元管理**し、凍結性はグラフ書込制御（実行中 read-only / 書込 2 経路 / ハッシュ照合、D4 §5）で担保する。本書のグラフ基盤はその中核。

**対象**: HALO コンテキスト層（`context` ポートおよびグラフ基盤）
**典拠**: HALO要件定義書 v1.8 §5・§11.1、[ADR-0003](../adr/0003-kuzudb-merge-driven-reindex.md)、[ADR-0005](../adr/0005-knowledge-graph-schema-granularity.md)、ADR-0010（コア TypeScript 化）
**位置づけ**: 本書は要件定義書 §5 を実装レベルまで詳細化したものであり、要件定義書と矛盾する内容は含まない。数値・細部で要件に未定義の箇所は「初期値（仮）」と明記する。

---

## 0. スコープと全体像

コンテキスト層は 2 種のグラフ（コードグラフ / ナレッジグラフ）を持ち、いずれも KuzuDB（組み込み・ファイル1個・サーバー不要）をバックエンドとする。両グラフは `graphs/code.kuzu` と `graphs/knowledge.kuzu` の 2 ファイルに分離して格納する。

```
┌─────────────────────────── コンテキスト層 ───────────────────────────┐
│                                                                      │
│  graphs/code.kuzu           graphs/knowledge.kuzu                    │
│  ├ tree-sitter 自動生成      ├ 人間設計・手書き Cypher 投入            │
│  └ CGC 経由 MCP: codegraph   └ 自作 MCP: knowledge                    │
│         │                            │                               │
│         │  IMPLEMENTED_BY（集約→ディレクトリパス）で論理的に橋渡し    │
│         ▼                            ▼                               │
│  ┌──────────────────── context.d プラグイン ─────────────────────┐   │
│  │ 10-codegraph / 20-knowledge / 30-recent-failures             │   │
│  │  → fragments を priority 順連結・トークン上限で切り詰め       │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

責務分離（ADR-0005）:
- **コードグラフ** = 自動生成領域。エンティティ・フィールド粒度の構造情報。
- **ナレッジグラフ** = 人間設計領域。設計意図・ユビキタス言語・決定という暗黙知。
- 両者は `IMPLEMENTED_BY`（集約ノード → ディレクトリパス）でのみ接続し、フィールドレベルの二重管理を避ける。

---

## 1. コードグラフ（CodeGraphContext + KuzuDB）

### 1.1 構成

| 項目 | 内容 |
|---|---|
| ツール | CodeGraphContext（CGC） |
| バックエンド | KuzuDB（`graphs/code.kuzu`） |
| 生成方式 | tree-sitter による静的解析。**LLM API 不使用・ローカル完結**（コスト0・オフライン可） |
| 提供ツール | `find_code` / `analyze_code_relationships` / `find_dead_code` / `execute_cypher_query` |
| MCP 定義 | `ports/mcp.d/10-codegraph.json` |

tree-sitter を使う理由: 構文解析のみで呼び出し関係・定義位置・デッドコードを抽出でき、LLM 推論を伴わないため決定的かつ無料。ナレッジグラフ側（人間設計）と対照的に、コードグラフは「機械が事実として読み取れるもの」だけを扱う。

### 1.2 再インデックスのタイミング（マージ駆動 + プリフライト = 案A）

ADR-0003 の決定に従い、`watch` モードは採用しない（監視対象が main ではなく生滅する worktree になり、グラフが中間状態で汚染されるため使い捨て worktree 方式と構造的に両立しない）。

再インデックスの発火点は **ループ起動時のプリフライト1箇所のみ**とする。

```
run.sh 起動
  └─ プリフライト（2段のうち第1段: グラフ鮮度判定）
       IF  main の現在 HEAD != graphs/code.kuzu に記録された last_indexed_sha
       THEN 再インデックス実行（main 基準・単一プロセス・書き込みはここ1回のみ）
            → last_indexed_sha を main HEAD に更新
       ELSE スキップ（陳腐化していない）
  └─ ループ本体開始（以降グラフは不変）
```

判定に使うメタデータ:

| キー | 内容 | 保存先 |
|---|---|---|
| `last_indexed_sha` | 前回インデックスした main の commit SHA | code.kuzu 内メタノード or `graphs/.code.meta` |
| `indexed_at` | 前回インデックス時刻（ISO8601） | 同上 |
| `schema_version` | コードグラフスキーマ版（tree-sitter 抽出ルール版） | 同上 |

再インデックスは差分ではなく **main 基準のフルインデックスを既定**とする（KuzuDB の単一プロセス書き込み制約下で状態の一貫性を最優先。差分インデックスは Phase 2 以降の最適化候補=保留）。

### 1.3 排他方式（read-only スナップショット共有）

KuzuDB は単一プロセスからの書き込みを前提とする。並列 worktree からの同時書き込みは構造的に禁止する。

**方式**: 「main ブランチ基準の read-only スナップショット」を全 worktree で共有する。

| フェーズ | 主体 | code.kuzu へのアクセス | 排他手段 |
|---|---|---|---|
| プリフライト | run.sh（親プロセス単一） | 読み書き（再インデックス） | `flock`（`run.sh` 標準装備のロックと同一。多重起動防止と共用） |
| ループ実行中 | 各 worktree のエージェント | **read-only** のみ | 書き込み経路を持たない（MCP は参照系ツールのみ公開） |

要点:
1. 書き込みはプリフライト時の1回のみ。`flock` で run.sh 多重起動を排除しているため、書き込みプロセスは同時に高々1つ。
2. ループ実行中は全 worktree が同一の不変スナップショットを read-only で共有する。これにより **イテレーション間のコンテキスト再現性**も担保される（同じ入力→同じグラフ→同じ context）。
3. read-only 共有の実体は KuzuDB を read-only モードで開くこと。ファイルコピーは不要（不変前提のため）。書き込みを試みる MCP ツールは `10-codegraph.json` に含めない。

### 1.4 陳腐化の緩和（双方向自動反映）

マージ〜次回プリフライトの間はグラフが陳腐化する（ADR-0003 Negative）。これを以下で緩和する。

| 起点 | 反映経路 |
|---|---|
| docs マージ | sink `35-reindex-knowledge.sh` がナレッジグラフを更新 |
| code 変更 | 次回プリフライトで陳腐化検出 → `kind:docs` タスクを自動起票（設計書と実装の乖離検知） |

---

## 2. ナレッジグラフ（スキーマ定義）

### 2.1 スキーマ粒度（確定 = ADR-0005 / §11.1）

ノード **5 種**・エッジ **5 種**で開始し、エンティティ・フィールドレベルには下ろさない。橋渡しエッジ `IMPLEMENTED_BY` は集約→ディレクトリパスで張る。

**ノード5種**: 境界づけられたコンテキスト / 集約 / ドメイン用語 / 文書 / 決定
**エッジ5種**: `BELONGS_TO` / `DEFINED_IN` / `IMPLEMENTED_BY` / `SUPERSEDES` / `AFFECTS`

### 2.2 Cypher DDL 相当スキーマ定義（KuzuDB）

KuzuDB は構造化スキーマを要求するため、ノードは `NODE TABLE`、エッジは `REL TABLE` として定義する（プロパティグラフの型付きスキーマ）。以下は `graphs/knowledge.kuzu` の初期 DDL である。手書き Cypher（KuzuDB DDL）で投入する。

```cypher
-- ============ ノードテーブル（5種）============

-- ① 境界づけられたコンテキスト（Bounded Context）
CREATE NODE TABLE BoundedContext (
    id        STRING,        -- 一意識別子（例: "billing"）
    name      STRING,        -- 表示名（例: "課金コンテキスト"）
    summary   STRING,        -- 概要
    PRIMARY KEY (id)
);

-- ② 集約（Aggregate）: 橋渡しの起点。dir_path が実装へのリンク
CREATE NODE TABLE Aggregate (
    id        STRING,
    name      STRING,        -- 集約名（例: "Invoice"）
    dir_path  STRING,        -- 実装ディレクトリパス（IMPLEMENTED_BY の根拠）
    summary   STRING,
    PRIMARY KEY (id)
);

-- ③ ドメイン用語（ユビキタス言語）
CREATE NODE TABLE DomainTerm (
    id          STRING,
    term        STRING,      -- 用語（正）
    definition  STRING,      -- 定義
    synonyms    STRING,      -- 許容同義語（カンマ区切り。用語集整合チェック用）
    deprecated  STRING,      -- 禁止語（カンマ区切り。禁止語違反は block 対象）
    PRIMARY KEY (id)
);

-- ④ 文書（設計書 / ADR / 要件）
CREATE NODE TABLE Document (
    id        STRING,
    title     STRING,
    path      STRING,        -- リポジトリ相対パス（例: "docs/design/05-...md"）
    doc_type  STRING,        -- "design" | "adr" | "requirement" | "glossary"
    body_hash STRING,        -- 投入時点の原本ハッシュ（陳腐化検出・凍結性照合用）
    PRIMARY KEY (id)
);

-- ⑤ 決定（Decision / ADR の意思決定単位）
CREATE NODE TABLE Decision (
    id        STRING,        -- 例: "adr-0005"
    title     STRING,
    status    STRING,        -- "accepted" | "superseded" | "proposed"
    date      STRING,        -- ISO8601
    PRIMARY KEY (id)
);

-- ============ エッジテーブル（5種）============

-- BELONGS_TO: 集約 → 境界づけられたコンテキスト（帰属）
CREATE REL TABLE BELONGS_TO (
    FROM Aggregate TO BoundedContext
);

-- DEFINED_IN: ドメイン用語/決定 → 文書（どの文書で定義されたか）
CREATE REL TABLE DEFINED_IN (
    FROM DomainTerm TO Document,
    FROM Decision   TO Document
);

-- IMPLEMENTED_BY: 集約 → ディレクトリパス（橋渡し。設計⇔実装）
--   対向は Aggregate.dir_path が指すコード側。ナレッジグラフ内は
--   確度メタを保持する自己参照を避け、プロパティで持つ。
CREATE REL TABLE IMPLEMENTED_BY (
    FROM Aggregate TO Aggregate,   -- 論理上の張替え耐性のため集約起点で保持
    dir_path   STRING,             -- 実装ディレクトリ（冗長保持=検索高速化）
    confidence STRING,             -- "explicit" | "inferred" | "reviewed"
    source     STRING              -- 抽出根拠（"link" | "ai" | "human"）
);

-- SUPERSEDES: 決定 → 決定（新決定が旧決定を廃止）
CREATE REL TABLE SUPERSEDES (
    FROM Decision TO Decision
);

-- AFFECTS: 決定 → 境界づけられたコンテキスト/集約/文書（影響範囲）
CREATE REL TABLE AFFECTS (
    FROM Decision TO BoundedContext,
    FROM Decision TO Aggregate,
    FROM Decision TO Document
);
```

> 補足: KuzuDB は 1 つの `REL TABLE` に複数の `FROM ... TO ...` ペアを宣言できる（マルチペア関係）。`DEFINED_IN` / `AFFECTS` はこれを用いて 1 テーブルで複数の起点・終点型を許容する。`IMPLEMENTED_BY` の対向は本来コード側ノードだが、コードグラフは別 DB（`code.kuzu`）にあるため DB をまたぐ物理エッジは張れない。よって橋渡しは **`Aggregate.dir_path` 文字列を鍵にした論理結合**とし、`IMPLEMENTED_BY` エッジ自身は確度メタ（`confidence` / `source`）を保持するために集約起点で持つ（§4 の trace_spec_to_code はこの `dir_path` を codegraph 側クエリのパラメータに渡してホップする）。

### 2.3 スキーマ拡張の方針

- エッジ追加は「開始セット」からの拡張として許容する（ADR-0005）。
- **ノード種の追加は再検討事項**（安易に増やさない）。5 種で表現しきれない知識が出現した時点で ADR を起票する。

---

## 3. 自作 knowledge MCP のツール入出力仕様

MCP 定義は `ports/mcp.d/20-knowledge.json`、サーバー実体は `mcp-knowledge/`。初期ツールは **2 つ**（`search_docs` / `trace_spec_to_code`）に絞る（ADR-0003: Neo4j 移行時の Cypher 方言差の移行面を最小化）。両ツールとも **read-only**（グラフ書き込み経路を一切持たない）。

### 3.1 `search_docs`

用途: 自然言語 or 用語から関連文書・用語・決定ノードを検索する入口ツール。

**入力**:
```json
{
  "query": "課金の締め処理の設計意図",   // 必須: 検索語（自然言語 or 用語）
  "node_types": ["Document", "Decision", "DomainTerm"], // 任意: 絞り込み。既定は全ノード種
  "limit": 10                            // 任意: 既定 10（初期値・仮）
}
```

**出力**（`fragments` ではなく検索結果。返却値に「次に呼ぶツール引数」を埋め込む=§4）:
```json
{
  "results": [
    {
      "node_type": "Aggregate",
      "id": "invoice",
      "name": "Invoice",
      "summary": "請求書集約。締め処理の主体。",
      "path": null,
      "next_tools": [
        {
          "tool": "trace_spec_to_code",
          "args": { "aggregate_id": "invoice" },
          "why": "この集約の実装ディレクトリと関連コードへ辿る"
        }
      ]
    },
    {
      "node_type": "Decision",
      "id": "adr-0005",
      "title": "ナレッジグラフのスキーマ粒度",
      "status": "accepted",
      "path": "docs/adr/0005-...md",
      "next_tools": [
        {
          "tool": "search_docs",
          "args": { "query": "IMPLEMENTED_BY 橋渡し", "node_types": ["Aggregate"] },
          "why": "この決定が AFFECTS する集約を辿る"
        }
      ]
    }
  ],
  "truncated": false
}
```

検索は決定的（§5.3: 各ステップは決定的、オーケストレーションのみ AI）。内部実装は用語完全一致 → 部分一致 → 概要 substring の順のフォールバック（LLM 埋め込み検索は初期採用しない=ローカル完結優先）。

### 3.2 `trace_spec_to_code`

用途: 集約ノード（または文書）を起点に、橋渡しエッジ `IMPLEMENTED_BY` を辿って実装ディレクトリ／コードシンボルへ到達する。ナレッジグラフ→コードグラフのホップを担う。

**入力**:
```json
{
  "aggregate_id": "invoice",     // どちらか必須（集約起点）
  "document_id": null,           // または文書起点（DEFINED_IN 逆引き→集約）
  "resolve_symbols": true        // 任意: true なら codegraph へ委譲しシンボルまで解決（既定 false）
}
```

**出力**:
```json
{
  "aggregate": { "id": "invoice", "name": "Invoice" },
  "implemented_by": [
    {
      "dir_path": "src/billing/invoice/",
      "confidence": "reviewed",     // explicit | inferred | reviewed
      "source": "human"
    }
  ],
  "code_symbols": [                 // resolve_symbols=true のときのみ
    { "symbol": "InvoiceService", "file": "src/billing/invoice/service.ts" }
  ],
  "next_tools": [
    {
      "tool": "codegraph.analyze_code_relationships",
      "args": { "path": "src/billing/invoice/" },
      "why": "実装ディレクトリの呼び出し関係を深掘りする（コードグラフ側へ）"
    }
  ]
}
```

`resolve_symbols=true` のとき、本ツールは `dir_path` を引数に codegraph MCP（別グラフ）へ委譲する。ここが 2 グラフの論理結合点である（§2.2 補足）。

---

## 4. Agentic Graph RAG: runbook 方式の具体例

方針（§5.3）: グラフ構築は人間設計、**クエリ側のみエージェント化**。各ツールの返却値に「次に呼ぶべきツールの引数」を埋め込み、返却値そのものを runbook（次アクション付き手順書）にする。検索の各ステップは決定的、マルチホップのオーケストレーションのみ AI に委ねる。

### 4.1 マルチホップ探索の具体例

タスク例:「請求書の締め処理を修正する Issue に着手。関連する設計意図と実装箇所を把握したい。」

```
[Hop 1] search_docs({query:"請求書 締め処理"})
  → results[0] = Aggregate "invoice"
     next_tools = [ trace_spec_to_code({aggregate_id:"invoice"}) ]   ← 引数が埋め込み済み
  → results[1] = Decision "adr-0005"
     next_tools = [ search_docs({query:"...", node_types:["Aggregate"]}) ]

[Hop 2] （AI は next_tools をそのまま実行）
  trace_spec_to_code({aggregate_id:"invoice"})
  → implemented_by = [ "src/billing/invoice/" (confidence:reviewed) ]
     next_tools = [ codegraph.analyze_code_relationships({path:"src/billing/invoice/"}) ]

[Hop 3]
  codegraph.analyze_code_relationships({path:"src/billing/invoice/"})
  → 呼び出し関係・依存を取得（コードグラフ側・read-only スナップショット）

→ AI は「設計意図（ADR）＋実装ディレクトリ＋呼び出し関係」を自律的に組み立てて把握
```

各ホップの入力引数は前段の `next_tools[].args` として**サーバー側が構築済み**であり、AI は「どの next_tool を選ぶか」だけを判断する。引数の値を AI に発明させない（決定性の担保）。

### 4.2 context.d との関係（ハイブリッド方式）

要件定義書 §4.2 ②のハイブリッド方式に従い、context プラグイン（§6）は**軽い要約のみ事前注入**し、上記マルチホップの深掘りは**実行中に AI 自身が MCP ツールで取得**する。事前注入で全グラフを展開しない（トークン浪費と再現性低下を避ける）。

---

## 5. IMPLEMENTED_BY 橋渡しエッジの抽出手順

橋渡しエッジ（設計書ノード ⇔ 実装コンポーネント）の対応付けが最大の価値源泉（§5.4）。抽出は 2 段階。

### 5.1 第1段: 明示リンクの機械抽出（confidence=explicit / source=link）

設計書内の明示的なファイルパス記載から機械抽出する。

```
1. Document ノードの path が指す Markdown を走査
2. 実装パス表記を正規表現で抽出:
     - コードスパン内のパス:  `src/billing/invoice/`
     - 「実装: src/...」形式の明示記載
     - Aggregate.dir_path と前方一致するパス
3. 抽出パスと Aggregate.dir_path を突合
     → 一致すれば IMPLEMENTED_BY(confidence="explicit", source="link") を張る
```

この段は LLM 不使用・決定的。sink `35-reindex-knowledge.sh` から docs マージ後に再実行される。

### 5.2 第2段: 不足分の AI 推定 + 人間レビュー（confidence=inferred → reviewed / source=ai → human）

明示リンクで埋まらない集約について AI 推定で候補を出し、**人間レビューを経て確定**する。

```
1. IMPLEMENTED_BY を持たない Aggregate を列挙
2. AI が集約名・summary と codegraph のディレクトリ／シンボル名の類似から候補 dir_path を提案
     → IMPLEMENTED_BY(confidence="inferred", source="ai") として仮登録
3. 人間レビュー（needs-human）: 妥当なら confidence を "reviewed"、source を "human" に更新。
   誤りならエッジ削除。
```

要点:
- AI 推定エッジ（`inferred`）は品質ゲートの根拠として**そのままは使わない**。`reviewed` へ昇格したものだけを機械ゲートの正とする（ADR-0005: グラフを品質ゲートの基盤に使うため型と確度が要る）。
- ディレクトリ構成のリファクタ時は `IMPLEMENTED_BY` の張り替えが必要（ADR-0005 Negative）。張替えは第1段の再抽出で自動追随する（explicit 分）ため、明示リンクを設計書に書く運用を推奨。

---

## 6. context.d プラグインの fragments 出力仕様

`ports/context.d/` は context ポートの実装。コアは全プラグインを順に実行し、`fragments` を **priority 順に連結**、**トークン上限で切り詰める**（§4.2 ②）。

### 6.1 プラグイン構成

| ファイル | source | 役割 | 既定 priority |
|---|---|---|---|
| `10-codegraph.sh` | `codegraph` | コードグラフから影響範囲サマリ（軽い要約）を注入 | 10 |
| `20-knowledge.sh` | `knowledge` | ナレッジグラフから関連設計意図・用語・決定の要約を注入 | 20 |
| `30-recent-failures.sh` | `recent-failures` | `failure-catalog.md` / logs から同種タスクの直近失敗を注入 | 30 |

> 既存の要件定義書 §8 のディレクトリ図では `context.d/` に `10-codegraph.sh` と `20-knowledge.sh` の 2 つが例示されている。本設計はこれを踏襲しつつ `30-recent-failures.sh` を追加する（retry 時の context 注入戦略変更=§11.2 の拡張余地に対応。要件と矛盾せず拡張の範囲内）。

### 6.2 各プラグインの出力（fragment）仕様

各プラグインは要件定義書 §4.2 ②の契約に従い、`fragments` 配列の要素を stdout に出す。

```json
{
  "fragments": [
    { "source": "codegraph",        "content": "...", "priority": 10 },
    { "source": "knowledge",        "content": "...", "priority": 20 },
    { "source": "recent-failures",  "content": "...", "priority": 30 }
  ]
}
```

| フィールド | 型 | 意味 |
|---|---|---|
| `source` | string | 生成プラグイン識別子（`codegraph` / `knowledge` / `recent-failures`） |
| `content` | string | 注入本文。**軽い要約のみ**（ハイブリッド方式: 深掘りは実行中に AI が MCP で取得） |
| `priority` | number | 連結順序。**小さいほど先**（上位=より重要としてトークン上限内で優先残置） |

各プラグインは自身の source の fragment を 1 個以上返す。該当情報が無い場合は空配列 `{"fragments": []}` を返す（エラーにしない＝サイレント失敗回避のためログには残す）。

### 6.3 priority 連結とトークン上限切り詰め

コアの結合アルゴリズム:

```
1. 収集:  run_ports_all(context.d) で全プラグインの fragments を収集
2. 整列:  fragments を priority 昇順で安定ソート（同 priority はプラグイン番号順）
3. 連結:  content を順に連結（source ラベル付きの区切りヘッダを挿入）
4. 切詰:  累積トークンが CONTEXT_TOKEN_BUDGET を超えたら、超過分を末尾（=低優先）から破棄
          - fragment 単位で落とす（途中でぶつ切りにしない）
          - 落とした fragment は logs に記録（何を捨てたか可観測に）
5. 出力:  executor へ渡す最終 context 文字列
```

| パラメータ | 初期値（仮） | 見直し | 備考 |
|---|---|---|---|
| `CONTEXT_TOKEN_BUDGET` | 未定（プロファイル `profiles/*.env` で設定。初期値は運用データで調整） | Phase 2 実測後 | §11.2 の「数値は運用で調整」方針に準拠。事前の偽の精度を置かない |
| 切り詰め単位 | fragment 単位 | — | priority の意味（重要度）を保つため部分切り詰めはしない |

要点:
- **priority が小さい fragment ほど残りやすい**（重要な影響範囲サマリを優先保全）。
- 事前注入は軽量に保ち、AI が実行中に MCP で深掘りする前提（§4.2）。したがって content には巨大なグラフ全文を入れない。
- 切り詰めが発生したこと自体を可観測にする（要件 §6.3 可観測性）。

---

## 7. 受入基準の充足マッピング

| 受入基準 | 充足箇所 |
|---|---|
| ナレッジグラフのスキーマ定義（Cypher DDL 相当）がある | §2.2（NODE/REL TABLE の DDL、ノード5種・エッジ5種） |
| MCP 2ツールの入出力仕様がある | §3.1 `search_docs` / §3.2 `trace_spec_to_code`（read-only・入出力 JSON） |
| 再インデックスのタイミングと排他方式が明記されている | §1.2（マージ駆動+プリフライト・発火点1箇所）/ §1.3（read-only スナップショット共有・flock・書込1回のみ） |

---

## 8. 未決事項（保留・初期値の明示）

| 項目 | 状態 | 典拠 |
|---|---|---|
| `CONTEXT_TOKEN_BUDGET` の具体数値 | 初期値（仮）。運用データで調整 | §11.2 |
| 差分インデックス（フル→差分の最適化） | 保留。Phase 2 以降の最適化候補 | 本書 §1.2 |
| Neo4j への移行 | 保留。必要になってから | ADR-0003 |
| ノード種の追加 | 再検討事項（安易に増やさない） | ADR-0005 |
| MCP ツールの追加（2→3以降） | 拡張余地。移行面最小化のため初期は2つ固定 | §5.2 / ADR-0003 |
