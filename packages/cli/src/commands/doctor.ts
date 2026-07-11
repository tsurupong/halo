// `halo doctor` (T28, D3 §4): core-ext/doctor.runAll の結果を OK/WARN/FAIL 集計 →
// 終了コード写像 (D3 §5.2)。--fix は scaffold.repair で骨格欠損のみ補完。
import { boolFlag, type ParsedArgs } from '../args.js';
import type { ExitCode } from '../exit-codes.js';
import type { Io } from '../io.js';
import { runAll, type DoctorProbes } from '../core-ext/doctor.js';
import { repairSkeleton } from '../core-ext/scaffold.js';
import type { CliFs } from '../core-ext/fs.js';

export interface DoctorDeps {
  probes: DoctorProbes;
  fs: CliFs;
}

export async function doctorCommand(
  parsed: ParsedArgs,
  io: Io,
  deps: DoctorDeps,
): Promise<ExitCode> {
  if (boolFlag(parsed, 'fix')) {
    // 骨格の欠損補完のみ (トリガー再登録は明示操作に限定, D3 §2.6)。
    const repair = await repairSkeleton({
      cwd: io.flags.cwd,
      fs: deps.fs,
      kinds: ['code'],
      runtime: 'node-pnpm',
    });
    if (repair.created.length > 0) io.warn(`--fix: ${repair.created.length} 件を補完`);
  }

  const report = await runAll(deps.probes);

  if (io.flags.json) {
    io.printJson({
      ok: report.fail === 0,
      summary: { ok: report.ok, warn: report.warn, fail: report.fail },
      checks: report.checks,
    });
    return report.exitCode as ExitCode;
  }

  for (const c of report.checks) {
    const line = `[${c.status}] ${c.id}. ${c.title}: ${c.detail}`;
    if (c.status === 'FAIL') io.streams.err(`${line}\n`);
    else io.print(line);
  }
  io.print(`--- OK ${report.ok} / WARN ${report.warn} / FAIL ${report.fail} ---`);
  return report.exitCode as ExitCode;
}
