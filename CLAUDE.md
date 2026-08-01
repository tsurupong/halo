# product/

HALO(Harness for Autonomous Loop Orchestration)の実装リポジトリのルート。git 管理はこの階層のみ(上位の `docs/` は非管理)。pnpm workspace monorepo(Node.js >= 22 / pnpm 10.14.0)。

- コマンドはすべてここで実行: `pnpm build` / `pnpm test` / `pnpm lint` / `pnpm coverage`
- `packages/` = TypeScript 実装本体、`plugins/` = 同梱プラグインの発見単位(plugin.json のみ、ADR-0018)
- `docs/` = ADR・設計書(設計判断の一次情報源)、`scripts/` = 補助スクリプト、`test/` = E2E 資材
