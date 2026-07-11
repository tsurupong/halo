// Contract test harness (T37, D8 §3): the workspace-level check that every sample
// plugin honours the *distributed* Draft 2020-12 schemas. Two layers:
//   1. every `plugins/**/plugin.json` validates against `schemas/plugin.json`;
//   2. each plugin's documented I/O fixtures (`contract.fixtures.json`) validate
//      against the referenced port schema — valid examples pass, invalid reject.
// This is the language-agnostic contract gate: the same JSON the non-TS bash
// plugins emit is machine-checked against the committed schemas (D8 §3.1). Zero
// network, zero billing. Run in isolation via `pnpm test:contract`.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';
import { SCHEMA_DIR } from './schema-gen.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');

/** Recursively collect files named `target` under `root`. */
function findFiles(root: string, target: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...findFiles(full, target));
    else if (entry.isFile() && entry.name === target) out.push(full);
  }
  return out;
}

// `strict: false` so unknown formats (e.g. `uri`) are ignored rather than
// throwing — we validate structure against the distributed schemas, and the
// schemas themselves are drift-checked against the TS types in schema-drift.test.
// The distributed schemas are Draft 2020-12, but every construct they use
// (oneOf / const / enum / type-arrays / pattern / additionalProperties) is
// draft-07 compatible, so the default validator handles them once the 2020-12
// `$schema`/`$id` refs are dropped (below).
const ajv = new Ajv({ strict: false, allErrors: true });
// `uri` is documented on the schemas but not structurally checked here (that is
// the schemas' own concern); register a passthrough so ajv does not warn.
ajv.addFormat('uri', true);
const validators = new Map<string, ValidateFunction>();
function validatorFor(schemaFile: string): ValidateFunction {
  const cached = validators.get(schemaFile);
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, schemaFile), 'utf8')) as Record<
    string,
    unknown
  >;
  // Drop the 2020-12 meta refs so the default (draft-07) validator compiles the
  // structural schema without needing the 2020-12 meta-schema loaded.
  delete schema.$schema;
  delete schema.$id;
  const validate = ajv.compile(schema);
  validators.set(schemaFile, validate);
  return validate;
}

interface FixtureCase {
  schema: string;
  expect: 'valid' | 'invalid';
  data: unknown;
}
interface FixtureFile {
  description?: string;
  cases: FixtureCase[];
}

const manifestPaths = findFiles(PLUGINS_DIR, 'plugin.json');
const fixturePaths = findFiles(PLUGINS_DIR, 'contract.fixtures.json');

describe('contract: every plugin manifest validates against schemas/plugin.json (D8 §3)', () => {
  it('discovers at least the shipped sample plugins', () => {
    expect(manifestPaths.length).toBeGreaterThanOrEqual(9);
  });

  for (const path of manifestPaths) {
    const rel = relative(REPO_ROOT, path);
    it(`manifest conforms: ${rel}`, () => {
      const validate = validatorFor('plugin.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const ok = validate(manifest);
      expect(ok, ajv.errorsText(validate.errors)).toBe(true);
    });
  }
});

describe('contract: documented plugin I/O fixtures validate against port schemas (D8 §3.2)', () => {
  it('every JSON-contract sample plugin ships fixtures', () => {
    // trigger-* have no stdin JSON contract (exit-code only, D8 §3.2 note) → excluded.
    expect(fixturePaths.length).toBeGreaterThanOrEqual(7);
  });

  for (const path of fixturePaths) {
    const rel = relative(REPO_ROOT, path);
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as FixtureFile;

    describe(rel, () => {
      it('declares at least one case', () => {
        expect(fixture.cases.length).toBeGreaterThan(0);
      });

      fixture.cases.forEach((c, i) => {
        it(`case ${i} (${c.expect} ${c.schema})`, () => {
          const validate = validatorFor(c.schema);
          const ok = validate(c.data);
          if (c.expect === 'valid') {
            expect(ok, ajv.errorsText(validate.errors)).toBe(true);
          } else {
            expect(ok, `expected ${c.schema} to REJECT ${JSON.stringify(c.data)}`).toBe(false);
          }
        });
      });
    });
  }
});
