// Schema drift detection (D8 §3.3, T09): the committed schemas/*.json must be
// byte-identical to what the TS types regenerate. A drift means the distributed
// Draft 2020-12 schemas and the source-of-truth TS types have diverged.
//
// Regeneration spins up TS programs, so we do it once in beforeAll (with a
// generous timeout) and share the result across assertions.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { CONTRACTS, generateAll, SCHEMA_DIR } from './schema-gen.js';

const GEN_TIMEOUT_MS = 120_000;

describe('schema drift', () => {
  let regenerated: Map<string, string>;

  beforeAll(() => {
    regenerated = generateAll();
  }, GEN_TIMEOUT_MS);

  it('committed schemas match regeneration byte-for-byte', () => {
    for (const { file } of CONTRACTS) {
      const committed = readFileSync(join(SCHEMA_DIR, file), 'utf8');
      expect(regenerated.get(file), `${file} missing from regeneration`).toBe(committed);
    }
  });

  it('regenerates exactly the 12 D1 appendix A contracts', () => {
    expect(CONTRACTS).toHaveLength(12);
    expect(new Set(CONTRACTS.map((c) => c.file)).size).toBe(12);
  });

  // Regression guard (T09): prove the comparison is actually sensitive — a
  // schema that diverges from the source-of-truth types must be caught. We
  // tamper a committed file in memory rather than mutating a source type.
  it('detects a tampered schema as drift', () => {
    const committed = readFileSync(join(SCHEMA_DIR, 'gate.out.json'), 'utf8');
    const tampered = committed.replace('"reason"', '"REASON_RENAMED"');
    expect(tampered).not.toBe(committed);
    expect(regenerated.get('gate.out.json')).not.toBe(tampered);
  });
});
