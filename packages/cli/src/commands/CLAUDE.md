# product/packages/cli/src/commands/

`halo` の各サブコマンド実装。1コマンド=1ファイル+同名 `*.test.ts`。

run(ループ実行、exit-code / max-budget / max-turns / signals の個別テストあり)、init、doctor、enable(プラグイン配布、entry/aux 絶対パス化)、status、stop、history、trigger、watchdog。
