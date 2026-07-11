// 依存ゼロの最小引数パーサ (D3 §2). 位置引数とフラグを分離するだけの薄い層。
// commander 等は入れない — CLI はロジックを持たない原則 (D3 §0) に沿い外形のみ扱う。
import { usageError } from './exit-codes.js';

/** 短縮エイリアス → 正規フラグ名。 */
const ALIASES: Record<string, string> = {
  q: 'quiet',
  v: 'verbose',
  h: 'help',
};

export interface ParsedArgs {
  positionals: string[];
  /** bool フラグは true、値フラグは文字列。反復値フラグは配列。 */
  flags: Record<string, string | boolean | string[]>;
}

export interface ParseOptions {
  /** 値を取るフラグ名 (正規名)。ここに無いフラグは bool 扱い。 */
  valueFlags?: readonly string[];
  /** 複数回指定を配列に集約するフラグ名 (例: --kind)。 */
  repeatFlags?: readonly string[];
}

/**
 * `argv`（コマンド名を除いた残り）を位置引数とフラグに分解する。純粋関数。
 * `--flag=value` / `--flag value` / `--bool` / 短縮 `-q` を解する。`--` 以降は
 * すべて位置引数。未知フラグでも失敗はしない (値要求フラグの欠損のみ usage error)。
 */
export function parseArgs(argv: readonly string[], options: ParseOptions = {}): ParsedArgs {
  const valueFlags = new Set(options.valueFlags ?? []);
  const repeatFlags = new Set(options.repeatFlags ?? []);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (passthrough || !token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }

    const raw = token.startsWith('--') ? token.slice(2) : token.slice(1);
    const eq = raw.indexOf('=');
    let name = eq >= 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
    name = ALIASES[name] ?? name;

    if (valueFlags.has(name)) {
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined) {
          throw usageError(`flag --${name} requires a value`);
        }
        value = next;
        i++;
      }
      assignFlag(flags, name, value, repeatFlags.has(name));
    } else {
      // bool フラグ。`--no-foo` は foo=false として扱う (D3 §2.2 --no-gitignore)。
      if (name.startsWith('no-')) {
        flags[name.slice(3)] = false;
      } else {
        flags[name] = inlineValue ?? true;
      }
    }
  }

  return { positionals, flags };
}

function assignFlag(
  flags: Record<string, string | boolean | string[]>,
  name: string,
  value: string,
  repeat: boolean,
): void {
  if (!repeat) {
    flags[name] = value;
    return;
  }
  const existing = flags[name];
  if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    flags[name] = [value];
  }
}

/** 値フラグを文字列として取り出す (bool/未指定は undefined)。 */
export function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const v = parsed.flags[name];
  return typeof v === 'string' ? v : undefined;
}

/** bool フラグの真偽 (未指定は既定値)。 */
export function boolFlag(parsed: ParsedArgs, name: string, fallback = false): boolean {
  const v = parsed.flags[name];
  if (typeof v === 'boolean') return v;
  if (v === undefined) return fallback;
  return true;
}

/** 反復値フラグを配列として取り出す (単一指定も配列化)。 */
export function arrayFlag(parsed: ParsedArgs, name: string): string[] {
  const v = parsed.flags[name];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return [v];
  return [];
}
