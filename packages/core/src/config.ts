// config — profile / env / CLI-flag resolution and normalisation into a single
// runtime config object (D2 §1.1 #1, §9; D3 §2.1). Also validates a parsed
// `.harness.yml` and resolves a task `kind` (D2 §7, D1 §1.8).
//
// Precedence (D3 §2.1): CLI flags > profile env > core defaults. Resolution is a
// pure function so merge order / missing-required / override tests need no fs
// (D2 §1.2, D8 §1.1). The upward filesystem search for `.harness.yml` and YAML
// text parsing live in `discovery` (D2 §1.1 module 2, §7); this module owns the
// pure validation + kind-resolution helpers discovery calls.

import type { MinAutonomy, HarnessYml, HarnessKind } from '@halo/contracts';

/** Thrown on any configuration / usage error → CLI maps to exit 3 (D3 §5). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Fully resolved runtime configuration handed to the loop. */
export interface HaloConfig {
  autonomy: MinAutonomy;
  maxIter: number;
  timeoutSec: number;
  dailyMaxIterations?: number;
  dailyMaxCostUsd?: number;
  taskFilter?: string;
  kindFilter?: string;
  profileName?: string;
}

/**
 * Adjustable core defaults (要件 §11.2 「調整可能な初期値」, D2 §15 note). These
 * are the fallback layer — the loop never hardcodes them; callers may replace the
 * whole object. AUTONOMY defaults to the safest side (L1, Phase 1 fixed, 要件 §9).
 */
export const CORE_DEFAULTS = {
  AUTONOMY: 'L1',
  MAX_ITER: '20',
  TIMEOUT: '8h',
} as const;

const AUTONOMY_VALUES: readonly MinAutonomy[] = ['L1', 'L2', 'L3'];

/**
 * Parse a `<profile>.env` file body into a flat map. Pure. Supports `KEY=VALUE`,
 * `#` comments, blank lines, `export KEY=`, and single/double-quoted values.
 * Unknown keys are preserved (the resolver picks the ones it needs).
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (key === '') continue;
    let value = withoutExport.slice(eq + 1).trim();
    value = stripInlineComment(value);
    value = unquote(value);
    out[key] = value;
  }
  return out;
}

function stripInlineComment(value: string): string {
  // Only strip a ` #...` comment when the value is unquoted.
  if (value.startsWith('"') || value.startsWith("'")) return value;
  const hash = value.indexOf(' #');
  return hash === -1 ? value : value.slice(0, hash).trim();
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a duration string into whole seconds. Accepts a bare integer (seconds)
 * or a `<n><unit>` form where unit ∈ s/m/h/d (D3 §2.1 `--timeout 3h` / `90m`).
 */
export function parseDuration(input: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(trimmed);
  if (!m) throw new ConfigError(`invalid duration: '${input}' (expected e.g. 900, 90m, 3h)`);
  const n = Number(m[1]);
  const unit = m[2] as 's' | 'm' | 'h' | 'd';
  const factor = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return n * factor;
}

/** CLI flag overrides (D3 §2.1). Only provided keys override; undefined = no override. */
export interface CliOverrides {
  autonomy?: string;
  maxIter?: string | number;
  timeout?: string;
  dailyBudget?: string | number;
  taskFilter?: string;
  kindFilter?: string;
}

export interface ResolveConfigInput {
  /** Parsed `<profile>.env` values (常用値). */
  profileEnv?: Record<string, string>;
  /** CLI flag overrides (最優先, non-persistent). */
  cli?: CliOverrides;
  /** Fallback defaults; defaults to CORE_DEFAULTS. */
  defaults?: Record<string, string>;
  /** Profile name for provenance (recorded in logs). */
  profileName?: string;
}

/**
 * Resolve final config with precedence CLI > profile > defaults, then normalise
 * and validate (D3 §2.1). Pure. Throws {@link ConfigError} on unknown enum values,
 * non-positive integers, or missing required keys after all layers merge.
 */
export function resolveConfig(input: ResolveConfigInput = {}): HaloConfig {
  const defaults = input.defaults ?? { ...CORE_DEFAULTS };
  const profile = input.profileEnv ?? {};
  const cli = input.cli ?? {};

  const autonomyRaw = firstDefined(cli.autonomy, profile.AUTONOMY, defaults.AUTONOMY);
  const maxIterRaw = firstDefined(asStr(cli.maxIter), profile.MAX_ITER, defaults.MAX_ITER);
  const timeoutRaw = firstDefined(cli.timeout, profile.TIMEOUT, defaults.TIMEOUT);
  const dailyItersRaw = firstDefined(asStr(cli.dailyBudget), profile.DAILY_MAX_ITERATIONS, defaults.DAILY_MAX_ITERATIONS);
  const dailyCostRaw = firstDefined(profile.DAILY_MAX_COST_USD, defaults.DAILY_MAX_COST_USD);
  const taskFilter = firstDefined(cli.taskFilter, profile.TASK_FILTER, defaults.TASK_FILTER);
  const kindFilter = firstDefined(cli.kindFilter, profile.KIND_FILTER, defaults.KIND_FILTER);

  const config: HaloConfig = {
    autonomy: normalizeAutonomy(requireValue(autonomyRaw, 'AUTONOMY')),
    maxIter: normalizePositiveInt(requireValue(maxIterRaw, 'MAX_ITER'), 'MAX_ITER'),
    timeoutSec: parseDuration(requireValue(timeoutRaw, 'TIMEOUT')),
    ...(dailyItersRaw != null ? { dailyMaxIterations: normalizePositiveInt(dailyItersRaw, 'DAILY_MAX_ITERATIONS') } : {}),
    ...(dailyCostRaw != null ? { dailyMaxCostUsd: normalizePositiveNumber(dailyCostRaw, 'DAILY_MAX_COST_USD') } : {}),
    ...(taskFilter != null ? { taskFilter } : {}),
    ...(kindFilter != null ? { kindFilter } : {}),
    ...(input.profileName != null ? { profileName: input.profileName } : {}),
  };
  return config;
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

function asStr(v: string | number | undefined): string | undefined {
  return v === undefined ? undefined : String(v);
}

function requireValue(value: string | undefined, key: string): string {
  if (value === undefined) throw new ConfigError(`missing required config: ${key}`);
  return value;
}

function normalizeAutonomy(value: string): MinAutonomy {
  if ((AUTONOMY_VALUES as readonly string[]).includes(value)) return value as MinAutonomy;
  throw new ConfigError(`invalid AUTONOMY: '${value}' (expected one of ${AUTONOMY_VALUES.join(', ')})`);
}

function normalizePositiveInt(value: string, key: string): number {
  if (!/^\d+$/.test(value.trim())) throw new ConfigError(`invalid ${key}: '${value}' (expected a positive integer)`);
  const n = Number(value);
  if (n < 1) throw new ConfigError(`invalid ${key}: '${value}' (must be >= 1)`);
  return n;
}

function normalizePositiveNumber(value: string, key: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`invalid ${key}: '${value}' (expected a positive number)`);
  return n;
}

// --- .harness.yml validation + kind resolution (D2 §7, D1 §1.8) -------------

/**
 * Validate an already-parsed `.harness.yml` object against the contracts shape
 * (mirrors `HarnessYml` / the generated schema — types are the single source of
 * truth, D1). YAML text parsing + upward fs search belong to discovery (D2 §7);
 * this stays pure so it needs no fs and no YAML dependency. Throws {@link ConfigError}.
 */
export function validateHarnessYml(parsed: unknown): HarnessYml {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError('.harness.yml: root must be a mapping');
  }
  const kinds = (parsed as Record<string, unknown>).kinds;
  if (typeof kinds !== 'object' || kinds === null || Array.isArray(kinds)) {
    throw new ConfigError('.harness.yml: `kinds` must be a mapping');
  }
  const entries = Object.entries(kinds as Record<string, unknown>);
  if (entries.length === 0) throw new ConfigError('.harness.yml: `kinds` must define at least one kind');
  for (const [name, def] of entries) {
    validateKind(name, def);
  }
  return parsed as HarnessYml;
}

function validateKind(name: string, def: unknown): asserts def is HarnessKind {
  if (typeof def !== 'object' || def === null || Array.isArray(def)) {
    throw new ConfigError(`.harness.yml: kind '${name}' must be a mapping`);
  }
  const { runtimes, prompt } = def as Record<string, unknown>;
  if (!Array.isArray(runtimes) || runtimes.length === 0 || !runtimes.every((r) => typeof r === 'string')) {
    throw new ConfigError(`.harness.yml: kind '${name}' needs a non-empty string[] 'runtimes'`);
  }
  if (typeof prompt !== 'string' || prompt === '') {
    throw new ConfigError(`.harness.yml: kind '${name}' needs a non-empty string 'prompt'`);
  }
}

/** Sentinel outcome when a kind cannot be resolved (D1 §1.8 再現性優先). */
export type KindResolution =
  | { status: 'resolved'; kind: string; runtimes: string[]; prompt: string }
  | { status: 'needs-human'; kind: string; reason: string };

/**
 * Resolve a task `kind` label to its runtimes + prompt (D2 §7.2). An undefined /
 * empty label falls back to `defaultKind` (D1 §1.8 default `code`). An undefined
 * kind yields `needs-human` rather than throwing — the loop escalates, it does not
 * crash (D2 §2.7 構成不備は別扱い).
 */
export function resolveKind(harness: HarnessYml, kindLabel?: string, defaultKind = 'code'): KindResolution {
  const kind = kindLabel && kindLabel !== '' ? kindLabel : defaultKind;
  const def = harness.kinds[kind];
  if (!def) {
    return { status: 'needs-human', kind, reason: `kind '${kind}' is not defined in .harness.yml` };
  }
  return { status: 'resolved', kind, runtimes: [...def.runtimes], prompt: def.prompt };
}
