# product/packages/plugins/

同梱プラグインの実装本体パッケージ(`halo-plugins`、ADR-0017)。発見単位(plugin.json)は `product/plugins/` にあり、その entry がこのパッケージの `dist/` 配下を直接指す(ランチャーは無い、ADR-0018)。

- `src/<プラグイン名>/` : 各プラグイン実装+テスト
- `src/lib/` : プラグイン共通ユーティリティ
