// harness — read, parse, validate and resolve `.harness.yml` (D1 §1.8, D2 §7).
//
// `.harness.yml` is the committed, per-repository declaration the core actually
// obeys: which runtimes and prompt template each task `kind` maps to, plus the
// safety caps of ADR-0004 (`maxAutonomy`, `protectedPaths`). Because the file is
// itself a loop-audit protected path, anything declared here is a cap an
// unattended run cannot raise from inside — which is the whole point of putting
// the ceiling in git rather than in an ignored profile.
//
// The YAML parser below is a deliberately small, strict subset — enough for the
// declaration `halo project init` generates and nothing more. HALO ships with no
// third-party runtime dependencies, and a config file carrying a safety ceiling is
// the wrong place to be permissive: every construct outside the subset raises
// {@link ConfigError} instead of being guessed at or silently ignored.
//
// Supported: block mappings (2-space or any consistent indent), `key: value`
// scalars, single/double-quoted scalars, `#` comments, flow sequences of scalars
// (`[a, b]`), and block sequences of scalars (`- item`).
// Rejected: tabs, document markers, block scalars (`|`, `>`), flow mappings,
// anchors/aliases, duplicate keys, and any line that is not one of the above.
//
// One deliberate deviation from YAML: **every scalar stays a string**. A real YAML
// loader would read `port: 8080` as a number and `on: yes` as a boolean; this one
// yields `'8080'` and `'yes'`. Every field of the `.harness.yml` contract is
// string-typed, so there is nothing to gain from type inference and a good deal to
// lose from its surprises. Cross-checked against PyYAML on the declarations
// `halo project init` generates: identical apart from this rule.

import { ConfigError, validateHarnessYml } from './config.js';
import { findHarnessYml, type DiscoveryFs } from './discovery.js';
import type { HarnessYml } from '@tsurupong/halo-contracts';

// --- YAML subset parser ------------------------------------------------------

interface Line {
  indent: number;
  text: string;
  /** 1-based source line, carried into every error message. */
  no: number;
}

function fail(no: number, message: string): never {
  throw new ConfigError(`.harness.yml:${no}: ${message}`);
}

/**
 * Strip a trailing `#` comment, respecting quoted scalars. A `#` only starts a
 * comment at the start of the line or after whitespace (YAML's own rule), so
 * `b: z # trailing` loses the comment while `a: "x # y"` keeps it.
 */
function stripComment(line: string): string {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

/** Tokenise into significant lines, rejecting tabs and document markers up front. */
function scan(text: string): Line[] {
  const out: Line[] = [];
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const source = raw[i]!;
    const no = i + 1;
    const stripped = stripComment(source);
    if (stripped.trim() === '') continue;
    if (/^\s*(---|\.\.\.)\s*$/.test(stripped))
      fail(no, 'document markers (`---`) are not supported');
    const leading = stripped.slice(0, stripped.length - stripped.trimStart().length);
    if (leading.includes('\t')) fail(no, 'tabs are not allowed for indentation (use spaces)');
    out.push({ indent: leading.length, text: stripped.trim(), no });
  }
  return out;
}

/** Remove one layer of matching quotes; bare scalars are returned as-is. */
function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** Split a flow sequence body on commas that are not inside quotes. */
function splitFlow(body: string, no: number): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  for (const ch of body) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote !== undefined) fail(no, 'unterminated quoted scalar');
  parts.push(current);
  return parts;
}

/**
 * Parse an inline value: a flow sequence of scalars or a single scalar. Every
 * scalar stays a string — the whole `.harness.yml` contract is string-typed, so
 * there is nothing to gain from guessing numbers or booleans.
 */
function parseInlineValue(raw: string, no: number): unknown {
  const value = raw.trim();
  if (value.startsWith('{')) fail(no, 'flow mappings (`{...}`) are not supported');
  if (value.startsWith('&')) fail(no, 'anchors (`&name`) are not supported');
  if (value.startsWith('*')) fail(no, 'aliases (`*name`) are not supported');
  if (value === '|' || value === '>' || /^[|>][-+\d]*$/.test(value))
    fail(no, 'block scalars (`|`, `>`) are not supported');
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) fail(no, 'unterminated flow sequence (expected `]`)');
    const body = value.slice(1, -1).trim();
    if (body === '') return [];
    return splitFlow(body, no).map((item) => {
      const scalar = item.trim();
      if (scalar === '') fail(no, 'empty item in flow sequence');
      return unquote(scalar);
    });
  }
  return unquote(value);
}

/**
 * Split `key: value` at the first `: ` (or a trailing `:`) outside quotes, so a
 * value may itself contain a colon (`prompt: https://example.com/x`).
 * Returns undefined when the line is not a mapping entry at all.
 */
function splitKey(text: string): { key: string; rest?: string } | undefined {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== ':') continue;
    const next = text[i + 1];
    if (next === undefined) return { key: text.slice(0, i) };
    if (/\s/.test(next)) return { key: text.slice(0, i), rest: text.slice(i + 1).trim() };
  }
  return undefined;
}

function parseNode(lines: Line[], start: number, indent: number): [unknown, number] {
  const head = lines[start]!;
  return head.text === '-' || head.text.startsWith('- ')
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): [unknown[], number] {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    if (line.text !== '-' && !line.text.startsWith('- ')) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (rest === '') fail(line.no, 'nested block sequences are not supported');
    if (splitKey(rest) !== undefined) fail(line.no, 'mappings inside a sequence are not supported');
    items.push(parseInlineValue(rest, line.no));
    i++;
  }
  if (i < lines.length && lines[i]!.indent > indent)
    fail(lines[i]!.no, 'unexpected indentation inside a sequence');
  return [items, i];
}

function parseMapping(
  lines: Line[],
  start: number,
  indent: number,
): [Record<string, unknown>, number] {
  const map: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    if (line.text === '-' || line.text.startsWith('- '))
      fail(line.no, 'unexpected sequence item inside a mapping');
    const split = splitKey(line.text);
    if (split === undefined) fail(line.no, `expected \`key: value\`, got '${line.text}'`);
    const key = unquote(split.key.trim());
    if (key === '') fail(line.no, 'empty key');
    if (Object.prototype.hasOwnProperty.call(map, key)) fail(line.no, `duplicate key '${key}'`);
    i++;

    if (split.rest !== undefined && split.rest !== '') {
      map[key] = parseInlineValue(split.rest, line.no);
      continue;
    }
    // `key:` with no inline value — the value is the deeper-indented block below.
    const child = lines[i];
    if (child === undefined || child.indent <= indent) fail(line.no, `key '${key}' has no value`);
    const [value, next] = parseNode(lines, i, child.indent);
    map[key] = value;
    i = next;
  }
  if (i < lines.length && lines[i]!.indent > indent) fail(lines[i]!.no, 'inconsistent indentation');
  return [map, i];
}

/**
 * Parse `.harness.yml` text into a plain object using the strict subset above.
 * Structure only — contract validation is {@link validateHarnessYml}'s job. Pure.
 */
export function parseHarnessYaml(text: string): unknown {
  const lines = scan(text);
  if (lines.length === 0) throw new ConfigError('.harness.yml: document is empty');
  const first = lines[0]!;
  if (first.indent !== 0) fail(first.no, 'the document must start at column 0');
  const [value, next] = parseNode(lines, 0, 0);
  if (next < lines.length) fail(lines[next]!.no, 'inconsistent indentation');
  return value;
}

// --- load + kind resolution --------------------------------------------------

/** A located, parsed and contract-valid `.harness.yml`. */
export interface LoadedHarness {
  /** Absolute path of the declaration (its directory anchors relative prompt paths). */
  path: string;
  harness: HarnessYml;
}

/**
 * Find the nearest `.harness.yml` above `startDir`, then parse and validate it
 * (D2 §7). Returns null when the repository has none — the caller decides whether
 * that is fatal (preflight heavy treats it as `NO_HARNESS_YML`). Throws
 * {@link ConfigError}, with the file path attached, when one exists but is broken:
 * a malformed safety declaration must stop the run, not be skipped.
 */
export async function loadHarnessYml(
  startDir: string,
  fs: DiscoveryFs,
): Promise<LoadedHarness | null> {
  const path = await findHarnessYml(startDir, fs);
  if (path === null) return null;
  const body = await fs.readFile(path);
  try {
    return { path, harness: validateHarnessYml(parseHarnessYaml(body)) };
  } catch (err) {
    if (err instanceof ConfigError) {
      // Re-anchor the message on the real path: the parser only knows the filename.
      throw new ConfigError(err.message.replace(/^\.harness\.yml/, path));
    }
    throw err;
  }
}

/** The kind's prompt template, or the reason the loop must escalate to a human. */
export type KindPrompt =
  | {
      status: 'resolved';
      kind: string;
      runtimes: string[];
      instructions: string;
      executor?: string;
    }
  | { status: 'needs-human'; kind: string; reason: string };

function dirnameOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function resolveRelative(baseDir: string, path: string): string {
  return path.startsWith('/') ? path : `${baseDir.replace(/\/$/, '')}/${path}`;
}

/**
 * Resolve a task `kind` to its runtimes plus the body of its prompt template
 * (D2 §7.2). Relative `prompt` paths are anchored at the declaration's directory,
 * so a repo that keeps prompts outside `.halo/` works unchanged.
 *
 * An undefined kind, or a declared template that is missing/unreadable, yields
 * `needs-human` rather than throwing: a misconfigured kind must escalate the task,
 * not crash the loop (D2 §2.7).
 */
export async function readKindPrompt(
  harness: HarnessYml,
  harnessPath: string,
  kindLabel: string | undefined,
  fs: DiscoveryFs,
  defaultKind = 'code',
): Promise<KindPrompt> {
  const kind = kindLabel !== undefined && kindLabel !== '' ? kindLabel : defaultKind;
  const def = harness.kinds[kind];
  if (!def) {
    return { status: 'needs-human', kind, reason: `kind '${kind}' is not defined in .harness.yml` };
  }
  const promptPath = resolveRelative(dirnameOf(harnessPath), def.prompt);
  try {
    const instructions = await fs.readFile(promptPath);
    return {
      status: 'resolved',
      kind,
      runtimes: [...def.runtimes],
      instructions,
      ...(def.executor != null ? { executor: def.executor } : {}),
    };
  } catch {
    return {
      status: 'needs-human',
      kind,
      reason: `kind '${kind}' declares prompt '${def.prompt}' but it could not be read (${promptPath})`,
    };
  }
}
