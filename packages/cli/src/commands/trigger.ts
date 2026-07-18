// `halo trigger install|uninstall|list` (T27, D3 §2.3): entry 契約 (plugin.json の
// aux.install/aux.uninstall) の解決と spawn、終了コード写像のみ。実処理は各アダプタの
// TS 実装 (ADR-0017)。CLI は名前検証と spawn 回収だけ。
import { type ParsedArgs } from '../args.js';
import type { ExitCode } from '../exit-codes.js';
import { EXIT, usageError, runtimeError } from '../exit-codes.js';
import type { Io } from '../io.js';
import type { CliFs } from '../core-ext/fs.js';
import {
  installTrigger,
  uninstallTrigger,
  listTriggers,
  isSafeName,
  type SpawnAdapter,
  type TriggerContext,
} from '../core-ext/triggers.js';

export interface TriggerDeps {
  fs: CliFs;
  spawn: SpawnAdapter;
}

const USAGE =
  'usage: halo trigger <install <name> <profile> | uninstall <name> [<profile>] | list>';

function haloDirOf(cwd: string): string {
  return `${cwd.replace(/\/$/, '')}/.halo`;
}

export async function triggerCommand(
  parsed: ParsedArgs,
  io: Io,
  deps: TriggerDeps,
): Promise<ExitCode> {
  const [sub, ...rest] = parsed.positionals;
  const ctx: TriggerContext = {
    haloDir: haloDirOf(io.flags.cwd),
    cwd: io.flags.cwd,
    fs: deps.fs,
    spawn: deps.spawn,
  };

  switch (sub) {
    case 'install':
      return install(ctx, rest, io);
    case 'uninstall':
      return uninstall(ctx, rest, io);
    case 'list':
      return list(ctx, io);
    default:
      throw usageError(`unknown trigger subcommand: ${sub ?? '(none)'}`, { usage: USAGE });
  }
}

function validateName(name: string | undefined, label: string): string {
  if (name === undefined) throw usageError(`missing ${label}`, { usage: USAGE });
  if (!isSafeName(name))
    throw usageError(`invalid ${label}: '${name}' (allowed: A-Z a-z 0-9 . _ -)`, { usage: USAGE });
  return name;
}

async function install(ctx: TriggerContext, args: string[], io: Io): Promise<ExitCode> {
  const name = validateName(args[0], 'trigger name');
  const profile = validateName(args[1], 'profile');
  let result;
  try {
    result = await installTrigger(ctx, name, profile);
  } catch (err) {
    throw usageError((err as Error).message, {
      usage: USAGE,
      hint: "run 'halo trigger list' to see enabled adapters",
    });
  }
  if (result.exitCode !== 0) {
    throw runtimeError(
      `trigger install failed: ${name} (${profile}) — adapter exit ${result.exitCode}`,
      {
        hint: result.stderr.trim().split('\n').pop(),
      },
    );
  }
  if (io.flags.json) io.printJson({ ok: true, action: 'install', name, profile });
  else io.print(`登録しました: ${name} (${profile})`);
  return EXIT.OK;
}

async function uninstall(ctx: TriggerContext, args: string[], io: Io): Promise<ExitCode> {
  const name = validateName(args[0], 'trigger name');
  const profile = args[1];
  if (profile !== undefined) validateName(profile, 'profile');
  let result;
  try {
    result = await uninstallTrigger(ctx, name, profile);
  } catch (err) {
    throw usageError((err as Error).message, { usage: USAGE });
  }
  // 冪等: 未登録でもアダプタは exit 0 を返す契約 (D3 §2.3)。非 0 のみ異常。
  if (result.exitCode !== 0) {
    throw runtimeError(`trigger uninstall failed: ${name} — adapter exit ${result.exitCode}`, {
      hint: result.stderr.trim().split('\n').pop(),
    });
  }
  if (io.flags.json)
    io.printJson({ ok: true, action: 'uninstall', name, profile: profile ?? null });
  else io.print(`解除しました: ${name}${profile ? ` (${profile})` : ' (全プロファイル)'}`);
  return EXIT.OK;
}

async function list(ctx: TriggerContext, io: Io): Promise<ExitCode> {
  const entries = await listTriggers(ctx);
  if (io.flags.json) {
    io.printJson({ ok: true, triggers: entries });
    return EXIT.OK;
  }
  if (entries.length === 0) {
    io.print('登録トリガーはありません。');
    return EXIT.OK;
  }
  for (const e of entries) {
    io.print(`${e.name}\t${e.alive ? 'alive' : 'DEAD (要再登録)'}\t${e.fire}`);
  }
  return EXIT.OK;
}
