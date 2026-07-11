# D8. テスト戦略書（HALO Test Strategy）

| 項目 | 内容 |
|---|---|
| 文書バージョン | 1.0 |
| 前提 | HALO要件定義書 v1.8 を最上位文書とし、D1 コントラクト仕様書を契約定義の正とする |
| 位置づけ | **公開**（OSS としての品質保証方針。`packages/core` および見本プラグインの CI に反映） |
| 品質基準 | 本書のカバレッジ目標・件数・閾値は **初期値** として扱う（要件 §11.2 の思想に従い事前固定しない。実測から調整する） |
| ステータス | Phase 1 実装と並走（実装から抽出する形で確定させる） |

> 本書は要件定義書 §11（安全不変条件・数値パラメータ方針）と D1 §6（JSON Schema 自動生成と非 TS プラグインでの検証）を実装可能なテスト方針へ落としたものである。D1 が定めるコントラクト（stdin JSON / stdout JSON / 終了コード）を検証の基準とし、D1 と矛盾する判定規約は導入しない。

---

## 0. テスト戦略の全体像

HALO は「コアは TypeScript、プラグインは任意言語、通信はプロセス境界の JSON コントラクト」という構造を持つ（D1 §0）。この構造に対応して、テストを 4 層に分ける。**API 課金（実 executor 呼び出し）を伴うのは E2E 層のみ**とし、他の 3 層は課金ゼロで高速に回せることを設計制約とする。

| 層 | 対象 | 目的 | API 課金 | 実行タイミング |
|---|---|---|---|---|
| ① core 単体テスト | 純粋関数化した core 9 モジュール | ロジックの正当性 | なし | PR ごと |
| ② ループ回帰テスト | loop 状態機械（executor モック） | ループ制御・終了条件の回帰防止 | なし（固定 JSON 返却） | PR ごと |
| ③ contract test | 全見本プラグインの I/O | コントラクト（D1）適合 | なし | PR ごと |
| ④ E2E | 実 GitHub 相手のスモーク | 統合・実配線の確認 | あり（dry-run で最小化） | リリース前 |

**設計原則**: ①〜③ は決定論的・高速・課金ゼロであることを保証し、PR ごとに必ず通す。④ は非決定性と課金を伴うため、頻度を絞り（リリース前）、`MAX_ITER=1` の dry-run で影響とコストを最小化する。

---

## 1. core 単体テスト（純粋関数化した 9 モジュール）

### 1.1 方針

D2 コア詳細設計書が定める core の 9 モジュールを **純粋関数**として実装し、副作用（プロセス spawn / ファイル I/O / ネットワーク）を境界へ押し出す。純粋関数部分を `vitest` で網羅的に検証する。副作用を持つ薄い境界層はモックで包む。

- **テストランナー**: `vitest`（core は TypeScript / npm 配布のため）。
- **配置**: `packages/core/**/*.test.ts`（実装と同一ディレクトリ、co-located）。
- **構造**: Arrange-Act-Assert。テスト名は振る舞いを説明する記述形（例: `returns exit 0 immediately when task_id is null`）。
- **カバレッジ計測**: `vitest --coverage`（初期目標は下表、初期値として扱う）。

### 1.2 モジュール別のテスト観点

| # | モジュール | 純粋関数化の対象 | 主なテスト観点 | カバレッジ目標（初期値） |
|---|---|---|---|---|
| 1 | config | 起動プロファイル・環境変数の解決 | 既定値のマージ順序、必須値欠落時のエラー、上書き規則（CLI > profile > 既定） | 90% |
| 2 | discovery | `*.d` 走査・order ソート・有効化判定 | 数字プレフィックスの昇順ソート、無効化（削除）の反映、`plugin.json` の `order` 優先、重複順序の安定ソート | 90% |
| 3 | runPort | spawn 引数の組み立て・stdout パース・判定 | stdin JSON 直列化、終了コード → 判定（0/2/その他）の写像、stdout の JSON パース失敗時の扱い、timeout 引数の付与 | 85% |
| 4 | loop | 状態遷移関数（次状態の決定） | next→context→execute→gate→sink/onFail の遷移、retry 判定、終了条件 5 種（§2.3） | 90% |
| 5 | preflight | プリフライト 2 段の判定順序 | 段の順序、いずれかで停止する短絡、`.harness.yml` 不在時の `needs-human` 判定 | 90% |
| 6 | budget | 当日実績の集計アルゴリズム | `logs/` 当日分の集計、上限超過の真偽判定、境界値（丁度上限・空ログ） | 90% |
| 7 | autonomy | sink の `minAutonomy` フィルタ | L1/L2/L3 と sink 有効/スキップの写像、未宣言時の最安全側（= L3 扱い）判定 | 95% |
| 8 | lock | ロック取得/解放の状態判定 | 二重取得の拒否、残留ロックの検出ロジック（flock 相当の純粋部分） | 85% |
| 9 | logger | 構造化ログ（`iter_N.json`）の整形 | stderr 退避の整形、フィールド欠落時の既定、機微情報の非混入 | 85% |

> **純粋関数化の指針**: 「入力 → 出力」で表せる判定・写像・整形はすべて純粋関数に切り出す。プロセス起動やファイル書込は境界関数に閉じ込め、単体テストでは境界をモックする（実プロセスは起動しない）。境界の実挙動は ② ループ回帰テスト・④ E2E で確認する。

### 1.3 例（autonomy フィルタ）

```typescript
// packages/core/autonomy.test.ts
test('skips L3 sink when current autonomy is L1', () => {
  // Arrange
  const sinks = [
    { name: '15-create-pr', minAutonomy: 'L3' },
    { name: '20-progress-log', minAutonomy: 'L1' },
  ];
  // Act
  const enabled = filterSinksByAutonomy(sinks, 'L1');
  // Assert
  expect(enabled.map((s) => s.name)).toEqual(['20-progress-log']);
});

test('treats undeclared minAutonomy as most restrictive (L3)', () => {
  const sinks = [{ name: '10-git-commit', minAutonomy: undefined }];
  expect(filterSinksByAutonomy(sinks, 'L2')).toEqual([]);
});
```

---

## 2. ループ回帰テスト（executor モック = 固定 JSON 返却）

### 2.1 方針

loop 状態機械（§1.2 の module 4）を、**実 executor を固定 JSON 返却のモックに差し替え**て end-to-end に近い形で回す。executor は D1 §1.3 の `{ "status": ..., "summary": ... }` を stdout に返すプロセスであり、これをスクリプト（固定 JSON を echo する bash / node）に置換すれば **API 課金ゼロ**でループ全体の制御を検証できる。

- **課金ゼロの担保**: モック executor は `claude -p` を一切呼ばず、テストが指定した固定 JSON を返すのみ。CI 上で実行しても課金・ネットワークは発生しない。
- **決定論**: モックは入力に対して固定の出力を返すため、ループ挙動が完全に再現可能。回帰の検出に適する。
- **対象**: loop の分岐と終了条件、retry の再注入、on-fail 起動、gate の論理 AND、sink の自律度フィルタ連携。

### 2.2 モック executor の構成

| モック応答 | executor 出力（固定 JSON） | 検証する経路 |
|---|---|---|
| 成功 | `{"status":"done","summary":"ok"}` | gate 全 pass → sink 実行 → complete |
| gate fail | `{"status":"done","summary":"ok"}` + gate モックが exit 2 | fail reason の再注入、retry_count 加算 |
| stuck | `{"status":"stuck","summary":"..."}` | on-fail 起動、失敗経路 |
| timeout | `{"status":"timeout","summary":"..."}` | on-fail 起動、失敗経路 |
| タスクなし | task-source モックが `{"task_id":null}` | exit 0 即終了 |

> gate / task-source も同様にモック化する（D1 §3 の終了コード規約に従う固定挙動のスクリプト）。これによりループの全分岐を課金なしで再現する。

### 2.3 終了条件 5 種の回帰（D2 と整合）

loop の終了条件はすべて回帰テストで固定する（各条件で正しく exit 0 に落ちること）。

| # | 終了条件 | モックの仕込み | 期待挙動 |
|---|---|---|---|
| 1 | タスクなし | task-source が `{"task_id":null}` | exit 0 で即終了 |
| 2 | STOP キルスイッチ | `.halo/STOP` を配置 | イテレーション冒頭で exit 0 |
| 3 | MAX_ITER 到達 | `MAX_ITER=N` 設定 | N イテレーションで停止 |
| 4 | 予算超過 | budget モックが超過を返す | 当該イテレーション前に停止 |
| 5 | エスカレーション | 同一タスクが閾値（初期値 3）回 fail | `needs-human` 付与・再注入打ち切り |

### 2.4 例（retry と再注入）

```typescript
test('re-injects gate fail reason into next iteration prompt', async () => {
  // Arrange: executor は done を返すが gate モックが 1 回目 fail・2 回目 pass
  const executor = mockExecutor({ status: 'done', summary: 'ok' });
  const gate = mockGateSequence([
    { exit: 2, out: { reason: 'coverage 87% < 90%', gate: '30-test' } },
    { exit: 0 },
  ]);
  // Act
  const result = await runLoop({ executor, gate, maxIter: 3 });
  // Assert
  expect(result.iterations[1].prompt).toContain('coverage 87% < 90%');
  expect(result.status).toBe('completed');
});
```

---

## 3. contract test（全見本プラグインの I/O を JSON Schema で検証）

### 3.1 方針

D1 §6 に従い、コントラクトの単一の真実の源は `packages/contracts` の TypeScript 型定義であり、そこから生成された JSON Schema（Draft 2020-12）を配布する。contract test は **全見本プラグインの入出力を、配布 Schema に通して検証**する。言語非依存のコントラクトを、言語横断で機械検証する層である。

- **対象**: 見本プラグイン全種（D5 が解説する 4 種を含む）。
  - `task-source-github` / `runtime-node-pnpm` / `gate-loop-audit` / `trigger-polling`（初期の見本 4 種）。
  - 以降に追加される全見本プラグインを対象に含める。
- **検証器**: 任意の JSON Schema バリデータ（`ajv`（TS）、Python `jsonschema` / `check-jsonschema` 等）。CI では `ajv` を標準採用。
- **検証内容**: 各プラグインの入力例・期待出力例を、該当ポートの Schema（D1 付録 A の一覧）に通して pass/fail を確認する。

### 3.2 プラグイン種別ごとの検証項目

| プラグイン（例） | ポート | 入力検証 | 出力検証 | 終了コード規約 |
|---|---|---|---|---|
| task-source-github | ① task-source | `task-source.in.json`（oneOf: next/complete/fail） | `task-source.out.json`（op=next、`task_id` 必須・null 可） | next: 0 / complete・fail: 0 |
| （context 見本） | ② context | task-source `op=next` 出力（専用 Schema なし） | `context.out.json`（`fragments[]`、priority 整数） | 常に success 扱い |
| （executor 見本） | ③ executor | `executor.in.json`（prompt/workdir/budget） | `executor.out.json`（status enum / summary 必須） | status で判定 |
| gate-loop-audit | ④ gate | `gate.in.json`（task_id/workdir/changed_files） | `gate.out.json`（fail 時のみ、reason 必須） | 0=pass / 2=fail |
| （sink 見本） | ⑤ sink | `sink.in.json`（task_id/workdir/summary） | 出力なし | ベストエフォート |
| （on-fail 見本） | ⑥ on-fail | `on-fail.in.json`（reason/retry_count 等） | 出力なし | ベストエフォート |
| runtime-node-pnpm | ⑦ runtime | `runtime.in.json`（workdir、setup/check/test 共通） | 出力なし | check/test: 0=pass / 2=fail |
| trigger-polling | ⑨ trigger | stdin JSON コントラクトなし（引数のみ） | 出力なし | install/uninstall/fire の終了コード |

> trigger / mcp.d は stdin JSON コントラクトを持たない（D1 §1.9・§1.10）。trigger の contract test は「`fire` が `halo run <profile>` を絶対パスで起動する」ことと install/uninstall の終了コードのみを対象とし、JSON Schema 検証は行わない。

### 3.3 Schema 乖離検出（TS 型 ↔ 生成物）

D1 §6.1 が委ねる「生成コマンドと CI での乖離検出」を本書で規定する。

- **生成**: TS 型 → JSON Schema 変換（`ts-json-schema-generator` 相当）を生成コマンドとして固定する。
- **CI での検出**: CI で Schema を再生成し、`packages/contracts` にコミット済みの `*.json` と **差分ゼロ**であることを検証する（差分があれば fail = 型と配布 Schema の乖離）。これにより「TS はコンパイル時、非 TS は配布 Schema」の二経路が同一コントラクトを守ることを保証する。

### 3.4 例（gate 出力の Schema 検証）

```typescript
test('gate-loop-audit fail output conforms to gate.out.json', () => {
  // Arrange
  const output = { reason: 'spec_ref not found', gate: '50-loop-audit' };
  const validate = ajv.compile(gateOutSchema); // packages/contracts 同梱
  // Act
  const valid = validate(output);
  // Assert
  expect(valid).toBe(true);
});

test('rejects gate output missing required reason', () => {
  const validate = ajv.compile(gateOutSchema);
  expect(validate({ gate: '30-test' })).toBe(false); // reason 必須
});
```

---

## 4. E2E（dry-run: MAX_ITER=1、実 GitHub 相手のスモーク）

### 4.1 方針

①〜③ で個々の部品とコントラクトを固めた上で、**実配線のスモークテスト**として E2E を行う。非決定性と API 課金を伴うため、**`MAX_ITER=1` の dry-run** で 1 イテレーションのみ実行し、影響範囲とコストを最小化する。

- **目的**: 実 GitHub（Issue 取得・ラベル操作・PR 作成）と実 executor・worktree・runtime の配線が通ることの確認。ロジックの網羅ではなく「実際に一周する」ことの確認。
- **範囲の限定**: `MAX_ITER=1` で 1 タスク・1 周のみ。dry-run により副作用（sink）を抑えた構成（自律度 L1: `20-progress-log` のみ、または draft PR）で実行し、本番相当のマージは行わない。
- **課金の許容**: この層のみ実 executor（`claude -p`）を呼ぶため課金が発生する。頻度を絞る（リリース前）ことで総コストを抑える。

### 4.2 スモークの検査項目

| # | 検査 | 期待 |
|---|---|---|
| 1 | task-source: `ready` Issue 取得 | 先頭 Issue を取得し `in-progress` へ付け替え |
| 2 | worktree ライフサイクル | `$TMPDIR/halo-wt-issue-N` の生成 → 実行 → 破棄 |
| 3 | runtime setup/check/test | setup 実体化、check/test の終了コード（0/2）が伝播 |
| 4 | executor 実行 | `claude -p` が起動し `status` を返す（1 周） |
| 5 | gate 判定 | gate.d が番号順に実行され論理 AND で合否 |
| 6 | sink（dry-run 構成） | 自律度に応じた sink のみ実行（L1: 進捗ログ / draft PR） |
| 7 | ログ・予算 | `iter_1.json` 生成、budget 集計が動く |
| 8 | doctor | `gh` / `claude` / `git` の存在・権限・トリガー生存を検査（前提確認） |

### 4.3 実行環境

- **対象リポジトリ**: E2E 専用のサンドボックス GitHub リポジトリ（`.harness.yml` をコミット済み）。本番リポジトリを対象にしない。
- **配置（WSL2）**: worktree・各ストア・cache は ext4 側（`/home` 配下）に置く。`/mnt/c/` 配下は禁止（D1 §1.7 の配置制約）。
- **PAT**: fine-grained・最小権限（PR 作成 + ラベル操作のみ、D4 準拠）を CI シークレットで供給。
- **前提**: 実行前に `halo doctor` を通し、`gh`/`claude`/`git` の存在と権限を確認する。

---

## 5. CI 構成（PR ごとに ①-③、リリース前に ④）

### 5.1 パイプライン

| ジョブ | 契機 | 内容 | 課金 | 失敗時 |
|---|---|---|---|---|
| unit | PR ごと（必須） | ① core 単体テスト（`vitest --coverage`） | なし | ブロック |
| loop-regression | PR ごと（必須） | ② ループ回帰（executor モック固定 JSON） | なし | ブロック |
| contract | PR ごと（必須） | ③ contract test + Schema 乖離検出（§3.3） | なし | ブロック |
| e2e-smoke | リリース前（タグ / release ブランチ） | ④ E2E dry-run（`MAX_ITER=1`、実 GitHub） | あり | リリース阻止 |

### 5.2 ゲーティング

- **PR マージ条件**: unit / loop-regression / contract の 3 ジョブがすべて green であること（①〜③ は課金ゼロなので全 PR で必須化してよい）。
- **リリース条件**: 上記に加え e2e-smoke が green であること。E2E は課金・非決定性を伴うため PR ごとには回さず、リリース前のみとする。
- **カバレッジ**: unit ジョブで §1.2 の目標（初期値）を下回った場合は警告（初期は block ではなく warn とし、実測に応じて閾値を確定させる。要件 §11.2）。

### 5.3 コスト・再現性の設計制約

| 制約 | 理由 |
|---|---|
| ①〜③ は課金ゼロ・決定論 | 全 PR で回すため。executor モック・Schema 検証はネットワーク非依存 |
| ④ のみ実課金・頻度限定 | 実 executor 呼び出しは `MAX_ITER=1` dry-run に限定しコストを最小化 |
| Schema はコミット済み生成物と一致必須 | TS 型と配布 Schema の乖離を CI で構造的に防ぐ（D1 §6.1） |
| WSL2 は ext4 側配置 | リンクベース依存共有・worktree の前提（D1 §1.7） |

---

## 付録 A. テスト層と D1 コントラクトの対応

| テスト層 | 検証するコントラクト（D1） | 課金 |
|---|---|---|
| ① core 単体 | 判定写像（終了コード §3.1、autonomy フィルタ §1.5、budget） | なし |
| ② ループ回帰 | loop 状態機械・終了条件・retry 再注入・on-fail 経路（§3・§5） | なし |
| ③ contract | 全ポート I/O Schema（付録 A）・plugin.json・実行規約（§3） | なし |
| ④ E2E | プロセス境界の実配線・worktree・runtime・実 GitHub | あり |

## 付録 B. 用語

| 用語 | 定義 |
|---|---|
| executor モック | `claude -p` を呼ばず固定 JSON を返す代替プロセス。ループ回帰の課金ゼロ化に用いる |
| contract test | 見本プラグインの I/O を配布 JSON Schema で検証するテスト（D1 §6.2） |
| Schema 乖離検出 | TS 型から再生成した Schema がコミット済み生成物と一致するかの CI チェック |
| dry-run（E2E） | `MAX_ITER=1` で 1 周のみ実行し副作用を抑えたスモーク実行 |
| 純粋関数化 | 副作用を境界へ押し出し、入力→出力で表せる部分を単体テスト可能にする設計 |
