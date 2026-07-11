# E2E スモーク手順 (T39, D8 §4)

HALO の **実配線スモーク**。ロジック網羅ではなく「実際に一周する」ことの確認に限定する
（非決定性・API 課金を伴うため `MAX_ITER=1` の dry-run に絞る, D8 §4.1）。

2 層構成:

| 層 | 実行 | 課金 | 契機 |
|---|---|---|---|
| ① オフライン dry-run 骨子 | `bash scripts/e2e-dry-run.sh` | なし | いつでも / CI 手動可 |
| ② 実 GitHub スモーク（手動） | 本書の手順 | あり（実 `claude -p`） | リリース前のみ（D8 §5.1 e2e-smoke） |

CI の PR ゲートは①〜③（unit / loop-regression / contract）のみで、本 E2E は **PR では回さない**
（課金・非決定性のため, D8 §5.2）。

---

## ① オフライン dry-run 骨子（課金ゼロ）

```bash
bash scripts/e2e-dry-run.sh
```

- 使い捨て git フィクスチャリポジトリを生成し、`task-source` / `executor` / `gate` を極小 bash
  モックに差し替えて `halo run <profile> --dry-run`（`MAX_ITER=1`）を 1 周実行する。
- ネットワーク・`claude`・実 GitHub には一切触れない。
- 検証: 終了コード 0 かつ `.halo/logs/iter_1.json` が `outcome: passed` で生成される。
- 目的: プロセス境界 + worktree ライフサイクル + loop + イテレーションログの**実配線疎通**。

---

## ② 実 GitHub スモーク（手動・リリース前）

### 前提（D8 §4.3）

- **専用サンドボックス**リポジトリを使う（本番リポジトリを対象にしない）。`.harness.yml` をコミット済み。
- **配置（WSL2）**: worktree・各ストア・cache は ext4 側（`/home` 配下）。`/mnt/c/` 配下は禁止（D1 §1.7）。
- **PAT**: fine-grained・最小権限（PR 作成 + ラベル操作のみ, D4 準拠）。CI 実行時はシークレット供給。
- 実行前に `halo doctor` を通し、`gh` / `claude` / `git` の存在・権限を確認する。

### 手順

```bash
# 0. 前提確認
halo doctor

# 1. サンドボックスに ready ラベルの Issue を 1 件用意（GitHub 側で作成）

# 2. 1 周だけ dry-run 実行（L1 = 進捗ログ / draft PR のみ、マージはしない）
halo run <profile> --dry-run --autonomy L1
```

### 検査項目（D8 §4.2 — 8 点）

| # | 検査 | 期待 |
|---|---|---|
| 1 | task-source: `ready` Issue 取得 | 先頭 Issue を取得し `in-progress` へ付け替え |
| 2 | worktree ライフサイクル | `$TMPDIR/halo-wt-issue-N` の生成 → 実行 → 破棄 |
| 3 | runtime setup/check/test | setup 実体化、check/test の終了コード（0/2）が伝播 |
| 4 | executor 実行 | `claude -p` が起動し `status` を返す（1 周） |
| 5 | gate 判定 | `gate.d` が番号順に実行され論理 AND で合否 |
| 6 | sink（dry-run 構成） | 自律度に応じた sink のみ実行（L1: 進捗ログ / draft PR） |
| 7 | ログ・予算 | `iter_1.json` 生成、budget 集計が動く |
| 8 | doctor | `gh` / `claude` / `git` の存在・権限・トリガー生存を検査 |

### 後始末

- draft PR / ブランチ / ラベルをサンドボックス上で手動クローズする。
- 残留 worktree があれば `git worktree prune` と `halo doctor --fix` で掃除する（D3 / D7）。
