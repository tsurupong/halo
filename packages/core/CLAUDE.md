# product/packages/core/

コアパッケージ(`halo-core`)。自律ループの状態機械(task 取得 → executor → gate → sink → on-fail)、watchdog / requeue などの信頼性機構(ADR-0013/0014)を実装する。

- `src/` : 実装
- `test/` : ループ回帰テストとモック(CI の loop-regression ジョブが実行)
- `coverage/` : カバレッジ出力(生成物、コミット対象外)
