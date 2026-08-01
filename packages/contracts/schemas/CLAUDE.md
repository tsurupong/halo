# product/packages/contracts/schemas/

生成済み JSON Schema。手編集禁止 — `../src/` の型を変更して `scripts/gen-schema.ts` で再生成する。

各ポートのスキーマ(in/out が揃うのは task-source / executor / gate。sink / on-fail / runtime は in のみ、context は out のみ)、`plugin.json`(entry契約、ADR-0018)、`harness-yml.json`。
