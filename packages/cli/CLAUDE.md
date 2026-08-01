# product/packages/cli/

CLI パッケージ(`@tsurupong/halo`)。`halo` コマンドのエントリポイント。

- `src/commands/` : 各サブコマンド実装(run / init / status / enable など)
- `src/core-ext/` : core 昇格候補の拡張ロジック(配線・スキャフォールド等)
テストは実装と同居(`*.test.ts`)。
