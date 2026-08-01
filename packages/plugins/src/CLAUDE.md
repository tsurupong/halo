# product/packages/plugins/src/

各プラグインの実装ディレクトリ。命名規則は `<port種別>-<実装名>`(例: `task-source-github`, `gate-loop-audit`)。挙動テストは `<name>/<name>.test.ts` に同居。共通処理は `lib/`、trigger 共通部は `trigger/`。
