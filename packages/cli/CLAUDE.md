# product/packages/cli/

CLI パッケージ(`@tsurupong/halo`)。`halo` コマンドのエントリポイント。

- `src/commands/` : 各サブコマンド実装(run / init / status / enable など)
- `src/core-ext/` : run の配線層(core 昇格対象外、run-wiring 系のみ)
テストは実装と同居(`*.test.ts`)。
