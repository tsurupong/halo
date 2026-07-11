# D5. プラグイン開発ガイド（HALO Plugin Development Guide）

| 項目 | 内容 |
|---|---|
| 文書バージョン | 1.0 |
| 前提 | HALO要件定義書 v1.8 / D1 コントラクト仕様書 v1.0 を上位文書とする |
| 位置づけ | **公開 — エコシステム形成の要**。サードパーティ開発者向けの公開チュートリアル |
| 公開/私有 | 公開（OSS） |
| 作成タイミング | OSS 公開前（Phase 3 目安）。D1 確定後に着手可能 |

> 本書は **D1 コントラクト仕様書** が定義する I/O 型・終了コード・`plugin.json` フィールドを実際に「どう書くか」に落とした実践ガイドである。コントラクトの正式定義は常に D1 が権威を持つ。本書の記述が D1 と食い違って見える場合は D1 を正とし、本書の該当箇所を issue として報告してほしい。

---

## 0. はじめに — HALO プラグインとは何か

HALO のコア（`packages/core`、TypeScript 実装）は、自律コーディングループの「骨格」だけを持つ。タスクをどこから取るか、成果物をどう検査するか、合格物をどこへ出すか——といった**具体的な振る舞いは、すべてプラグイン（アダプタ）に委ねられている**。

プラグインとコアの唯一の接点は**プロセス境界**である。コアは各プラグインを 1 プロセスとして起動し、次の 3 つだけでやり取りする。

1. **stdin** に 1 個の JSON オブジェクトを渡す
2. **stdout** から 1 個の JSON オブジェクトを受け取る（出力を要求するポートのみ）
3. **終了コード**で合否・成否を判定する（`0` = pass、`2` = fail、その他 = エラー）

この 3 点だけがコントラクトなので、**プラグインは任意の言語で書ける**。コアが TypeScript でも、あなたのプラグインは bash でも Python でも Go でもよい。本書では TypeScript（Node）と bash の 2 言語で例を示す。

```
      ┌─────────────┐   stdin(JSON)   ┌──────────────────┐
      │  HALO core  │ ───────────────▶│  あなたのプラグイン  │
      │  (loop)     │ ◀─────────────── │  (任意言語の実行体) │
      └─────────────┘  stdout(JSON)    └──────────────────┘
                     ▲  終了コード 0/2/他
```

**9 ポート**（task-source / context / executor / gate / sink / on-fail / runtime / kind / trigger）のどれか 1 つに、あなたのプラグインは属する。ポートごとに入力の形・出力の要否・判定方式が異なる（§2）。

---

## 1. 最小プラグインの作り方

プラグインは最小 2 ファイルで成立する。

```
my-plugin/
├── plugin.json   ← マニフェスト（コアがメタデータを読む）
└── <実行体>       ← plugin.json の exec が指すファイル
```

### 1.1 plugin.json の必須フィールド

`plugin.json` は D1 §2 が正式定義する。必須は 4 つだけである。

| フィールド | 必須 | 説明 |
|---|---|---|
| `name` | ✓ | プラグイン識別子（`@halo/plugin-*` 等） |
| `version` | ✓ | プラグイン自身の semver（`^\d+\.\d+\.\d+...`） |
| `port` | ✓ | 属するポート（`task-source`/`context`/`executor`/`gate`/`sink`/`on-fail`/`runtime`/`trigger` のいずれか） |
| `exec` | ✓ | 実行体への相対パス（bash/node/python いずれも可） |

任意フィールドは `order`（実行順）、`minAutonomy`（sink 等の自律度フィルタ）、`timeoutSec`（タイムアウト）、`env`（注入する環境変数）。詳細は D1 §2 を参照。

> `additionalProperties: false` である。D1 のスキーマに無いキーを足すと検証で落ちる。

### 1.2 例 A — gate プラグイン（TypeScript / Node）

「変更ファイルに `console.log` が残っていないか」を検査する gate を作る。gate は**終了コードで合否を返す**（`0` = pass / `2` = fail）。fail のときだけ stdout に理由 JSON を出す。

`my-gate/plugin.json`:

```json
{
  "name": "@example/plugin-gate-no-console",
  "version": "1.0.0",
  "port": "gate",
  "exec": "./check.mjs",
  "order": 25,
  "timeoutSec": 30
}
```

`my-gate/check.mjs`:

```javascript
#!/usr/bin/env node
// gate プラグイン: 変更ファイルに console.log が残っていれば fail(exit 2)。
// 入力(stdin): { task_id, workdir, changed_files } … D1 §1.4 gate.in
// 出力(stdout): fail 時のみ { reason, hint?, gate? } … D1 §1.4 gate.out
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// --- stdin から 1 個の JSON を読む ---
const input = JSON.parse(readFileSync(0, 'utf8'));
const { workdir, changed_files = [] } = input;

// --- 検査 ---
const offenders = [];
for (const rel of changed_files) {
  if (!/\.(js|mjs|ts|tsx)$/.test(rel)) continue;
  let src = '';
  try {
    src = readFileSync(join(workdir, rel), 'utf8');
  } catch {
    continue; // 削除済みファイル等は無視
  }
  if (/\bconsole\.log\s*\(/.test(src)) offenders.push(rel);
}

// --- 判定は「終了コード」で返す ---
if (offenders.length === 0) {
  process.exit(0); // pass。stdout には何も出さない
}

// fail のときだけ stdout に理由 JSON（1 個）を書く
process.stdout.write(
  JSON.stringify({
    reason: `console.log が ${offenders.length} 箇所残存`,
    hint: offenders.join(', '),
    gate: '25-no-console',
  })
);
process.exit(2); // fail
```

動作確認（プラグイン単体を手で叩く）:

```bash
echo '{"task_id":"T-1","workdir":"/tmp/wt","changed_files":["src/a.ts"]}' \
  | node my-gate/check.mjs
echo "exit=$?"
```

### 1.3 例 B — gate プラグイン（bash）

同じ gate を bash で書くと次のようになる。bash では JSON パースに `jq` を用いるのが簡潔である。

`my-gate-sh/plugin.json`:

```json
{
  "name": "@example/plugin-gate-no-console-sh",
  "version": "1.0.0",
  "port": "gate",
  "exec": "./check.sh",
  "order": 25,
  "timeoutSec": 30
}
```

`my-gate-sh/check.sh`:

```bash
#!/usr/bin/env bash
# gate プラグイン(bash 版): console.log が残れば fail(exit 2)。
# 進捗・警告は stderr へ。stdout は JSON 専用チャネル(D1 §3.2)。
set -euo pipefail

input="$(cat)"                                   # stdin の JSON を全読み
workdir="$(jq -r '.workdir' <<<"$input")"
mapfile -t files < <(jq -r '.changed_files[]? // empty' <<<"$input")

offenders=()
for rel in "${files[@]}"; do
  case "$rel" in *.js|*.mjs|*.ts|*.tsx) ;; *) continue ;; esac
  path="$workdir/$rel"
  [[ -f "$path" ]] || continue
  if grep -qE '\bconsole\.log\s*\(' "$path"; then
    offenders+=("$rel")
    echo "found console.log in $rel" >&2         # 診断は stderr へ
  fi
done

if [[ ${#offenders[@]} -eq 0 ]]; then
  exit 0                                          # pass
fi

# fail: stdout に理由 JSON を 1 個だけ出す
jq -cn --arg hint "$(IFS=,; echo "${offenders[*]}")" \
  --arg reason "console.log が ${#offenders[@]} 箇所残存" \
  '{reason:$reason, hint:$hint, gate:"25-no-console"}'
exit 2
```

> **重要（D1 §3.2）**: stdout は JSON 専用である。`echo "debug..."` のようなデバッグ出力を stdout に混ぜると、コアの JSON パースが壊れる。人間可読な進捗・警告は必ず **stderr** に書くこと。stderr はコアが `.halo/logs/iter_N.json` へ退避するだけで、合否には影響しない（D1 §3.3）。

### 1.4 配置して有効化する

作った gate を対象リポジトリで有効化するには、`ports/gate.d/` にディレクトリごと置く（配置の詳細は §5）。

```
.halo/ports/gate.d/25-no-console/
├── plugin.json
└── check.mjs
```

削除すれば無効化される（`conf.d` 方式、D1 §0-3）。実行順は `order`（無ければファイル名の数字プレフィックス）で決まる。

---

## 2. ポート別の実装ポイント（9 ポート）

D1 §1 の「ポート責務一覧」を、実装者視点で要約する。**入力は常に stdin に 1 個の JSON**。出力・判定はポートごとに異なる。

| # | ポート | 実行のされ方 | stdout 出力 | 判定 | 最重要の実装ポイント |
|---|---|---|---|---|---|
| ① | task-source | 単一（先頭のみ） | あり（`op=next` のみ） | 終了コード | `op` で分岐。タスク無しは `{"task_id":null}`+exit 0 |
| ② | context | 複数（全実行・マージ） | あり（`fragments`） | 常に success 扱い | 軽い要約のみ返す。深掘りはしない |
| ③ | executor | 単一（先頭のみ） | あり（`status`） | stdout の `status`+終了コード | `status` で `done`/`stuck`/`timeout` を表明 |
| ④ | gate | 複数（全実行・論理 AND） | fail 時のみ | 終了コード（0=pass/**2=fail**） | 判定は出力でなく**終了コード** |
| ⑤ | sink | 複数（全実行・独立） | なし | ベストエフォート | `minAutonomy` を宣言する |
| ⑥ | on-fail | 複数（全実行・独立） | なし | ベストエフォート | 個別失敗を他へ波及させない |
| ⑦ | runtime | 束（setup/check/test） | なし | 終了コード（0/**2**） | 3 スクリプト束。選択は `.harness.yml` |
| ⑧ | kind | ポート非該当 | — | — | `.harness.yml` の宣言（実行体でない） |
| ⑨ | trigger | 束（install/uninstall/fire） | なし | 終了コード | stdin JSON を持たない。`fire` が唯一の入口 |

以下、ポートごとの勘所を示す。

### 2.1 ① task-source

入力は `op`（`next`/`complete`/`fail`）で判別する oneOf。`op=next` のときだけ stdout にタスク JSON を返す。

- **タスク無しの表明**: ready 0 件なら `{"task_id": null}` を出力し **exit 0**。コアはこれを見てループを即終了する。ここでエラー終了してはならない。
- `complete` / `fail` は副作用のみで出力不要（exit 0 = 成功）。
- 同一タスクの多重取得を防ぐロック（GitHub なら `ready` → `in-progress` ラベル付け替え）は task-source 側の責務。
- 出力の `spec_refs` は **kg:// URI**（`kg://<type>/<id>`）であり、ファイルパスではない（D1 §4）。Phase 1〜3 は空でよい。

最小の `op=next` 出力:

```json
{ "task_id": "T-012", "title": "...", "body": "...", "kind": "code" }
```

### 2.2 ② context

入力は task-source の `op=next` 出力そのもの（タスク情報）。出力は `fragments` 配列。

- 各 fragment は `{ source, content, priority }`（3 つとも必須）。
- **priority が大きいほど優先**。コアが降順連結し、トークン上限（100k 未満）で切り詰める。
- **軽い要約だけを注入する**のが設計思想（ハイブリッド方式、D1 §1.2）。影響範囲サマリ程度に留め、深掘りは実行中に AI が MCP ツールで取得する。ここで大量のコードを詰め込まないこと。
- 全 context プラグインが実行され結果はマージされる。常に success 扱いなので、失敗しても空 `fragments` を返せばよい。

### 2.3 ③ executor

プロンプトを実行する中核。初期アダプタは `claude -p`（headless）。

- 入力: `{ prompt, workdir, budget:{ max_turns, timeout_sec } }`。
- 出力: `{ status, summary, cost? }`。**`status` が `done` 以外**（`stuck`/`timeout`）だとコアは失敗経路（on-fail）へ落とす。
- エージェントが行き詰まった場合は `status: "stuck"` を返す。エージェント自身が成果物内に `STUCK:` マーカーを出す規約もある（D1 §5）——executor アダプタはそれを検出して `status: "stuck"` に変換する。
- プロセス自体の異常終了はエラー扱い。判定は stdout の `status` で行うのが原則。
- `--strict-mcp-config` でハーネス管理の `mcp.json` のみを読ませる（再現性・セキュリティ）。

### 2.4 ④ gate

**判定は stdout でなく終了コード**。ここが最も間違えやすい。

- `exit 0` = pass、`exit 2` = fail（Claude Code hooks と同一規約）。**exit 2 以外の異常終了も安全側に倒して fail** とみなされる。
- fail のときだけ stdout に `{ reason, hint?, gate? }` を出す。pass のときは stdout に何も出さない。
- gate.d は番号順に全実行され、**1 つでも fail なら全体 fail**（論理 AND）。fail の `reason` は次イテレーションのプロンプトへ再注入される。
- `10-typecheck`/`20-lint`/`30-test` は実コマンドを持たず、採用 runtime の `check.sh`/`test.sh` へ委譲する薄いラッパーにするのが定石（§2.7）。

### 2.5 ⑤ sink

合格後の副作用（commit / PR 作成 / ログ記録）。出力なし。

- **`minAutonomy` の宣言が必須級**。コアは現在の `AUTONOMY` 未満の sink をスキップする。

  | AUTONOMY | 有効な sink（初期構成） |
  |---|---|
  | L1 | `20-progress-log` のみ |
  | L2 | `20-progress-log` / `10-git-commit` / `15-create-pr`（**draft PR**） |
  | L3 | L2 の全 sink + `15-create-pr`（**通常 PR**） |

  `15-create-pr` は `minAutonomy: "L2"` で有効化され、`AUTONOMY` env を読んで L2 では draft PR・L3 では通常 PR を作り分ける（単一 sink で分岐）。自律度は累積的（L3 ⊇ L2 ⊇ L1）。

- `minAutonomy` を**未宣言にすると最も安全側（L3 相当）** に倒され、L1/L2 ではスキップされる（D1 §2）。報告系 sink を L1 でも動かしたいなら明示的に `"minAutonomy": "L1"` と書くこと。
- ベストエフォート。1 つの sink が失敗しても他の sink は続行する。他 sink を巻き込む副作用を持たせないこと。

### 2.6 ⑥ on-fail

gate fail または executor の stuck/timeout 時に番号順で全実行。出力なし。

- 入力: `{ task_id, reason, retry_count, gate?, workdir? }`。
- ベストエフォート（個別失敗は他へ波及しない）。
- 典型構成: `10-record-failure`（`.halo/failure-catalog.md` へ追記）/ `20-escalate`（`retry_count` が閾値 3 に達したら `needs-human` 付与）/ `30-suggest-sign`（PROMPT 改善候補を出力）。
- 記録した失敗は context.d（`30-recent-failures`）が読み取り次イテレーションへ再注入する（「失敗 → 記録 → 再注入」の学習経路）。

### 2.7 ⑦ runtime

「言語」ではなく「**成果物の種類**」を吸収する。他ポートと違いディレクトリ束。

```
ports/runtime.d/<name>/
├── setup.sh   # env 注入 + 依存実体化 + キャッシュ外出し
├── check.sh   # 静的検査（exit 2 = fail）
└── test.sh    # 動的検証（exit 2 = fail）
```

- 3 スクリプトとも共通入力 `{ workdir, changed_files? }`、判定は **exit 0=pass / exit 2=fail**。
- 選択は `.harness.yml` の `runtimes` 宣言による。**`detect.sh` は持たない**（暗黙の自動検出をしない）。
- `setup.sh` は依存の実体化を高速に行う（pnpm ハードリンク / uv リンク / rust 共有 `CARGO_TARGET_DIR`）。
- **WSL2 配置制約**: リンクベース共有は同一ファイルシステム内でのみ有効。worktree・ストア・cache は ext4 側（`/home` 配下）に置く。`/mnt/c/` 配下は禁止（D1 §1.7）。

### 2.8 ⑧ kind

ポートスクリプトではない。対象リポジトリ**ルートに必須の `.harness.yml`** の宣言である。Issue の `kind:<name>` ラベル（無指定時 `code`）から runtime 群とプロンプトを引く。

```yaml
kinds:
  code:
    runtimes: [node-pnpm]
    prompt: prompts/code.md
  docs:
    runtimes: [docs-md]
    prompt: prompts/docs.md
```

`.harness.yml` が無いリポジトリはタスクを実行せず `needs-human`（暗黙の自動検出はしない）。

### 2.9 ⑨ trigger

コアの起動口。**stdin JSON コントラクトを持たない**（引数はプロファイル名のみ）。3 スクリプト束。

```
ports/trigger.d/<name>/
├── install.sh    # トリガー登録（スケジューラ/timer 等）
├── uninstall.sh  # 解除
└── fire          # OS が叩く起動エントリ = node_modules/.bin/halo run <profile> の絶対パス
```

- `fire` は halo CLI を起動する**唯一の入口**。無人実行では `npx` を経由せず `.bin` への絶対パスを直接叩く（バージョン固定・ネットワーク非依存）。
- CLI 以下（プリフライト・loop・ポート群）は「トリガーが何であるか」を知らない。差し替え可能に保つこと。

### 2.10 補 mcp.d

ポートではなく executor に渡す MCP 構成断片。`ports/mcp.d/*.json` をマージして起動時に `.halo/mcp.json` を生成する。各断片は `mcpServers` キー配下の MCP サーバー定義に準拠する。

---

## 3. 見本 4 種の解説

HALO は 4 つの見本プラグインを同梱する。実装の出発点として最も参考になる。

### 3.1 task-source-github（① task-source）

GitHub Issues をタスクの源にするアダプタ。`gh` CLI を用いる。

- `op=next`: `gh issue list --label ready` の先頭を取得し、`ready` → `in-progress` ラベルへ付け替える（多重取得防止のロック）。取得結果を `{ task_id, title, body, kind }` に整形して stdout へ。ready 0 件なら `{"task_id": null}` + exit 0。
- `op=complete`: 完了記録。PR 本文の `Closes #番号` によりマージ時に Issue が自動クローズされる前提。
- `op=fail`: リトライ回数を Issue コメントに記録。同一 Issue で **3 回**（初期値）失敗したら `needs-human` ラベルを付与し人間へエスカレーション（無限ループ遮断）。
- `kind` は Issue の `kind:<name>` ラベル由来（無指定時 `code`）。

実装骨子（bash / `gh` + `jq`）:

```bash
#!/usr/bin/env bash
set -euo pipefail
input="$(cat)"
op="$(jq -r '.op' <<<"$input")"
case "$op" in
  next)
    issue="$(gh issue list --label ready --state open --limit 1 \
      --json number,title,body,labels | jq '.[0] // null')"
    if [[ "$issue" == "null" ]]; then
      echo '{"task_id":null}'; exit 0            # タスク無し
    fi
    num="$(jq -r '.number' <<<"$issue")"
    gh issue edit "$num" --add-label in-progress --remove-label ready >&2
    jq -cn --arg id "T-$num" \
      --arg title "$(jq -r '.title' <<<"$issue")" \
      --arg body  "$(jq -r '.body'  <<<"$issue")" \
      '{task_id:$id, title:$title, body:$body, kind:"code"}'
    ;;
  complete) exit 0 ;;                             # 副作用のみ
  fail)
    num="$(jq -r '.task_id' <<<"$input" | sed 's/^T-//')"
    rc="$(jq -r '.retry_count' <<<"$input")"
    gh issue comment "$num" --body "fail #$rc: $(jq -r '.reason' <<<"$input")" >&2
    [[ "$rc" -ge 3 ]] && gh issue edit "$num" --add-label needs-human >&2
    exit 0 ;;
esac
```

### 3.2 runtime-node-pnpm（⑦ runtime）

Node/TypeScript の成果物を扱う runtime 束。3 スクリプト。

- `setup.sh`: `pnpm install --offline`（ハードリンク共有でストアから高速実体化）。`store-dir` は ext4 側に置く。
- `check.sh`: `tsc --noEmit` と `eslint`。どちらかが失敗したら **exit 2**。
- `test.sh`: `vitest run`。失敗したら **exit 2**。

`check.sh` の骨子:

```bash
#!/usr/bin/env bash
set -uo pipefail
workdir="$(jq -r '.workdir' < /dev/stdin)"
cd "$workdir"
pnpm exec tsc --noEmit    >&2 2>&1 || exit 2   # 診断は stderr へ、fail は exit 2
pnpm exec eslint .        >&2 2>&1 || exit 2
exit 0
```

> gate.d の `10-typecheck`/`30-test` は、この runtime の `check.sh`/`test.sh` を呼ぶだけの薄いラッパーになる。gate 側にコマンドを重複させない（DRY）。

### 3.3 gate-loop-audit（④ gate）

**自己改変防止**の構造検査ゲート（要件 §11.1）。HALO の安全不変条件を担う最重要 gate であり、`50-loop-audit` として配置する。

検査内容（D4 セキュリティ設計書が正式定義。gate としての I/O は本書の範囲）:

- 変更が保護対象（コア自身・ポート定義・セキュリティ設定等）を書き換えていないか。
- `spec_refs` の各 **kg:// URI が実在するノードを指すか**（実在検証、D1 §4.2）。実在しなければ fail。
- その他の構造系チェック（要件 §11.1 の 7 検査）。

gate なので入力は `{ task_id, workdir, changed_files }`、fail 時のみ `{ reason, hint?, gate:"50-loop-audit" }` を出し exit 2。kg:// の解決自体は私有プラグイン（knowledge MCP、D6 管轄）に委ねるが、**このゲートが「参照が実在するか」の最終判定を終了コードで下す**点が要諦。

### 3.4 trigger-polling（⑨ trigger）

高頻度の定時起動で ready タスクを拾うトリガー。`schedule/`（定時起動）と対になる初期実装。

- `install.sh`: OS のスケジューラ（Windows タスクスケジューラ等）に高頻度の定期実行を登録し、各回 `fire` を叩かせる。
- `uninstall.sh`: 登録解除。
- `fire`: `node_modules/.bin/halo run <profile>` の絶対パスを起動。
- ポイントは「**ready タスク 0 件なら即終了**」。task-source が `{"task_id":null}` を返せばコアは即 exit 0 するので、高頻度ポーリングでも空振りのコストが小さい。

---

## 4. contract test の書き方（JSON Schema 検証）

プラグインは任意言語なので、**実行時に配布 JSON Schema で自己検証**するのが唯一の共通の型安全策である（D1 §6）。すべての見本プラグインは contract test を持たねばならない。

### 4.1 単一ソースと配布 Schema

コントラクトの単一の真実の源は `packages/contracts` の **TypeScript 型定義**。そこから JSON Schema（Draft 2020-12）が自動生成され、公開パッケージに同梱・配布される（`$id` は `https://halo.dev/contracts/<port>.<io>.json`）。非 TS プラグインはこの `*.json` Schema を汎用バリデータに通す。

### 4.2 検証すべき対象

| 対象 | 使う Schema |
|---|---|
| プラグインが受け取る **入力例** | `<port>.in.json`（gate なら `gate.in.json`） |
| プラグインが返す **出力** | `<port>.out.json`（gate fail なら `gate.out.json`） |
| `plugin.json` 自体 | `plugin.json`（マニフェスト schema） |

> context の入力は task-source の `op=next` 出力なので `task-source.out.json` を使う。sink/on-fail/runtime/trigger は出力 Schema を持たない（副作用中心）。詳細は D1 付録 A。

### 4.3 例 — ajv CLI で出力を検証（言語非依存）

`gate-no-console` の fail 出力が `gate.out.json` に適合するかを検証する contract test:

```bash
#!/usr/bin/env bash
# contract test: 入力例をプラグインに流し、出力を配布 Schema で検証する。
set -euo pipefail
SCHEMA_DIR="node_modules/@halo/contracts"        # 配布 Schema の所在

# 1) fail を誘発する入力例（gate.in.json 適合を前提）
input='{"task_id":"T-1","workdir":"/tmp/wt","changed_files":["src/a.ts"]}'

# 2) プラグインを実行して stdout を捕捉（exit 2 を許容）
set +e
out="$(echo "$input" | node ./check.mjs)"
code="$?"
set -e

# 3) 終了コードの契約: fail は 2 でなければならない
[[ "$code" -eq 2 ]] || { echo "expected exit 2, got $code" >&2; exit 1; }

# 4) 出力を gate.out.json で検証
echo "$out" | npx ajv validate -s "$SCHEMA_DIR/gate.out.json" -d /dev/stdin \
  --spec=draft2020 || { echo "output violates gate.out.json" >&2; exit 1; }

echo "contract test passed"
```

### 4.4 例 — Vitest で TS プラグインの型を検証

TS プラグインは型定義を直接 import してコンパイル時に契約を守れるが、実行時の I/O も contract test で固めるのが望ましい。

```typescript
// check.contract.test.ts
import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import gateOut from '@halo/contracts/gate.out.json' assert { type: 'json' };
import { execFileSync } from 'node:child_process';

const ajv = new Ajv2020();
const validateOut = ajv.compile(gateOut);

describe('gate-no-console contract', () => {
  it('fail 時に gate.out.json 適合の JSON を exit 2 で返す', () => {
    const input = JSON.stringify({
      task_id: 'T-1',
      workdir: '/tmp/wt',
      changed_files: ['src/a.ts'],
    });
    let stdout = '';
    let code = 0;
    try {
      stdout = execFileSync('node', ['./check.mjs'], { input }).toString();
    } catch (e: any) {
      code = e.status;        // exit 2 はここに来る
      stdout = e.stdout.toString();
    }
    expect(code).toBe(2);
    const out = JSON.parse(stdout);
    expect(validateOut(out)).toBe(true);
    expect(out.reason).toBeTypeOf('string');
  });
});
```

> コア側も、プラグインの stdout を受領した時点で該当出力 Schema に照らして境界検証する（D1 §6.2）。不正 JSON / スキーマ違反は各ポートの規約（context: スキップ、gate: 安全側 fail 等）で扱われる。つまり **contract test を通しておけば、本番でコアに弾かれない**。

---

## 5. 配置方法（devDependencies vs .halo/ports/）

プラグインを対象リポジトリで有効化する経路は 2 つある。用途で使い分ける。

### 5.1 直接配置（`.halo/ports/<port>.d/`）

プロジェクト固有の小さなプラグイン（数十行の bash gate 等）は、対象リポジトリの `.halo/ports/` 配下に直接置く。

```
<対象リポジトリ>/
├── .harness.yml                 # kind 宣言（必須）
└── .halo/
    └── ports/
        ├── task-source.d/
        │   └── 10-github/…      # task-source-github
        ├── context.d/
        │   └── 30-recent-failures/…
        ├── gate.d/
        │   ├── 10-typecheck/…   # runtime check.sh の薄いラッパー
        │   ├── 30-test/…
        │   ├── 25-no-console/…  # §1 で作った自作 gate
        │   └── 50-loop-audit/…  # gate-loop-audit（安全不変条件）
        ├── sink.d/
        │   ├── 15-create-pr/…   # minAutonomy: L2（AUTONOMY で draft/通常 を分岐）
        │   └── 20-progress-log/…# minAutonomy: L1
        ├── on-fail.d/…
        ├── runtime.d/
        │   └── node-pnpm/…      # setup.sh / check.sh / test.sh
        ├── trigger.d/
        │   └── polling/…        # install.sh / uninstall.sh / fire
        └── mcp.d/*.json
```

- **有効化 = 置く、無効化 = 消す**（`conf.d` 方式）。
- 実行順は `order`（無ければファイル名の数字プレフィックス、例 `25-no-console`）。
- リポジトリにコミットするので、チーム全員・無人実行で同じ構成が再現される。

### 5.2 パッケージ配布（`devDependencies`）

再利用される汎用プラグイン（見本 4 種のような）は npm パッケージとして配布し、対象リポジトリの `devDependencies` に入れる。

```jsonc
// 対象リポジトリの package.json
{
  "devDependencies": {
    "@halo/plugin-task-source-github": "^1.0.0",
    "@halo/plugin-runtime-node-pnpm": "^1.0.0"
  }
}
```

配布パッケージを `.halo/ports/` から参照して活性化する（薄いラッパー or シンボリックリンクで `<port>.d/` に配線する）。利点:

- **semver でバージョン固定・更新**できる（D1 §7 の変更管理と整合）。
- 複数リポジトリで共有できる。
- 無人実行では `.bin` の絶対パスを叩く前提なので、`devDependencies` で解決したパスがそのまま `fire` などから使える。

### 5.3 使い分けの指針

| 状況 | 推奨 |
|---|---|
| このリポジトリだけの小さな検査・ログ | 直接配置（`.halo/ports/`） |
| 複数リポジトリで再利用する汎用アダプタ | パッケージ配布（`devDependencies`） |
| 安全不変条件に関わる gate（loop-audit 等） | パッケージ配布 + バージョン固定（監査容易性のため） |

---

## 6. チェックリスト（公開前）

プラグインを公開・PR する前に確認する。

- [ ] `plugin.json` の必須 4 フィールド（`name`/`version`/`port`/`exec`）が揃い、`plugin.json` schema に適合する（`additionalProperties: false` に注意）。
- [ ] stdin から 1 個の JSON を読み、**stdout は JSON 専用**、診断は stderr に出している。
- [ ] 終了コードの契約を守る（gate/runtime: 0=pass・**2=fail**、その他は fail 扱い / task-source next のタスク無しは `{"task_id":null}`+exit 0）。
- [ ] sink なら `minAutonomy` を明示宣言している（未宣言は L3 相当に倒れる）。
- [ ] 出力が配布 JSON Schema に適合する contract test を持つ（§4）。
- [ ] runtime/worktree 関連の成果物を ext4 側（`/home` 配下）に置いている（WSL2 制約、D1 §1.7）。
- [ ] `spec_refs` を使うなら kg:// URI 形式（`kg://<type>/<id>`）で、ファイルパスにしていない。

---

## 付録 A. よくある間違い

| 症状 | 原因 | 対処 |
|---|---|---|
| コアが「JSON パース失敗」で止まる | stdout にデバッグ出力を混ぜた | 診断は stderr へ（D1 §3.2） |
| gate が pass しているのに fail 扱い | 終了コード 0 を返していない / 例外で exit 1 | pass は必ず `exit 0`。fail は `exit 2` |
| sink が L2 で動かない | `minAutonomy` 未宣言（L3 相当に倒れた） | 動かしたい下限を明示（例 `"minAutonomy":"L2"`） |
| 依存の実体化が遅い / リンクが効かない | worktree/store が `/mnt/c/` 側 | ext4 側（`/home` 配下）に移す |
| contract test は通るが本番で弾かれる | 検証した Schema のバージョンが配布物と不一致 | `@halo/contracts` の同梱 Schema を使う |
| kg:// 参照が loop-audit で fail | 実在しないノード ID / パスを書いた | グラフに存在するノード ID を指す（Phase 1〜3 は空にする） |

## 付録 B. 参照

- **D1 コントラクト仕様書** — I/O 型・終了コード・`plugin.json`・kg:// URI・JSON Schema 検証の正式定義（本書の全記述の権威）。
- **D4 セキュリティ設計書** — loop-audit の 7 検査・保護対象・サンドボックスの正式定義。
- **D8 テスト戦略書** — contract test の CI 統合・Schema 乖離検出。
- **要件定義書 v1.8** — §3.2 設計原則、§4 ポート仕様、§11 安全不変条件。
