# product/plugins/

同梱プラグインの「発見単位」。各ディレクトリは `plugin.json`(name/version/port/entry/aux、ADR-0018)+ `contract.fixtures.json` のみを持ち、entry は `packages/plugins/dist/` 配下の JS を直接指す。ランチャースクリプトは存在しない。

実装本体とテストは `product/packages/plugins/src/` にある。monorepo 外への配布は `halo enable <name>` が絶対パス化した plugin.json を生成する(D11 §3)。
