# product/packages/

pnpm workspace のパッケージ群(すべて TypeScript、npm 公開: `@tsurupong/halo` / `halo-core` / `halo-contracts` / `halo-plugins`)。

- `cli/` : CLI コマンド(`halo run` 等)
- `core/` : コア状態機械・ループ制御
- `contracts/` : ポート契約の型と JSON Schema
- `plugins/` : 同梱プラグインの実装本体(発見単位は `../plugins/`)
