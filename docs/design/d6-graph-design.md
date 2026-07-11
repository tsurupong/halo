# D6. グラフ設計書（HALO Graph Design）

| 項目 | 内容 |
|---|---|
| 文書バージョン | 1.0 |
| 前提 | HALO要件定義書 v1.8 を最上位文書とし、[D1 コントラクト仕様書](./d1-contract-spec.md)（特に §4 kg:// URI）に整合する |
| 位置づけ | **私有**。グラフ統合プラグイン群（`ports/mcp.d/`・`mcp-knowledge/`・context.d・docs-md runtime・sink 35）の実装仕様 |
| 公開/私有 | **私有**（グラフは自プロジェクト固有の知識資産であり OSS 配布対象外。コアと契約は D1 が公開 API を規定する） |
| 典拠 | 要件定義書 v1.8 §5（コンテキスト層）・§11.1、[ADR-0003](../adr/0003-kuzudb-merge-driven-reindex.md)・[ADR-0005](../adr/0005-knowledge-graph-schema-granularity.md)・[ADR-0011](../adr/0011-specs-abolition-graph-consolidation.md) |
| 素材 | [詳細設計 05](./05-context-layer-graphs.md)（v1.5 素材。KuzuDB DDL 等を流用し、v1.8 のグラフ一元化＝specs/ 廃止に合わせて改訂） |
| 作成タイミング | **Phase 4 着手前**（ナレッジグラフ導入・kg:// 参照と凍結性担保の有効化に先立つ） |

> 本書は要件定義書 §5 を実装レベルまで詳細化したものであり、要件と矛盾する内容は導入しない。数値・細部で要件に未定義の箇所は「初期値（仮）」と明示する（§11.2 準拠）。

---

## 0. スコープと全体像

コンテキスト層は 2 種のグラフ（コードグラフ / ナレッジグラフ）を持ち、いずれも **KuzuDB**（組み込み・ファイル 1 個・サーバー不要、ADR-0003）をバックエンドとする。両グラフは 2 ファイルに分離して格納する。

| グラフ | ファイル | 生成主体 | MCP サーバー | 書込 |
|---|---|---|---|---|
| コードグラフ | `graphs/code.kuzu` | CodeGraphContext（tree-sitter・LLM 不使用） | `codegraph`（`ports/mcp.d/10-codegraph.json`） | プリフライト時のみ |
| ナレッジグラフ | `graphs/knowledge.kuzu` | 人間設計 + sink 35 の機械抽出 | `knowledge`（`ports/mcp.d/20-knowledge.json`、実体 `mcp-knowledge/`） | 手作業 + sink 35 の 2 経路（ADR-0011） |

責務分離（ADR-0005）:

- **コードグラフ** = 自動生成領域。機械が事実として読み取れる構造情報（呼び出し関係・定義位置・デッドコード）。
- **ナレッジグラフ** = 人間設計領域。設計意図・ユビキタス言語・決定という暗黙知。**要件・仕様・受け入れ条件の一元管理先**（ADR-0011: specs/ ディレクトリは持たない）。
- 両者は `IMPLEMENTED_BY`（集約ノード → ディレクトリパス）でのみ論理接続し、フィールドレベルの二重管理を避ける。

本書が規定する 7 項目:

| # | 節 | 内容 |
|---|---|---|
| 1 | §1 | KuzuDB スキーマ DDL（ノード 5 種・エッジ 5 種） |
| 2 | §2 | kg:// URI の解決実装 |
| 3 | §3 | コードグラフ（CGC）の取り込みとプリフライト再インデックス（案 A） |
| 4 | §4 | 陳腐化検出 → `kind:docs` 自動起票のロジック |
| 5 | §5 | 用語集整合チェック（deprecated / synonyms、禁止語のみ block） |
| 6 | §6 | MCP ツール定義（`search_docs` / `trace_spec_to_code`、Agentic RAG） |
| 7 | §7 | 要件の投入手順（原本 md → グラフノード化） |

---

## 1. KuzuDB スキーマ DDL

### 1.1 スキーマ粒度（確定 = ADR-0005 / §11.1）

ノード **5 種**・エッジ **5 種**で開始し、エンティティ・フィールドレベルには下ろさない。橋渡しエッジ `IMPLEMENTED_BY` は集約 → ディレクトリパスで張る。

- **ノード 5 種**: 境界づけられたコンテキスト（BoundedContext）/ 集約（Aggregate）/ ドメイン用語（DomainTerm）/ 文書（Document）/ 決定（Decision）
- **エッジ 5 種**: `BELONGS_TO` / `DEFINED_IN` / `IMPLEMENTED_BY` / `SUPERSEDES` / `AFFECTS`

kg:// URI のノード種別（D1 §4.1）と本スキーマの対応:

| kg:// node-type | NODE TABLE | PRIMARY KEY の値域 |
|---|---|---|
| `context` | `BoundedContext` | ドメイン境界のスラグ（例 `billing`） |
| `aggregate` | `Aggregate` | 集約のスラグ（例 `invoice`） |
| `term` | `DomainTerm` | 用語のスラグ |
| `document` | `Document` | 文書のスラグ（例 `auth-login`） |
| `decision` | `Decision` | 決定 ID の小文字スラグ（例 `adr-0005`、原本の ADR 採番 0005 に対応） |

> **kg:// URI の `id` = ノードの PRIMARY KEY**。この一致が §2 の解決実装の基礎である。ID はスラグ（kebab-case 推奨）で一意とする。

### 1.2 ナレッジグラフ DDL（`graphs/knowledge.kuzu`）

KuzuDB は構造化スキーマを要求するため、ノードは `NODE TABLE`、エッジは `REL TABLE` として定義する。以下が初期 DDL（手書き Cypher で投入）。

```cypher
-- ============ ノードテーブル（5種）============

-- ① 境界づけられたコンテキスト（Bounded Context）
CREATE NODE TABLE BoundedContext (
    id        STRING,        -- kg://context/<id> の <id>（例: "billing"）
    name      STRING,        -- 表示名（例: "課金コンテキスト"）
    summary   STRING,        -- 概要
    PRIMARY KEY (id)
);

-- ② 集約（Aggregate）: 橋渡しの起点。dir_path が実装へのリンク
CREATE NODE TABLE Aggregate (
    id        STRING,        -- kg://aggregate/<id>（例: "invoice"）
    name      STRING,        -- 集約名（例: "Invoice"）
    dir_path  STRING,        -- 実装ディレクトリパス（IMPLEMENTED_BY の根拠）
    summary   STRING,
    PRIMARY KEY (id)
);

-- ③ ドメイン用語（ユビキタス言語）
CREATE NODE TABLE DomainTerm (
    id          STRING,      -- kg://term/<id>
    term        STRING,      -- 用語（正）
    definition  STRING,      -- 定義
    synonyms    STRING,      -- 許容同義語（カンマ区切り。整合チェックで警告のみ）
    deprecated  STRING,      -- 禁止語（カンマ区切り。違反は block 対象）
    PRIMARY KEY (id)
);

-- ④ 文書（設計書 / ADR / 要件 / 用語集）
CREATE NODE TABLE Document (
    id        STRING,        -- kg://document/<id>（例: "auth-login"）
    title     STRING,
    path      STRING,        -- 原本の相対パス（管理は HALO 関知外。任意）
    doc_type  STRING,        -- "design" | "adr" | "requirement" | "glossary"
    body_hash STRING,        -- 投入時点の原本ハッシュ（陳腐化検出・凍結性照合用）
    PRIMARY KEY (id)
);

-- ⑤ 決定（Decision / ADR の意思決定単位）
CREATE NODE TABLE Decision (
    id        STRING,        -- kg://decision/<id>（例: "adr-0005"）
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

-- IMPLEMENTED_BY: 集約 → 集約（確度メタを保持する自己起点保持）
--   対向コードは別DB(code.kuzu)にあり物理エッジを張れないため、
--   dir_path 文字列を鍵にした論理結合とする（§2.3・§6.2）。
CREATE REL TABLE IMPLEMENTED_BY (
    FROM Aggregate TO Aggregate,
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

> **補足（マルチペア関係）**: KuzuDB は 1 つの `REL TABLE` に複数の `FROM ... TO ...` を宣言できる。`DEFINED_IN` / `AFFECTS` はこれで複数の起点・終点型を 1 テーブルに収める。`IMPLEMENTED_BY` の対向は本来コード側ノードだが、コードグラフは別 DB（`code.kuzu`）にあり DB をまたぐ物理エッジは張れない。よって橋渡しは **`Aggregate.dir_path` 文字列を鍵にした論理結合**とし、エッジ自身は確度メタ（`confidence` / `source`）を保持するために集約起点で持つ。

### 1.3 コードグラフのスキーマ

コードグラフは CodeGraphContext（tree-sitter）が自動生成する領域であり、スキーマ・DDL は CGC の実装に従う（本書では規定しない）。HALO 側が依存するのは CGC が公開する MCP ツール（`find_code` / `analyze_code_relationships` / `find_dead_code` / `execute_cypher_query`）と、再インデックス判定用メタ（§3.2）のみである。

### 1.4 スキーマ拡張の方針（ADR-0005）

- エッジ追加は「開始セット」からの拡張として許容する。
- **ノード種の追加は再検討事項**（安易に増やさない）。5 種で表現しきれない知識が出現した時点で ADR を起票する。
- `Document.doc_type` の `spec` は **v1.8 で `requirement` に改称**（ADR-0011: specs/ 廃止に伴い「仕様ファイル」概念が消え、要件そのものが Document ノードになるため。§9 参照）。

---

## 2. kg:// URI の解決実装

### 2.1 URI 形式（D1 §4 に整合）

```
kg://<node-type>/<node-id>
```

| 要素 | 説明 | 例 |
|---|---|---|
| `<node-type>` | ナレッジグラフのノード種別（5 種） | `document` / `decision` / `term` / `context` / `aggregate` |
| `<node-id>` | 種別内で一意のスラグ（= PRIMARY KEY） | `auth-login` / `rate-limit-policy` |

D1 は「形式と『グラフノードを指す』という意味のみ」を規定し、**解決実装は本書（私有）の管轄**とする（D1 §4.2）。

### 2.2 解決アルゴリズム

`knowledge` MCP サーバー内に URI リゾルバを持つ。呼び出し元は loop-audit（gate `50-loop-audit`）と `trace_spec_to_code` の 2 つ。

```
resolve(uri):
  1. パース:  "kg://" プレフィックス除去 → "<type>/<id>" を "/" で分割
             型が 5 種のいずれでもなければ INVALID_TYPE を返す
  2. 型 → テーブル対応（§1.1 の表）で NODE TABLE を決定
  3. Cypher:  MATCH (n:<Table> {id:$id}) RETURN n LIMIT 1
  4. 命中:    ノードプロパティを返す（存在 = true）
     不命中:  NOT_FOUND を返す（存在 = false）
```

型・パス長・スラグ形式（`^[a-z0-9][a-z0-9-]*$`）を入力境界で検証し、不正 URI は fail 理由に URI 原文を添えて返す（可観測性）。

### 2.3 loop-audit による実在検証（凍結要件の担保）

`spec_refs`（task-source 出力の kg:// URI 配列、D1 §1.1）は loop-audit がループ開始時に検証する。

| 検査 | 内容 | 失敗時 |
|---|---|---|
| 形式検証 | 各 URI が `kg://<type>/<id>` に合致するか | gate fail（exit 2） |
| 実在検証 | `resolve(uri)` が存在 = true を返すか（グラフ read-only 照会） | gate fail（exit 2） |
| ハッシュ照合 | `graphs/knowledge.kuzu` のハッシュがループ開始時記録と一致するか（実行中の直接改変検出、ADR-0011 (3)） | gate fail（exit 2） |

実在しない `spec_refs` を持つタスクは構造系チェック①で差し戻す（要件 §11.1）。これにより「AI がゴール（要件ノード）を発明・改変して自己正当化する」経路を塞ぐ。

> **Phase 経過措置**（ADR-0011 / D1 §4.2）: グラフ導入前（Phase 1〜3）は `spec_refs` を空とし要件を Issue 本文に直接記述する。本節の実在検証は Phase 4 のグラフ導入をもって有効化される。

---

## 3. コードグラフの取り込みとプリフライト再インデックス（案 A）

### 3.1 再インデックスの発火点（マージ駆動 + プリフライト）

ADR-0003 に従い `watch` モードは採用しない（監視対象が生滅する worktree になり中間状態でグラフが汚染され、使い捨て worktree 方式と構造的に両立しないため）。再インデックスの発火点は **ループ起動時のプリフライト 1 箇所のみ**とする。

```
run（プリフライト第1段: グラフ鮮度判定）
  IF   main の現在 HEAD != code.kuzu に記録された last_indexed_sha
  THEN 再インデックス実行（main 基準・単一プロセス・書込はここ1回のみ）
       → last_indexed_sha を main HEAD に更新
       → 陳腐化していた集約について kind:docs 起票判定へ（§4）
  ELSE スキップ（陳腐化していない）
  → ループ本体開始（以降グラフは不変）
```

### 3.2 鮮度判定メタデータ

| キー | 内容 | 保存先 |
|---|---|---|
| `last_indexed_sha` | 前回インデックスした main の commit SHA | `code.kuzu` 内メタノード or `graphs/.code.meta` |
| `indexed_at` | 前回インデックス時刻（ISO8601） | 同上 |
| `schema_version` | コードグラフスキーマ版（tree-sitter 抽出ルール版） | 同上 |

再インデックスは差分ではなく **main 基準のフルインデックスを既定**とする（KuzuDB の単一プロセス書込制約下で状態の一貫性を最優先。差分インデックスは Phase 2 以降の最適化候補＝保留）。

### 3.3 排他方式（read-only スナップショット共有）

KuzuDB は単一プロセスからの書込を前提とする。並列 worktree からの同時書込は構造的に禁止する。

| フェーズ | 主体 | アクセス | 排他手段 |
|---|---|---|---|
| プリフライト | run（親プロセス単一） | 読み書き（再インデックス） | `flock`（多重起動防止のロックと共用。書込プロセスは高々 1 つ） |
| ループ実行中 | 各 worktree のエージェント | **read-only** のみ | 書込経路を持たない（MCP は参照系ツールのみ公開） |

要点:

1. 書込はプリフライト時の 1 回のみ。`flock` により書込プロセスは同時に高々 1 つ。
2. ループ実行中は全 worktree が同一の不変スナップショットを read-only で共有 → **イテレーション間のコンテキスト再現性**を担保（同じ入力 → 同じグラフ → 同じ context）。
3. read-only 共有の実体は KuzuDB を read-only モードで開くこと。ファイルコピー不要。書込を試みる MCP ツールは `10-codegraph.json` / `20-knowledge.json` に含めない。

---

## 4. 陳腐化検出 → `kind:docs` 自動起票

### 4.1 陳腐化の 2 経路と反映

マージ〜次回プリフライトの間はグラフが陳腐化する（ADR-0003 Negative）。双方向自動反映で緩和する。

| 起点 | 反映経路 | 実装 |
|---|---|---|
| docs マージ | ナレッジグラフを更新 | sink `35-reindex-knowledge`（§7.3） |
| code 変更 | 陳腐化検出 → `kind:docs` タスク自動起票（設計書と実装の乖離検知） | プリフライト第 1 段（本節） |

### 4.2 起票判定ロジック

再インデックス（§3.1）で code グラフが更新された際、**`IMPLEMENTED_BY` で結ばれた集約の実装ディレクトリに変更が入ったが、対応する Document が追随していない**ケースを乖離として検出する。

```
detect_staleness(old_sha, new_sha):
  1. 差分ディレクトリ集合:
       changed_dirs = git diff --name-only old_sha..new_sha → ディレクトリに正規化
  2. 影響集約の特定:
       FOR each IMPLEMENTED_BY エッジ e (confidence in {"explicit","reviewed"}):
         IF e.dir_path が changed_dirs のいずれかと前方一致:
           影響集約 a = e の起点 Aggregate
  3. 追随判定:
       FOR each 影響集約 a:
         関連 Document d = a を AFFECTS 逆引き or BELONGS_TO 経由で紐づく設計文書
         IF d.body_hash が原本の現ハッシュと不一致  → 既に人手更新済み扱い（スキップ）
         IF d が存在し、かつ d.path が changed_dirs の diff に含まれない
                                                → 乖離候補（コードだけ動き設計が未追随）
  4. 起票:
       乖離候補ごとに kind:docs Issue を自動起票（§4.3）
```

- 判定は `confidence in {explicit, reviewed}` のエッジのみを根拠にする（`inferred`= AI 推定の未レビュー分は誤検知源のため除外、ADR-0005）。
- 判定は決定的（LLM 不使用）。差分・前方一致・ハッシュ比較のみ。

### 4.3 起票の内容と重複抑止

| 項目 | 値 |
|---|---|
| ラベル | `kind:docs`, `ready`, `auto-generated` |
| タイトル | `[docs] <集約名> の設計文書が実装に未追随` |
| 本文 | 影響集約 ID / 変更ディレクトリ / 対象 Document の kg:// URI / 検出コミット範囲 |
| `spec_refs` | 対象 Document・集約の kg:// URI（生成タスク自身の凍結参照） |
| 重複抑止 | 同一 `(集約 id, 対象 Document id)` の未クローズ `auto-generated` Issue が既存なら起票しない（冪等） |

起票は task-source アダプタ経由（GitHub Issues）。自律度に関わらず起票自体は行うが、docs タスクの実行是非は通常のループ・自律度フィルタに従う。

---

## 5. 用語集整合チェック（docs-md runtime）

### 5.1 位置づけ

`docs-md` runtime（D1 §1.7）の `test.sh` が担う動的検証。ナレッジグラフの `DomainTerm` ノードを参照し、変更文書がユビキタス言語に整合するかを検査する。グラフを品質ゲートの基盤に使う具体例（ADR-0005: 型があるから自動ゲートが書ける）。

### 5.2 チェック種別と重大度

| # | チェック | 根拠プロパティ | 違反時 | 重大度 |
|---|---|---|---|---|
| 1 | **禁止語の使用** | `DomainTerm.deprecated`（カンマ区切り） | **block（exit 2）** | CRITICAL |
| 2 | 同義語のゆらぎ | `DomainTerm.synonyms`（カンマ区切り） | warning（exit 0・stderr へ） | LOW |
| 3 | 未定義用語の疑い | `term` 完全一致で命中しない専門語らしき表記 | note（exit 0・stderr へ） | NOTE |

**block するのは禁止語（deprecated）のみ**。synonyms のゆらぎ・未定義疑いは警告に留め、ループを止めない（過剰なゲートで自律実行が停滞するのを避ける。§11.2 の思想）。

### 5.3 判定アルゴリズム

```
glossary_check(changed_docs):
  terms = knowledge MCP から全 DomainTerm を read-only 取得
        （term / synonyms / deprecated を展開しインデックス化）
  FOR each doc in changed_docs (追加・変更行のみ対象):
    tokenize(doc 本文)
    1. deprecated 集合と一致するトークン → violations に追加（block 対象）
    2. synonyms 集合と一致（正 term でない）→ warnings に追加
    3. 専門語らしき未知トークン → notes に追加
  IF violations 非空:  禁止語一覧と代替 term を stderr に出し exit 2
  ELSE:               warnings/notes を stderr に記録し exit 0
```

- 検査対象は変更差分の追加・変更行のみ（既存全文の再チェックはしない＝ノイズ抑制）。
- 決定的（LLM 不使用）。トークン一致のみ。
- 違反出力には必ず「代替すべき正 term」を添える（差し戻し後にエージェントが自力修正できるように）。

---

## 6. MCP ツール定義（Agentic Graph RAG）

### 6.1 方針

MCP 定義は `ports/mcp.d/20-knowledge.json`、サーバー実体は `mcp-knowledge/`。初期ツールは **2 つ**（`search_docs` / `trace_spec_to_code`）に絞る（ADR-0003: Neo4j 移行時の Cypher 方言差の移行面を最小化）。両ツールとも **read-only**（グラフ書込経路を一切持たない）。

グラフ構築は人間設計、**クエリ側のみエージェント化**。各ツールの返却値に「次に呼ぶべきツールの引数」（`next_tools`）を埋め込み、返却値そのものを runbook（次アクション付き手順書）にする。検索の各ステップは決定的、マルチホップのオーケストレーションのみ AI に委ねる（引数の値を AI に発明させない＝決定性の担保）。

### 6.2 `search_docs`

用途: 自然言語 or 用語から関連文書・用語・決定ノードを検索する入口ツール。

**入力**:

```json
{
  "query": "課金の締め処理の設計意図",
  "node_types": ["Document", "Decision", "DomainTerm"],
  "limit": 10
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| `query` | ✓ | 検索語（自然言語 or 用語） |
| `node_types` | | 絞り込み。既定は全ノード種 |
| `limit` | | 既定 10（初期値・仮） |

**出力**（`next_tools` に次の手を埋め込む）:

```json
{
  "results": [
    {
      "node_type": "Aggregate",
      "id": "invoice",
      "name": "Invoice",
      "summary": "請求書集約。締め処理の主体。",
      "kg_uri": "kg://aggregate/invoice",
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
      "kg_uri": "kg://decision/adr-0005",
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

検索は決定的。内部実装は **用語完全一致 → 部分一致 → 概要 substring** の順のフォールバック（LLM 埋め込み検索は初期採用しない＝ローカル完結優先）。各結果に `kg_uri` を含め、そのまま `spec_refs` に転記できるようにする。

### 6.3 `trace_spec_to_code`

用途: 集約ノード（または文書）を起点に、橋渡しエッジ `IMPLEMENTED_BY` を辿って実装ディレクトリ／コードシンボルへ到達する。ナレッジグラフ → コードグラフのホップを担う（2 グラフの論理結合点）。

**入力**:

```json
{
  "aggregate_id": "invoice",
  "document_id": null,
  "resolve_symbols": true
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| `aggregate_id` | △ | 集約起点（`aggregate_id` / `document_id` のどちらか必須） |
| `document_id` | △ | 文書起点（`DEFINED_IN` 逆引き → 集約） |
| `resolve_symbols` | | true なら codegraph へ委譲しシンボルまで解決（既定 false） |

**出力**:

```json
{
  "aggregate": { "id": "invoice", "name": "Invoice" },
  "implemented_by": [
    { "dir_path": "src/billing/invoice/", "confidence": "reviewed", "source": "human" }
  ],
  "code_symbols": [
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

`resolve_symbols=true` のとき、本ツールは `dir_path` を引数に codegraph MCP（別グラフ）へ委譲する。`confidence`（`explicit`/`inferred`/`reviewed`）を必ず返し、呼び出し側が確度を判断できるようにする。

### 6.4 マルチホップ探索の具体例

タスク例:「請求書の締め処理を修正する Issue に着手。関連する設計意図と実装箇所を把握したい。」

```
[Hop 1] search_docs({query:"請求書 締め処理"})
  → results[0] = Aggregate "invoice"
     next_tools = [ trace_spec_to_code({aggregate_id:"invoice"}) ]   ← 引数が埋め込み済み
  → results[1] = Decision "adr-0005"
     next_tools = [ search_docs({query:"...", node_types:["Aggregate"]}) ]

[Hop 2] trace_spec_to_code({aggregate_id:"invoice"})
  → implemented_by = [ "src/billing/invoice/" (confidence:reviewed) ]
     next_tools = [ codegraph.analyze_code_relationships({path:"src/billing/invoice/"}) ]

[Hop 3] codegraph.analyze_code_relationships({path:"src/billing/invoice/"})
  → 呼び出し関係・依存を取得（コードグラフ側・read-only スナップショット）

→ AI は「設計意図(ADR) + 実装ディレクトリ + 呼び出し関係」を自律的に組み立てて把握
```

各ホップの入力引数は前段の `next_tools[].args` として**サーバー側が構築済み**であり、AI は「どの next_tool を選ぶか」だけを判断する。

### 6.5 context.d との関係（ハイブリッド方式）

要件 §4.2 ②のハイブリッド方式に従い、context プラグイン（`20-knowledge`）は**軽い要約のみ事前注入**し、上記マルチホップの深掘りは**実行中に AI 自身が MCP ツールで取得**する。事前注入で全グラフを展開しない（トークン浪費と再現性低下を避ける）。

---

## 7. 要件の投入手順（原本 md → グラフノード化）

ADR-0011 により要件・仕様・受け入れ条件はナレッジグラフに一元管理し、specs/ ディレクトリは持たない。原本 md を人間がどこで管理するかは HALO の関知外（グラフに投入されていればよい）。投入は書込 2 経路（手作業 / sink 35）のいずれか。

### 7.1 投入単位のマッピング

| 原本の記述 | グラフノード | 主なプロパティ |
|---|---|---|
| ドメインの境界（サブシステム） | `BoundedContext` | id / name / summary |
| 集約（実装の単位） | `Aggregate` | id / name / **dir_path** / summary |
| 用語定義（ユビキタス言語） | `DomainTerm` | term / definition / synonyms / deprecated |
| 設計書・ADR・要件文書 | `Document` | id / title / path / doc_type / **body_hash** |
| 意思決定（ADR 本体） | `Decision` | id / title / status / date |

エッジは記述内の関係から張る（帰属 = `BELONGS_TO`、定義元 = `DEFINED_IN`、決定の影響 = `AFFECTS`、決定の廃止 = `SUPERSEDES`、設計⇔実装 = `IMPLEMENTED_BY`）。

### 7.2 投入フロー（手作業経路）

```
1. 原本 md を人間が読み、上表に沿ってノード・エッジの Cypher を書く（人間設計）
2. body_hash を計算し Document ノードへ格納（陳腐化検出・凍結性照合の基準）
3. knowledge.kuzu へ手作業投入（ループ停止中・書込経路 a）
4. IMPLEMENTED_BY 第1段（明示リンク機械抽出）を実行 → explicit エッジを張る（§7.4）
5. 埋まらない集約は第2段（AI 推定 → 人間レビュー）で reviewed へ昇格（§7.4）
```

凍結性: 投入後、ループ実行中は knowledge MCP が read-only で開き、loop-audit がハッシュ照合する（§2.3 / ADR-0011）。

### 7.3 sink 35（docs マージ後の自動再投入・書込経路 b）

`ports/sink.d/35-reindex-knowledge`（`minAutonomy: L3`）。**PR レビューを通過した docs マージ後にのみ**ナレッジグラフを更新する（ADR-0011: レビュー未通過の実行中書込を通す事故を防ぐため経路を限定）。

```
35-reindex-knowledge（docs マージ後）:
  1. 変更された Document 原本の body_hash を再計算し更新
  2. DomainTerm / Decision の追加・変更差分をグラフへ反映
  3. IMPLEMENTED_BY 第1段（明示リンク機械抽出）を再実行し explicit エッジを追随
```

### 7.4 IMPLEMENTED_BY 橋渡しエッジの抽出（2 段階）

橋渡しエッジ（設計ノード ⇔ 実装コンポーネント）の対応付けが最大の価値源泉（要件 §5.4）。

**第 1 段: 明示リンクの機械抽出**（`confidence="explicit"` / `source="link"`、LLM 不使用・決定的）

```
1. Document.path が指す md を走査
2. 実装パス表記を正規表現で抽出（コードスパン内のパス / 「実装: src/...」形式 /
   Aggregate.dir_path と前方一致するパス）
3. 抽出パスと Aggregate.dir_path を突合 → 一致で IMPLEMENTED_BY(explicit, link) を張る
```

**第 2 段: 不足分の AI 推定 + 人間レビュー**（`inferred`→`reviewed` / `ai`→`human`）

```
1. IMPLEMENTED_BY を持たない Aggregate を列挙
2. AI が集約名・summary と codegraph のディレクトリ/シンボル名の類似から候補 dir_path を提案
   → IMPLEMENTED_BY(inferred, ai) として仮登録
3. 人間レビュー(needs-human): 妥当なら reviewed/human へ更新、誤りならエッジ削除
```

要点:

- AI 推定エッジ（`inferred`）は品質ゲート（§4 陳腐化検出）の根拠として**そのままは使わない**。`reviewed` へ昇格したものだけを機械ゲートの正とする（ADR-0005）。
- ディレクトリ構成のリファクタ時は張り替えが必要。明示リンク（explicit 分）は第 1 段の再抽出で自動追随するため、**実装パスを設計書に明示する運用を推奨**。

---

## 8. 受入基準の充足マッピング

| 受入基準 | 充足箇所 |
|---|---|
| KuzuDB スキーマ DDL（ノード 5 種・エッジ 5 種） | §1.2 |
| kg:// URI の解決実装 | §2.2（リゾルバ）/ §2.3（loop-audit 実在検証） |
| CGC 取り込みとプリフライト再インデックス（案 A） | §3.1〜3.3 |
| 陳腐化検出 → kind:docs 自動起票 | §4.2〜4.3 |
| 用語集整合チェック（禁止語のみ block） | §5.2〜5.3 |
| MCP 2 ツール（Agentic RAG） | §6.2〜6.4 |
| 要件の投入手順（原本 md → ノード化） | §7.1〜7.4 |

---

## 9. v1.5 → v1.8 の改訂点（素材 doc 05 に対して）

| # | 改訂 | 理由 |
|---|---|---|
| 1 | **specs/ 前提を削除**し、要件はナレッジグラフに一元化（§0・§7） | ADR-0011。凍結性はディレクトリ凍結ではなく read-only オープン + ハッシュ照合で担保 |
| 2 | `Document.doc_type` の `"spec"` を **`"requirement"`** に改称（§1.2・§1.4） | specs/ 廃止で「仕様ファイル」概念が消え、要件そのものが Document ノードになるため |
| 3 | `Document` に **`body_hash`** プロパティ追加（§1.2） | 陳腐化検出（§4.2）と凍結性ハッシュ照合（§2.3）の基準に必要 |
| 4 | **kg:// URI 解決を D1 §4 に整合**（node-type と PRIMARY KEY の対応表、スラグ形式検証）（§1.1・§2） | v1.8 で kg:// が D1 の公開契約になったため、id = PRIMARY KEY の一致を明示 |
| 5 | **陳腐化 → kind:docs 自動起票のロジックを新規詳細化**（§4.2 判定アルゴリズム・§4.3 冪等な重複抑止） | doc 05 は「自動起票」の一文のみ。D6 で決定的アルゴリズムまで落とした |
| 6 | **要件投入手順（§7）を新規追加**（原本 md → ノード化、書込 2 経路、sink 35 のレビュー通過限定） | ADR-0011 の一元管理・書込経路限定を実装手順に具体化。doc 05 に該当節なし |
| 7 | 用語集整合チェックの **block を deprecated のみに限定**、synonyms/未定義は警告に格下げ（§5.2） | 過剰ゲートで自律実行が停滞するのを避ける（§11.2 の思想を明文化） |

> なお、素材 doc 05 の context.d fragments の priority 連結（doc 05 §6）は D6 の 7 項目外のため本書では扱わない。ただし D1 §1.2 は「priority 大きいほど優先・降順連結」と規定しており、doc 05 §6.3 の「小さいほど優先」とは逆である。これは D1（v1.8 権威）が正であり、context.d 実装は D1 に合わせること（D2 コア詳細設計の管轄）。

---

## 10. 未決事項（保留・初期値）

| 項目 | 状態 | 典拠 |
|---|---|---|
| `search_docs.limit` の既定 10 | 初期値（仮） | §6.2 |
| 差分インデックス（フル → 差分の最適化） | 保留。Phase 2 以降 | §3.2 |
| Neo4j への移行 | 保留。必要になってから | ADR-0003 |
| ノード種の追加 | 再検討事項（安易に増やさない） | ADR-0005 |
| MCP ツールの追加（2 → 3 以降） | 拡張余地。移行面最小化のため初期は 2 つ固定 | §6.1 / ADR-0003 |
| 用語集チェックのトークナイズ（日本語形態素解析の要否） | 初期値（仮）。単純トークン一致から開始 | §5.3 |
