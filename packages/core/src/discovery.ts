// discovery — scan `ports/<port>.d/`, validate each `plugin.json`, resolve the
// effective `order`, stably sort ascending, and drop disabled/invalid entries
// (D2 §1.1 #2, §6; D1 §2). Also owns the upward filesystem search for the
// target repo's `.harness.yml` (D2 §7; the pure validation + kind resolution
// live in `config`).
//
// Every pure helper (prefix parse, order resolution, manifest validation, sort)
// is separated from the filesystem so it is unit-testable without real dirs
// (D2 §1.2, D8 §1.1). The only side-effecting entry points inject a `DiscoveryFs`
// seam — no singletons, no module-level state.

import { join, dirname } from 'node:path';
import type { Port, PluginManifest, MinAutonomy } from '@halo/contracts';

/** Thrown when a candidate `plugin.json` violates the manifest contract (D1 §2). */
export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

const PORT_VALUES: readonly Port[] = [
  'task-source',
  'context',
  'executor',
  'gate',
  'sink',
  'on-fail',
  'runtime',
  'trigger',
];

const AUTONOMY_VALUES: readonly MinAutonomy[] = ['L1', 'L2', 'L3'];

/** Mirrors the `version` pattern in the generated plugin.json schema (D1 §2). */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Ports that run a single (order-first) plugin; 0 enabled = core stop (D2 §2.7). */
export const SINGLE_PORTS: readonly Port[] = ['task-source', 'executor'];

/** Default manifest filename in each plugin directory. */
export const MANIFEST_FILENAME = 'plugin.json';

/** Marker file that disables an otherwise-valid plugin without deleting it (D2 §6.3). */
export const DISABLED_MARKER = '.disabled';

/**
 * Sort key applied to plugins that declare neither an `order` field nor a numeric
 * filename prefix: they sort after every numbered plugin, then by name. Kept off
 * the integer axis so a real `order: 0` still precedes an unnumbered plugin.
 */
export const UNORDERED = Number.MAX_SAFE_INTEGER;

/** A validated, enabled plugin ready for the loop to launch through `runPort`. */
export interface DiscoveredPlugin {
  /** The port this plugin belongs to. */
  port: Port;
  /** Manifest `name`. */
  name: string;
  /** Directory basename (source of the numeric-prefix fallback for `order`). */
  dirName: string;
  /** Absolute plugin directory. */
  dir: string;
  /** Absolute path to the executable (`dir` + manifest `exec`). */
  execPath: string;
  /** Effective order used for the stable sort (field → prefix → {@link UNORDERED}). */
  order: number;
  /** The validated manifest. */
  manifest: PluginManifest;
}

/** A candidate that was skipped because its manifest was invalid (surfaced to doctor/loop). */
export interface DiscoveryIssue {
  dir: string;
  message: string;
}

/** Result of scanning one `<port>.d/` directory. */
export interface PortDiscovery {
  port: Port;
  /** Enabled, validated plugins in execution order. */
  plugins: DiscoveredPlugin[];
  /** Candidates excluded due to an invalid manifest. */
  issues: DiscoveryIssue[];
}

// --- pure helpers -----------------------------------------------------------

/**
 * Parse the leading numeric prefix of a `NN-name` directory (D2 §6.2). Returns
 * the integer, or `undefined` when there is no numeric prefix. Pure.
 */
export function parseNumericPrefix(basename: string): number | undefined {
  const m = /^(\d+)(?:[-_].*)?$/.exec(basename);
  return m ? Number(m[1]) : undefined;
}

/** True when a directory entry is a disabled plugin by its name (`*.disabled`). Pure. */
export function isDisabledName(name: string): boolean {
  return name.endsWith(DISABLED_MARKER);
}

/**
 * Effective order for sorting: explicit `order` field wins, else the filename's
 * numeric prefix, else {@link UNORDERED} (D2 §6.2). Pure.
 */
export function effectiveOrder(manifest: PluginManifest, dirName: string): number {
  if (typeof manifest.order === 'number') return manifest.order;
  return parseNumericPrefix(dirName) ?? UNORDERED;
}

/**
 * Deterministic comparison: `order` ascending, ties broken by manifest name
 * ascending so identical numbers never produce a non-deterministic order
 * (D2 §6.2 「番号が同一の場合は名前順で決定的に」). Pure.
 */
export function comparePlugins(a: DiscoveredPlugin, b: DiscoveredPlugin): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0;
}

/** Sort a copy of the list into execution order (D2 §6.2). Pure (no mutation). */
export function sortPlugins(plugins: readonly DiscoveredPlugin[]): DiscoveredPlugin[] {
  return [...plugins].sort(comparePlugins);
}

/**
 * Validate an already-parsed `plugin.json` object against the manifest contract
 * (D1 §2 — the TS type is the single source of truth, mirrored here so `core`
 * needs no JSON-Schema runtime). `expectedPort`, when given, must match the
 * manifest `port`. Throws {@link DiscoveryError} on any violation. Pure.
 */
export function validatePluginManifest(value: unknown, expectedPort?: Port): PluginManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DiscoveryError('plugin.json: root must be an object');
  }
  const obj = value as Record<string, unknown>;

  const name = requireString(obj, 'name');
  const version = requireString(obj, 'version');
  if (!SEMVER_RE.test(version)) {
    throw new DiscoveryError(`plugin.json: 'version' is not a valid semver: '${version}'`);
  }
  const port = requireString(obj, 'port');
  if (!(PORT_VALUES as readonly string[]).includes(port)) {
    throw new DiscoveryError(`plugin.json: 'port' must be one of ${PORT_VALUES.join(', ')} (got '${port}')`);
  }
  if (expectedPort && port !== expectedPort) {
    throw new DiscoveryError(`plugin.json: 'port' is '${port}' but was found under '${expectedPort}.d/'`);
  }
  const exec = requireString(obj, 'exec');

  const manifest: PluginManifest = { name, version, port: port as Port, exec };

  if ('order' in obj && obj.order !== undefined) {
    if (!Number.isInteger(obj.order)) throw new DiscoveryError("plugin.json: 'order' must be an integer");
    manifest.order = obj.order as number;
  }
  if ('minAutonomy' in obj && obj.minAutonomy !== undefined) {
    const a = obj.minAutonomy;
    if (typeof a !== 'string' || !(AUTONOMY_VALUES as readonly string[]).includes(a)) {
      throw new DiscoveryError(`plugin.json: 'minAutonomy' must be one of ${AUTONOMY_VALUES.join(', ')}`);
    }
    manifest.minAutonomy = a as MinAutonomy;
  }
  if ('timeoutSec' in obj && obj.timeoutSec !== undefined) {
    const t = obj.timeoutSec;
    if (!Number.isInteger(t) || (t as number) < 1) {
      throw new DiscoveryError("plugin.json: 'timeoutSec' must be an integer >= 1");
    }
    manifest.timeoutSec = t as number;
  }
  if ('env' in obj && obj.env !== undefined) {
    const env = obj.env;
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw new DiscoveryError("plugin.json: 'env' must be an object");
    }
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new DiscoveryError(`plugin.json: env['${k}'] must be a string`);
    }
    manifest.env = env as Record<string, string>;
  }

  const known = new Set(['name', 'version', 'port', 'exec', 'order', 'minAutonomy', 'timeoutSec', 'env']);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) throw new DiscoveryError(`plugin.json: unknown field '${key}' (additionalProperties: false)`);
  }
  return manifest;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v === '') throw new DiscoveryError(`plugin.json: '${key}' is required and must be a non-empty string`);
  return v;
}

// --- single-port population check (D2 §2.7) ---------------------------------

/** True for ports whose absence of any enabled plugin must stop the core. */
export function isSinglePort(port: Port): boolean {
  return SINGLE_PORTS.includes(port);
}

export type SinglePortCheck = { ok: true } | { ok: false; reason: string };

/**
 * A single-port (`task-source` / `executor`) with 0 enabled plugins is a
 * configuration error, not a stop condition — the core must halt rather than run
 * silently (D2 §2.7). Non-single ports are always `ok`. Pure.
 */
export function checkSinglePortPopulated(discovery: PortDiscovery): SinglePortCheck {
  if (isSinglePort(discovery.port) && discovery.plugins.length === 0) {
    return { ok: false, reason: `no enabled plugin found for single port '${discovery.port}'` };
  }
  return { ok: true };
}

// --- filesystem seam + side-effecting scan ----------------------------------

/** One entry from a directory listing (subset of `fs.Dirent`). */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** Injected filesystem seam so the scan stays testable without real dirs. */
export interface DiscoveryFs {
  /** List a directory. Should resolve to `[]` when the directory does not exist. */
  readDir(path: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export interface DiscoverPortOptions {
  /** Absolute path to the target repo's `.halo` directory. */
  haloRoot: string;
  port: Port;
  fs: DiscoveryFs;
  /** Also require the resolved `exec` to exist (off by default). */
  requireExec?: boolean;
}

/** Absolute path to a port's plugin directory (`<haloRoot>/ports/<port>.d`). Pure. */
export function portDir(haloRoot: string, port: Port): string {
  return join(haloRoot, 'ports', `${port}.d`);
}

/**
 * Scan one `<port>.d/` directory: each immediate subdirectory holding a
 * `plugin.json` is a candidate. Disabled entries (name `*.disabled` or a
 * `.disabled` marker file) and non-plugin dirs are skipped; candidates whose
 * manifest is invalid are excluded and reported in `issues` (they must not
 * silently pass, D1 §6.2). Returns plugins in execution order (D2 §6).
 */
export async function discoverPort(options: DiscoverPortOptions): Promise<PortDiscovery> {
  const { haloRoot, port, fs } = options;
  const base = portDir(haloRoot, port);
  const entries = await fs.readDir(base);
  const plugins: DiscoveredPlugin[] = [];
  const issues: DiscoveryIssue[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory || isDisabledName(entry.name)) continue;
    const dir = join(base, entry.name);

    const manifestPath = join(dir, MANIFEST_FILENAME);
    if (!(await fs.exists(manifestPath))) continue; // not a plugin directory
    if (await fs.exists(join(dir, DISABLED_MARKER))) continue; // disabled in place

    let manifest: PluginManifest;
    try {
      manifest = validatePluginManifest(parseJson(await fs.readFile(manifestPath), manifestPath), port);
    } catch (err) {
      issues.push({ dir, message: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const execPath = join(dir, manifest.exec);
    if (options.requireExec && !(await fs.exists(execPath))) {
      issues.push({ dir, message: `exec not found: ${manifest.exec}` });
      continue;
    }

    plugins.push({
      port,
      name: manifest.name,
      dirName: entry.name,
      dir,
      execPath,
      order: effectiveOrder(manifest, entry.name),
      manifest,
    });
  }

  return { port, plugins: sortPlugins(plugins), issues };
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DiscoveryError(`plugin.json: invalid JSON in ${path}`);
  }
}

// --- upward search for `.harness.yml` (D2 §7) -------------------------------

/** Filename of the required per-repo kind declaration (D1 §1.8). */
export const HARNESS_FILENAME = '.harness.yml';

/**
 * Walk from `startDir` toward the filesystem root looking for `filename`,
 * returning its absolute path or `null` (D2 §7.1). The walk stops after checking
 * the directory that contains a `.git` entry (repository root) or once the root
 * is reached. Uses the injected {@link DiscoveryFs} so it stays testable.
 */
export async function findUpwards(startDir: string, filename: string, fs: DiscoveryFs): Promise<string | null> {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, filename);
    if (await fs.exists(candidate)) return candidate;
    // Stop at the repository root (`.git` present) after having checked this dir.
    if (await fs.exists(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/** Convenience wrapper: upward search for `.harness.yml` (D2 §7). */
export function findHarnessYml(startDir: string, fs: DiscoveryFs): Promise<string | null> {
  return findUpwards(startDir, HARNESS_FILENAME, fs);
}

// --- real-filesystem seam ---------------------------------------------------

/**
 * A {@link DiscoveryFs} backed by `node:fs/promises`. Missing directories list as
 * `[]` (ENOENT is not an error for discovery). Used by the CLI; tests inject fakes.
 */
export function createNodeDiscoveryFs(): DiscoveryFs {
  return {
    async readDir(path) {
      const { readdir } = await import('node:fs/promises');
      try {
        const dirents = await readdir(path, { withFileTypes: true });
        return dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile() }));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    },
    async readFile(path) {
      const { readFile } = await import('node:fs/promises');
      return readFile(path, 'utf8');
    },
    async exists(path) {
      const { access } = await import('node:fs/promises');
      return access(path).then(
        () => true,
        () => false,
      );
    },
  };
}
