# product/packages/plugins/src/sink-create-pr/

sink ポート実装。gate 通過後の worktree を origin へ push し GitHub PR を作成する(D1 §1.5 / ADR-0028)。AUTONOMY=L2 は draft PR、L3 は通常 PR。push は `--force-with-lease`。
