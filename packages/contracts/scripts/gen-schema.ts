// CLI wrapper: regenerate the distributed JSON Schemas from the TS types and
// write them to schemas/ (D1 §6.1). Run via `pnpm --filter @tsurupong/halo-contracts gen`.
// The generation logic lives in src/schema-gen.ts so the schema-drift test
// reuses the exact same code path.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// NOTE: `.ts` extension is intentional — this script is run directly by Node's
// type stripping (not compiled by tsc; scripts/ is outside the tsconfig).
import { generateAll, SCHEMA_DIR } from '../src/schema-gen.ts';

function main(): void {
  mkdirSync(SCHEMA_DIR, { recursive: true });
  const schemas = generateAll();
  for (const [file, contents] of schemas) {
    writeFileSync(join(SCHEMA_DIR, file), contents, 'utf8');
    process.stderr.write(`generated schemas/${file}\n`);
  }
  process.stderr.write(`\n${schemas.size} schemas written to ${SCHEMA_DIR}\n`);
}

main();
