// JSON Schema generation core (D1 §6.1). The TS port/manifest types are the
// single source of truth; this module derives the distributed Draft 2020-12
// schemas from them. Both the `gen` CLI (scripts/gen-schema.ts) and the
// schema-drift test consume `generateAll()` so regeneration is defined once.
//
// Determinism matters: the drift test diffs the output byte-for-byte against
// the committed schemas/, so output is sorted-key and newline-terminated.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerator, type Config, type SchemaGenerator } from 'ts-json-schema-generator';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const SRC = join(PKG_ROOT, 'src');

/** Directory holding the committed schema artifacts. */
export const SCHEMA_DIR = join(PKG_ROOT, 'schemas');

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const ID_BASE = 'https://halo.dev/contracts/';

interface Contract {
  /** Output filename (also the `$id` suffix). */
  file: string;
  /** Source file under src/ holding the type. */
  source: 'ports.ts' | 'manifest.ts';
  /** Exported type name. */
  type: string;
  title: string;
}

/** D1 appendix A: the 12 distributed contracts. */
export const CONTRACTS: readonly Contract[] = [
  { file: 'task-source.in.json', source: 'ports.ts', type: 'TaskSourceIn', title: 'task-source input' },
  { file: 'task-source.out.json', source: 'ports.ts', type: 'TaskSourceOut', title: 'task-source output (op=next)' },
  { file: 'context.out.json', source: 'ports.ts', type: 'ContextOut', title: 'context output' },
  { file: 'executor.in.json', source: 'ports.ts', type: 'ExecutorIn', title: 'executor input' },
  { file: 'executor.out.json', source: 'ports.ts', type: 'ExecutorOut', title: 'executor output' },
  { file: 'gate.in.json', source: 'ports.ts', type: 'GateIn', title: 'gate input' },
  { file: 'gate.out.json', source: 'ports.ts', type: 'GateOut', title: 'gate output (fail only)' },
  { file: 'sink.in.json', source: 'ports.ts', type: 'SinkIn', title: 'sink input' },
  { file: 'on-fail.in.json', source: 'ports.ts', type: 'OnFailIn', title: 'on-fail input' },
  { file: 'runtime.in.json', source: 'ports.ts', type: 'RuntimeIn', title: 'runtime script input (setup/check/test)' },
  { file: 'harness-yml.json', source: 'manifest.ts', type: 'HarnessYml', title: '.harness.yml' },
  { file: 'plugin.json', source: 'manifest.ts', type: 'PluginManifest', title: 'plugin manifest' },
];

type JsonSchema = Record<string, unknown>;

/**
 * Build a generator over one source file. Constructing a generator spins up a
 * full TS program, so we cache one per source and reuse it across every type
 * declared there (createSchema is cheap once the program exists).
 */
function generatorFor(source: Contract['source']): SchemaGenerator {
  const config: Config = {
    path: join(SRC, source),
    expose: 'none',
    topRef: false,
    jsDoc: 'extended',
    additionalProperties: false,
    skipTypeCheck: true,
    sortProps: true,
  };
  return createGenerator(config);
}

/** Build one flat schema (no top $ref / definitions wrapper) for a contract. */
export function buildSchema(contract: Contract, generator = generatorFor(contract.source)): JsonSchema {
  const raw = generator.createSchema(contract.type) as JsonSchema;

  // Drop the generator's draft-07 marker and any empty definitions bag.
  delete raw.$schema;
  if (raw.definitions && Object.keys(raw.definitions).length === 0) {
    delete raw.definitions;
  }

  // task-source.in is a discriminated union: D1 specifies `oneOf` (mutually
  // exclusive by `op`); the generator emits the looser `anyOf`.
  if (Array.isArray(raw.anyOf) && !('oneOf' in raw)) {
    raw.oneOf = raw.anyOf;
    delete raw.anyOf;
  }

  // Fixed key order: $schema, $id, title, then the generated body.
  return {
    $schema: DRAFT_2020_12,
    $id: `${ID_BASE}${contract.file}`,
    title: contract.title,
    ...raw,
  };
}

/** Serialize one schema exactly as it is written to disk. */
export function serialize(schema: JsonSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

/** Regenerate every contract in memory: filename → file contents. */
export function generateAll(): Map<string, string> {
  const generators = new Map<Contract['source'], SchemaGenerator>();
  const out = new Map<string, string>();
  for (const contract of CONTRACTS) {
    let generator = generators.get(contract.source);
    if (!generator) {
      generator = generatorFor(contract.source);
      generators.set(contract.source, generator);
    }
    out.set(contract.file, serialize(buildSchema(contract, generator)));
  }
  return out;
}
