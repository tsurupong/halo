// @halo/contracts — public API (D1). The TypeScript port/manifest types are the
// single source of truth; the Draft 2020-12 JSON Schemas in schemas/ are
// generated from them (see scripts/gen-schema.ts) and distributed alongside for
// non-TS plugins to validate against.
//
// TS consumers import types from the package root:
//     import type { GateOut, PluginManifest } from '@halo/contracts';
// and the generated schemas via the JSON subpath export:
//     import gateOut from '@halo/contracts/gate.out.json' with { type: 'json' };

export type {
  TaskSourceNext,
  TaskSourceComplete,
  TaskSourceFail,
  TaskSourceIn,
  TaskSourceOut,
  Fragment,
  ContextOut,
  ExecutorBudget,
  ExecutorIn,
  ExecutorStatus,
  ExecutorOut,
  GateIn,
  GateOut,
  SinkIn,
  OnFailIn,
  RuntimeIn,
} from './ports.js';

export type {
  KgUri,
  Port,
  MinAutonomy,
  PluginManifest,
  HarnessKind,
  HarnessYml,
} from './manifest.js';
