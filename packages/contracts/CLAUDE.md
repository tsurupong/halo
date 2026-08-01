# product/packages/contracts/

ポート契約パッケージ(`halo-contracts`)。TypeScript 型定義から `ts-json-schema-generator` で JSON Schema を生成し、ajv で検証する。

- `src/` : 契約の型定義
- `schemas/` : 生成済み JSON Schema(各ポートの in/out、plugin.json、harness-yml)
- `scripts/gen-schema.ts` : スキーマ生成スクリプト
型を変更したらスキーマを再生成すること。
