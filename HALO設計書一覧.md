# HALO 設計書一覧

| 項目 | 内容 |
|---|---|
| 文書バージョン | 1.0 |
| 前提 | HALO要件定義書 v1.8 を最上位文書とし、本一覧は配下の設計文書体系を定義する |
| 粒度の原則 | 要件定義書 = 原則・コントラクト概念・確定/初期値/保留の分類。設計書 = 実装可能な粒度の仕様。会話で図示済みの内容（plugin.json フィールド、core モジュール分割、CLI コマンド体系等）は該当設計書へ収容する |

---

## 文書体系

```
HALO 要件定義書 v1.8（最上位・既存）
├── D1 コントラクト仕様書        ★公開 docs の中核
├── D2 コア詳細設計書
├── D3 CLI 仕様書
├── D4 セキュリティ設計書
├── D5 プラグイン開発ガイド      ★公開
├── D6 グラフ設計書              ◆私有
├── D7 運用ランブック
├── D8 テスト戦略書
└── D9 ADR 集（決定記録）
```

---

## 各設計書の定義

### D1. コントラクト仕様書（contracts spec）

| 項目 | 内容 |
|---|---|
| 位置づけ | **公開 API の正式定義。全文書中で最も保守的に変更管理する（semver 厳守、破壊的変更 = メジャー）** |
| 主な内容 | ①9 ポート別 I/O 型（TaskSource / Context / Executor / Gate / Sink / OnFail / Runtime / Trigger の入出力 JSON）②plugin.json マニフェスト仕様（name / version / port / exec / order / minAutonomy / timeoutSec / env）③実行規約（exit 0 = pass、exit 2 = fail、他 = エラー。stderr の扱い）④kg:// URI 形式（spec_refs のノード ID 参照）⑤STUCK マーカー規約 ⑥JSON Schema 自動生成の仕組みと非 TS プラグインでの検証方法 |
| 公開/私有 | 公開（packages/contracts の README を兼ねる） |
| 作成タイミング | **最優先。実装着手前（contracts の型定義と同時進行）** |

### D2. コア詳細設計書

| 項目 | 内容 |
|---|---|
| 位置づけ | packages/core の実装仕様 |
| 主な内容 | ①モジュール分割（config / discovery / runPort / loop / preflight / budget / autonomy / lock / logger の 9 モジュールと責務）②loop の状態機械（next → context → execute → gate → sink/onFail、retry 判定、終了条件 5 種）③runPort 仕様（spawn、stdin/stdout、timeoutSec 強制、stderr のログ回送）④プリフライト 2 段の判定順序 ⑤budget の都度計測アルゴリズム（logs/ 当日実績の集計方法）⑥discovery の *.d 走査・order ソート・有効化判定 ⑦上向き探索（.harness.yml）の解決規則 ⑧worktree ライフサイクル（$TMPDIR/halo-wt-issue-N、生成→破棄、命名規則） |
| 公開/私有 | 公開（docs/architecture） |
| 作成タイミング | Phase 1 実装と並走（実装から抽出する形でよい） |

### D3. CLI 仕様書

| 項目 | 内容 |
|---|---|
| 位置づけ | packages/cli のコマンド定義 |
| 主な内容 | ①6 コマンド体系（run / project init / trigger install\|uninstall\|list / stop\|resume / status / doctor）②各コマンドの引数・フラグ（--max-iter、--autonomy 等の上書き規則）③project init の生成物（.harness.yml 雛形、.halo/ 骨格、.gitignore 追記）④doctor の検査項目（トリガー生存 = パス移動検出、gh/claude/git の存在・権限）⑤終了コードとエラーメッセージ規約 ⑥「CLI はロジックを持たない」原則（core 関数への委譲マップ） |
| 公開/私有 | 公開 |
| 作成タイミング | Phase 1 実装と並走 |

### D4. セキュリティ設計書

| 項目 | 内容 |
|---|---|
| 位置づけ | 安全不変条件（要件定義書 11.1）の実装仕様。社内での Claude Code セキュリティ検証の知見を流用できる領域 |
| 主な内容 | ①サンドボックス構成（bubblewrap、書込範囲 = worktree、Linux 固有オプションとしての位置づけ）②settings.json の deny ルール標準セット ③GitHub PAT の最小権限定義（fine-grained、PR 作成 + ラベル操作のみ）④自己改変防止の全経路（loop-audit 7 検査の実装、保護対象一覧）⑤グラフ書込制御（実行中 read-only、書込 2 経路、ハッシュ照合）⑥プロンプトインジェクション対策（公開 Issue を信頼しない、ツール許可最小化、マージ非自動化）⑦MCP サーバーの権限（サンドボックス外で動く前提の制御） |
| 公開/私有 | 公開（脅威モデルは OSS の信頼性に直結） |
| 作成タイミング | **Phase 1 前に骨子必須**（安全不変条件は初回無人実行前に存在しなければならないため） |

### D5. プラグイン開発ガイド

| 項目 | 内容 |
|---|---|
| 位置づけ | サードパーティ開発者向けの公開ドキュメント。エコシステム形成の要 |
| 主な内容 | ①最小プラグインの作り方（plugin.json + 実行体、TS と bash の両例）②ポート別の実装ポイント（gate は exit 2、sink は minAutonomy 宣言等）③見本 4 種の解説（task-source-github / runtime-node-pnpm / gate-loop-audit / trigger-polling）④contract test の書き方（JSON Schema 検証）⑤配置方法（devDependencies vs .halo/ports/） |
| 公開/私有 | 公開 |
| 作成タイミング | OSS 公開前（Phase 3 目安）。D1 確定後に着手可能 |

### D6. グラフ設計書

| 項目 | 内容 |
|---|---|
| 位置づけ | **私有**。グラフ統合プラグイン群の実装仕様 |
| 主な内容 | ①KuzuDB スキーマ DDL（ノード 5 種: BoundedContext / Aggregate / DomainTerm / Document / Decision、エッジ 5 種: BELONGS_TO / DEFINED_IN / IMPLEMENTED_BY / SUPERSEDES / AFFECTS）②kg:// URI の解決実装 ③コードグラフ（CGC）の取り込みとプリフライト再インデックス（案 A）④陳腐化検出 → kind:docs 自動起票のロジック ⑤用語集整合チェック（deprecated / synonyms、禁止語のみ block）⑥MCP ツール定義（search_docs / trace_spec_to_code、返却値に次の手を埋める Agentic RAG 方式）⑦要件の投入手順（原本 md → グラフノード化） |
| 公開/私有 | **私有** |
| 作成タイミング | Phase 4 着手前 |

### D7. 運用ランブック

| 項目 | 内容 |
|---|---|
| 位置づけ | 人間側の手順書。自律度運用と計測の実務 |
| 主な内容 | ①自律度昇格・降格の運用（L1 採点の手順と記録様式、昇格判定の実施方法、重大インシデント時の即 L1 降格）②needs-human 対応フロー（仕様修正 → ready 戻し、タスク分割の判断基準）③failure-catalog の読み方と sign 昇格の運用（signs-proposed.md → PROMPT 反映の人間判断）④予算監視（status の見方、超過時の対処）⑤トラブルシュート（doctor の使い方、トリガー不発、flock 残留、worktree 残骸） |
| 公開/私有 | 公開（運用例として価値が高い） |
| 作成タイミング | Phase 1〜2 の実運用から抽出（先に書かない。実測前の手順書は偽の精度になる） |

### D8. テスト戦略書

| 項目 | 内容 |
|---|---|
| 位置づけ | OSS としての品質保証方針 |
| 主な内容 | ①core 単体テスト（純粋関数化した 9 モジュール、vitest）②ループ回帰テスト（executor モック = 固定 JSON 返却で API 課金ゼロ）③contract test（全見本プラグインの I/O を JSON Schema で検証）④E2E（dry-run: MAX_ITER=1、実 GitHub 相手のスモーク）⑤CI 構成（PR ごとに①-③、リリース前に④） |
| 公開/私有 | 公開 |
| 作成タイミング | Phase 1 実装と並走 |

### D9. ADR 集（決定記録）

| 項目 | 内容 |
|---|---|
| 位置づけ | 「なぜこの設計か」の記録。本会話の設計議論が原資料 |
| 初期エントリ候補 | ADR-001 ポート＆アダプタと stdin/stdout JSON コントラクト（言語非依存の根拠）/ ADR-002 使い捨て worktree と tmp 配置 / ADR-003 グローバル状態ゼロ / ADR-004 コア TS 化（bash 案の棄却理由 = OSS 配布）/ ADR-005 specs/ 廃止とグラフ一元化（凍結性の書込制御への移行）/ ADR-006 グラフ更新は案 A（プリフライト・ポーリング駆動、watch 棄却）/ ADR-007 自律度 L1-L3 と昇格の実測主義 / ADR-008 trigger 抽象化（webhook 保留の理由）/ ADR-009 数値パラメータを事前固定しない（11.2 の思想） |
| 公開/私有 | 公開 |
| 作成タイミング | 随時。ADR-001〜005 は実装着手前に起こす価値が高い |

---

## 作成順序（推奨）

| 順 | 文書 | 理由 |
|---|---|---|
| 1 | D1 コントラクト仕様書 | 最安定点。実装（ports.ts）と同時に書く |
| 2 | D4 セキュリティ設計書（骨子） | 安全不変条件は初回無人実行前に必須 |
| 3 | D9 ADR-001〜005 | 会話の記憶が新しいうちに決定理由を固定 |
| 4 | D2 / D3 / D8 | Phase 1 実装と並走（実装から抽出） |
| 5 | D7 運用ランブック | Phase 1〜2 の実測から抽出（先行作成しない） |
| 6 | D5 プラグイン開発ガイド | OSS 公開前 |
| 7 | D6 グラフ設計書 | Phase 4 前（私有） |
