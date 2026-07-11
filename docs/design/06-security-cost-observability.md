# 詳細設計書 06 — セキュリティ / コスト制御 / 可観測性

> **v1.8 追随改訂済み（コア TS 化・specs/ 廃止を反映）**。`run.sh` 冒頭の初期化（PATH 洗い直し等）は `packages/cli`（`halo run`）の起動エントリの役割を指す。specs/ ディレクトリは廃止され、凍結性はグラフ書込制御で担保する（D4 §5）。より詳細な脅威モデルは [D4 セキュリティ設計書](./d4-security-design.md) を正とし、本書はその実装面の抜粋。

| 項目 | 内容 |
|---|---|
| 対象 | HALO 非機能要件（要件定義書 §6, §10）の詳細設計 |
| 関連ADR | [ADR-0004 自己改変の禁止](../adr/0004-self-modification-prohibition.md) / [ADR-0008 ポーリング方式](../adr/0008-polling-trigger-over-webhook.md) |
| 実行環境 | WSL2 / Arch Linux、単一マシン、ext4（`/home` 配下）固定 |
| ステータス | 設計確定（数値は要件定義書 §11.2 に従い初期値=仮） |

この設計書は、要件定義書の非機能要件を実装可能な粒度に落とす。数値パラメータのうち §11.2 で「初期値（仮）」とされたものは本書でも仮値として扱い、実測後に調整する前提を維持する。矛盾を避けるため、要件定義書に無い制約は新設しない。

---

## 1. bubblewrap サンドボックス仕様

### 1.1 設計方針

エージェント（`claude -p` headless）の全ファイル操作を、そのタスクの使い捨て worktree の内側にのみ許可する。**サンドボックス境界 = タスクの作業スコープ**（要件定義書 §4.2 executor）とし、境界とスコープを完全一致させることで「このタスクが触れた場所」を監査上一意にする。

- 書込許可は `$TMPDIR/halo-wt-issue-<N>/`（当該タスクの worktree）**のみ**。
- 共有ビルドキャッシュ（各ツール標準のグローバルストア: pnpm store / `CARGO_TARGET_DIR` 等）は正しさに影響しない範囲で書込可（キャッシュ破損は gate が検出する前提。要件定義書 §4.2 runtime。HALO 独自キャッシュは持たない — ADR-0009 zero-global-state）。
- グラフDB（`graphs/*.kuzu`）はループ実行中は read-only スナップショット共有（要件定義書 §5.1）。書込はプリフライトの再インデックス1回のみで、これはサンドボックス外（通常ユーザー権限）で実行する。
- MCP サーバーはサンドボックス外（通常ユーザー権限）で動作する（要件定義書 §6.1）。knowledge MCP は read-only でグラフを開く。

### 1.2 bwrap ラッパー構成

executor（`10-claude-headless.sh`）は `claude -p` を bubblewrap 経由で起動する。書込許可範囲を worktree に一致させるための最小マウント方針:

| マウント | 対象 | モード | 目的 |
|---|---|---|---|
| `--ro-bind /usr /usr` ほかシステム系 | `/usr` `/bin` `/lib` 等 | read-only | 実行に必要なバイナリ・ライブラリ |
| `--bind $TMPDIR/halo-wt-issue-<N> $TMPDIR/halo-wt-issue-<N>` | 当該 worktree | read-write | 作業スコープ（唯一の書込先） |
| `--bind <グローバルストア> <グローバルストア>` | 各ツール標準の共有ストア（pnpm store / `CARGO_TARGET_DIR` 等） | read-write | 依存実体化の高速化（破損は gate 検出前提） |
| `--ro-bind graphs graphs` | グラフDB | read-only | コンテキスト参照のみ |
| `--tmpfs /tmp` | 一時領域 | 揮発 | プロセス作業用（永続化しない） |
| `--unshare-all --share-net` | 名前空間 | — | `gh` / API 通信のためネットワークのみ共有 |
| `--die-with-parent` | プロセス | — | 親（`halo run` プロセス）終了時に確実に道連れ停止 |

`~/.ssh` / `~/.aws` / `~/.config/gh` / 他 worktree / プロジェクト外の `$HOME` は**明示的にマウントしない**（マウントされないものは見えない = デフォルト遮断）。グラフ DB は read-only マウントのみ（specs/ ディレクトリは v1.8 で廃止、書込制御は D4 §5）。加えて機密ディレクトリは §2.3 の `sandbox.denyRead` で二重に遮断する。

### 1.3 PATH 洗い直しラッパー（Windows パス継承問題の回避）

WSL2 は既定で Windows 側の `PATH`（`/mnt/c/...`）を継承する。これにより Windows 実行ファイルが混入し、再現性とサンドボックス境界が崩れる。ループ起動時（`halo run` 冒頭、bwrap 起動前）に PATH を Linux 側のみへ洗い直すラッパーを噛ませる。

- `PATH` を `/usr/local/bin:/usr/bin:/bin` + HALO 管理の runtime パスのみに再構築し、`/mnt/c/` を含む全エントリを除去する。
- 依存の実体化（worktree・各ストア・cache）は ext4（`/home` 配下）に固定（要件定義書 §4.2 runtime の配置制約）。`/mnt/c/` 配下への配置は禁止。
- このラッパーは trigger（`fire` → `.bin/halo`）から見て `halo run` 内の初期化ステップであり、trigger 実装には依存しない（ADR-0008: CLI 以下はトリガーが何かを知らない）。

---

## 2. 危険操作の遮断（PreToolUse hook + settings.json deny の二重化）

### 2.1 二重化の設計意図

要件定義書 §6.1 に従い、危険操作は **PreToolUse hook（exit 2）** と **settings.json の deny** の2層で遮断する。hook は動的（コマンド文字列を解析して判断）、deny は静的（ツール/パターン単位で確定拒否）であり、片方の記述漏れをもう片方が補う。hook は Claude Code hooks 規約に合わせ **exit 2 = ブロック**（要件定義書 §4.2 gate と同一規約）。

### 2.2 遮断操作一覧表（`.claude/hooks/guard.sh`）

| # | 操作カテゴリ | 検出パターン（例） | 判定 | 遮断理由 |
|---|---|---|---|---|
| 1 | 再帰的削除 | `rm -rf` / `rm -fr` / `rm --recursive --force` | exit 2 | worktree 外への波及・作業破壊の防止 |
| 2 | 強制プッシュ | `git push --force` / `git push -f` / `--force-with-lease` | exit 2 | 履歴改変・共有ブランチ破壊の防止（PR 作成は sink が担う） |
| 3 | 機密ファイル読取 | `cat`/`less`/`head`/`grep` 等での `.env` `.env.*` アクセス | exit 2 | 秘密値の露出防止（Read(**/.env) deny と二重化） |
| 4 | 認証情報ディレクトリ | `~/.ssh` / `~/.aws` / `~/.config/gh` への読取 | exit 2 | PAT・鍵の窃取防止（sandbox.denyRead と二重化） |
| 5 | 自己改変 | `CLAUDE.md` / `PROMPT.md` / `.harness.yml` / テストファイルへの書込 | exit 2 | 安全不変条件（ADR-0004）。gate の loop-audit と多層防御 |
| 6 | 履歴の改ざん | `git reset --hard` / `git rebase` / `git commit --amend`（HALO 管理外ブランチ） | exit 2 | 監査可能性の維持 |
| 7 | 権限昇格 | `sudo` / `su` / `chmod 777` / `chown` | exit 2 | サンドボックス境界の迂回防止 |
| 8 | 外向き秘密送信 | `curl`/`wget` で秘密ファイルを本文に含む送信 | exit 2 | 情報漏洩（インジェクション経由の持ち出し）防止 |
| 9 | スケジューラ/常駐化 | `crontab` / `systemctl` / タスクスケジューラ登録 | exit 2 | trigger 以外からの起動経路新設の防止（ADR-0008） |

注: #5 は PreToolUse（事前・ツール実行前ブロック）と loop-audit gate（事後・git diff 検査）の二重化。PreToolUse は「書こうとした瞬間」を止め、loop-audit は「何らかの経路で書けてしまった場合」を差し戻す（ADR-0004 の列挙式検査7項目に対応、D4 §4）。

### 2.3 settings.json の deny / sandbox 設定

```jsonc
// .halo/ から配布し、対象リポジトリの .claude/settings.json として配置（抜粋。D4 §2.2）
{
  "permissions": {
    "deny": [
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(~/.config/gh/**)",
      "Write(**/CLAUDE.md)",
      "Write(**/PROMPT.md)",
      "Write(**/.harness.yml)",
      "Bash(rm -rf*)",
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(sudo*)"
    ]
  },
  "sandbox": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.config/gh"]
  }
}
```

- `deny` はツール/パターン単位の確定拒否（PreToolUse hook より前段の第一防壁）。
- `sandbox.denyRead` は OS レベルの読取遮断で、hook がすり抜けても機密ディレクトリを不可視にする（要件定義書 §6.1 の「OS レベルの sandbox.denyRead」に対応）。
- テストファイルの Write deny はプロジェクト構成に依存するため、パターンは対象リポジトリの `.harness.yml` 側で補い、恒久ルール（CLAUDE.md/PROMPT.md/.harness.yml）は上記で固定する。

---

## 3. GitHub 認証（fine-grained PAT）

### 3.1 方針

`repo` フルスコープの classic PAT は**使用禁止**（要件定義書 §6.1, §10）。PR 作成とラベル操作のみが可能な fine-grained PAT に限定する。トークンは環境変数（`GH_TOKEN`）または secret manager から注入し、ソースコードにハードコードしない。worktree には env-templates 経由で必要最小のものだけを注入する。

### 3.2 fine-grained PAT 権限スコープ明細

| Repository permission | アクセス | 必要な操作 | 付与しない理由 |
|---|---|---|---|
| Contents | **Read-only** | ブランチ/コードの取得、diff 参照 | 書込はローカル git + push（PR 経由）で足りる。Write は不要 |
| Pull requests | **Read and write** | `gh pr create`（draft/通常）、本文 `Closes #番号` | sink（15-create-pr.sh）の必須権限 |
| Issues | **Read and write** | `next` でのラベル付替え（ready→in-progress）、`fail`/`complete` コメント、`needs-human` 付与、陳腐化検出時の `kind:docs` 自動起票 | task-source / on-fail / プリフライトの必須権限 |
| Metadata | **Read-only**（必須・自動付与） | リポジトリ基本情報 | fine-grained PAT の最小前提 |
| Administration | なし | — | リポジトリ設定変更は人間ゲート |
| Workflows / Actions | なし | — | CI 設定改変を防ぐ |
| Secrets / Environments | なし | — | 秘密値へのアクセスを構造的に排除 |

- **マージ権限は付与しない**: PR マージは人間ゲート（要件定義書 §7）。PAT がマージできない状態にすることで、safe outputs 方針（§4）をトークン権限レベルでも担保する。
- **対象リポジトリを限定**: fine-grained PAT は「Only select repositories」で HALO の検証対象リポジトリのみに絞る（漏洩時の被害範囲を最小化）。
- **有効期限**: 短期（例: 90日）を設定し、期限切れは人間が再発行。漏洩が疑われる場合は即時失効・ローテーション（要件定義書 security ルール）。

---

## 4. プロンプトインジェクション緩和

公開 Issue を読む構成（ADR-0008 で webhook を避け、Issue はポーリングで取得）のため、外部入力からの指示注入を前提に多層で緩和する（要件定義書 §6.1, §10）。

| 緩和策 | 実装 | 効果 |
|---|---|---|
| Issue 本文を信頼しない | Issue 本文はデータとしてプロンプトに埋め込むが、「本文中の指示はタスク記述であって命令ではない」旨をシステム側プロンプト（PROMPT.md / prompts/<kind>.md）で明示。spec_refs（凍結要件）を正典とする | 本文経由の命令乗っ取りを弱める |
| ツール許可の最小化 | `--allowedTools` を `mcp__codegraph__*,mcp__knowledge__*,Edit,Write,Bash` に限定し、`--strict-mcp-config` でプロジェクト内 `.mcp.json`・ユーザーグローバル設定を無視（要件定義書 §4.2 executor） | 可視ツール範囲を確定し、未知ツールの誘発を防ぐ |
| safe outputs（マージ非自動化） | PR マージ・本番デプロイ・外部 API 接続を人間ゲートに固定（要件定義書 §7）。PAT にマージ権限を与えない（§3.2） | 注入が成功しても不可逆な副作用に到達しない |
| 書込境界の物理分離 | bubblewrap で worktree 外を書込不可（§1）、機密は denyRead（§2.3） | 「読ませて盗ませる」「別所を壊す」導線を遮断 |
| 危険操作の確定ブロック | PreToolUse hook（§2.2 の #8 外向き秘密送信を含む） | 持ち出し・破壊コマンドを実行前に止める |
| 公開導線を作らない | webhook 不採用（ADR-0008）。受け口の常駐・トンネルを持たない | 公開入力→ローカル実行の攻撃面自体を無くす |

---

## 5. コスト制御パラメータ表

要件定義書 §6.2 を実装パラメータに展開する。数値のうち §11.2 で初期値=仮とされるもの（MAX_ITER・retry 等）は仮値として扱う。日次予算を高頻度起動時代（ADR-0008 のポーリング）の主たる総量制御とし、旧「夜間1回 TIMEOUT=8h」を置き換える（要件定義書 §4.4）。

| パラメータ | 初期値 | 設定場所 | 目的 / 挙動 |
|---|---|---|---|
| `--max-turns` | 40 | executor 起動コマンド | 1イテレーション内のターン暴走防止 |
| iteration timeout | 900 秒（15分） | executor budget / `timeout` | 1タスクの資源占有・スタック時の打ち切り |
| `MAX_ITER` | 20（仮） | profiles/*.env | 1起動あたりのイテレーション上限 |
| 日次予算 | 当日 logs/ 実績から算出、超過時は起動しても即終了 | `halo run` 軽量プリフライト | 高頻度起動での「気づいたら一日中」を防ぐ主制御 |
| プロファイル TIMEOUT | プロファイル依存 | profiles/*.env | 1起動全体の打ち切り（ポーリング間隔と整合） |
| STUCK 検出 | STUCK マーカー出力で停止 | executor 出力解析 | 無限ループの早期停止 |
| retry 上限 | 3回（仮） | task-source / on-fail | 同一 Issue 3回 fail で `needs-human`（無限ループ遮断・要件定義書 §4.2） |
| コスト日次監視 | ccusage 日次 | 運用（ハーネス外） | headless は 2026-06-15 以降、対話用と別クレジットプール消費。夜間稼働前に消費レートを実測 |
| 月次上限判断 | $200 超で直接 API キー + spend limit へ切替検討 | 人間判断 | クレジット枯渇リスクの制御（要件定義書 §6.2, §10） |

- flock（`$TMPDIR/halo.lock`）による多重起動防止と日次予算・TIMEOUT の三点が、ポーリング高頻度化に伴うコスト総量制御を成す（要件定義書 §4.4, ADR-0008 Consequences）。

---

## 6. 可観測性 — `logs/iter_N.json` 構造化ログ

### 6.1 方針

- 全イテレーションのログを `logs/iter_N.json` に構造化保存する（要件定義書 §6.3）。
- **ハーネスは観察ツールに非依存**。公式インターフェースは「構造化ログ（iter_N.json）」と「STOP ファイル」の2つのみ。tmux / `tail -f` / `jq` 等での観察は任意であり、これらが無くてもハーネスは完全動作する（要件定義書 §6.3）。
- gate 通過率をイテレーション単位で記録し、コンテキストプラグイン（codegraph / knowledge）の ON/OFF による効果測定（要件定義書 §9 原則2「1変数ずつ」）に使えるフィールドを設計する。

### 6.2 JSON スキーマ

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "HALO iteration log (iter_N.json)",
  "type": "object",
  "required": ["iter", "started_at", "ended_at", "profile", "autonomy",
               "task", "gates", "outcome"],
  "properties": {
    "iter": { "type": "integer", "description": "イテレーション連番 N" },
    "started_at": { "type": "string", "format": "date-time" },
    "ended_at": { "type": "string", "format": "date-time" },
    "profile": { "type": "string", "enum": ["continuous", "daytime-l1", "nightly"] },
    "autonomy": { "type": "string", "enum": ["L1", "L2", "L3"],
                  "description": "実行時の自律度（降格/昇格の追跡用）" },
    "trigger": { "type": "string", "enum": ["schedule", "polling", "manual"] },
    "task": {
      "type": "object",
      "required": ["task_id", "kind"],
      "properties": {
        "task_id": { "type": ["string", "null"] },
        "title": { "type": "string" },
        "kind": { "type": "string", "description": "code / docs 等（無指定は code）" },
        "runtimes": { "type": "array", "items": { "type": "string" } },
        "spec_refs": { "type": "array", "items": { "type": "string" } },
        "retry_count": { "type": "integer",
                         "description": "retry別成功率の実測用（要件定義書 §11.2）" }
      }
    },
    "context": {
      "type": "object",
      "description": "コンテキストプラグインON/OFFの効果測定用（gate通過率と突合）",
      "properties": {
        "plugins_enabled": { "type": "array", "items": { "type": "string" },
                             "description": "例: [\"10-codegraph\", \"20-knowledge\"]" },
        "fragments_count": { "type": "integer" },
        "tokens_injected": { "type": "integer",
                             "description": "Dumb Zone(100k)手前維持の監視用" }
      }
    },
    "executor": {
      "type": "object",
      "properties": {
        "status": { "type": "string", "enum": ["done", "stuck", "timeout"] },
        "turns_used": { "type": "integer" },
        "duration_sec": { "type": "number" },
        "cost": {
          "type": "object",
          "properties": {
            "input_tokens": { "type": "integer" },
            "output_tokens": { "type": "integer" },
            "usd_estimate": { "type": ["number", "null"] }
          }
        }
      }
    },
    "gates": {
      "type": "array",
      "description": "gate.d を番号順に全実行した結果。通過率算出の一次データ",
      "items": {
        "type": "object",
        "required": ["name", "result"],
        "properties": {
          "name": { "type": "string",
                    "description": "10-typecheck / 20-lint / 30-test / 40-ai-review / 50-loop-audit" },
          "result": { "type": "string", "enum": ["pass", "fail", "skipped"] },
          "reason": { "type": ["string", "null"],
                      "description": "fail時のみ。次イテレーションへ再注入した文言" },
          "hint": { "type": ["string", "null"] },
          "duration_sec": { "type": "number" }
        }
      }
    },
    "gate_pass_rate": {
      "type": "number",
      "description": "本イテレーションの pass 数 / (pass+fail) 数。0..1。効果測定の集計キー"
    },
    "sinks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "result": { "type": "string", "enum": ["done", "failed", "skipped"] },
          "skipped_reason": { "type": ["string", "null"],
                              "description": "自律度フィルタでのskip等（min-autonomy未満）" },
          "pr_url": { "type": ["string", "null"] }
        }
      }
    },
    "outcome": {
      "type": "string",
      "enum": ["passed", "failed", "escalated", "no_task", "stopped"],
      "description": "passed=全gate通過+sink実行 / escalated=needs-human / no_task=readyタスク0件 / stopped=STOP/予算超過"
    },
    "on_fail": {
      "type": "object",
      "properties": {
        "actions": { "type": "array", "items": { "type": "string" },
                     "description": "10-record-failure / 20-escalate / 30-suggest-sign" },
        "failure_gate": { "type": ["string", "null"] },
        "sign_proposed": { "type": ["string", "null"] }
      }
    }
  }
}
```

### 6.3 効果測定での使い方

- **コンテキスト層の効果**: `context.plugins_enabled` の有無で週を分け、同一種タスク群の `gate_pass_rate` を比較する（要件定義書 §9 Phase 4「有/無の週で gate 通過率比較」）。`10-codegraph` → `20-knowledge` の順に1つずつ導入し、各段の差分を測る。
- **retry 戦略の効果**: `task.retry_count` × `outcome` の集計で「reason 再注入で直るのは何回目までか」を実測し、retry 上限（初期値3・仮）を §11.2 の見直し時期（Phase 2 完了時）に調整する。
- **自律度昇格の判定材料**: L1 運転時の `outcome` と gate 結果を人間が採点する（判定は人間。要件定義書 §11.2「実測なしの閾値は偽の精度」）。ログはあくまで採点の一次データであり、昇格閾値をログ側にハードコードしない。
- **Dumb Zone 監視**: `context.tokens_injected` が 100k を超えないことを確認（フレッシュコンテキスト原則、要件定義書 §3.2）。

### 6.4 STOP ファイルと観察非依存の徹底

- キルスイッチは `.halo/STOP` の存在で即終了（各イテレーション冒頭で確認、要件定義書 §4.4）。端末に入らず Windows エクスプローラーからのファイル配置でも停止できる。
- ログ出力・STOP 確認はいずれもファイルシステム操作のみで完結し、監視デーモン・常駐プロセスを持たない。これにより ADR-0008（公開エンドポイント/常駐ゼロ）とも整合する。

---

## 章立て要約

1. bubblewrap サンドボックス（書込許可=worktree のみ、マウント表、PATH 洗い直しラッパー / WSL2）
2. 危険操作の遮断（PreToolUse hook 9項目の一覧表 + settings.json deny + sandbox.denyRead の二重化）
3. GitHub 認証（fine-grained PAT の権限スコープ明細表、repo フルスコープ禁止・マージ権限なし）
4. プロンプトインジェクション緩和（Issue 本文非信頼・ツール最小化・safe outputs）
5. コスト制御パラメータ表（max-turns/timeout/MAX_ITER/日次予算/ccusage/月$200 切替）
6. `logs/iter_N.json` の JSON スキーマ（gate 通過率など効果測定フィールド）+ STOP ファイル・観察ツール非依存の方針
