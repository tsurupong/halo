// gate-runtime-check 共通委譲ロジック(D1 §1.4 / D5 §2.4)。
// gate.in JSON {task_id, workdir, changed_files} を runtime.in {workdir, changed_files} に変換し、
// 採用 runtime(既定: 隣接の runtime-node-pnpm、HALO_RUNTIME_DIR で上書き)の指定スクリプトへ委譲する。
// 終了コードを gate 規約へ伝播: pass=exit 0(stdout 空)/ fail=exit 2 + gate.out {reason, gate}。
// gate 側にコマンドを重複させない薄いラッパー(DRY、D5 §3.2 の注記)。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readStdinJson, writeStdoutJson, str } from '../lib/io.js';

function emitFail(reason: string, gate: string): never {
  writeStdoutJson({ reason, gate });
  process.exit(2);
}

/** gate 名と runtime スクリプト名を受け、runtime へ委譲して gate 規約で終了する。 */
export async function delegate(gate: string, runtimeScript: string): Promise<never> {
  // ランチャー(plugins/gate-runtime-check/<gate>/run.sh)が HALO_LAUNCHER_DIR に自身の
  // ディレクトリを入れて起動する。既定 runtime はその隣接 plugins/runtime-node-pnpm。
  const launcherDir = process.env['HALO_LAUNCHER_DIR'] ?? '.';
  const runtimeDir =
    process.env['HALO_RUNTIME_DIR'] ?? join(launcherDir, '..', '..', 'runtime-node-pnpm');

  const input = await readStdinJson().catch(() => undefined);
  const workdir = str(input, 'workdir');
  if (workdir === undefined) emitFail('invalid gate input: workdir required', gate);

  const scriptPath = join(runtimeDir, runtimeScript);
  if (!existsSync(scriptPath)) emitFail(`runtime script not found: ${scriptPath}`, gate);

  const changed =
    typeof input === 'object' && input !== null
      ? ((input as Record<string, unknown>)['changed_files'] ?? [])
      : [];
  const runtimeIn = JSON.stringify({ workdir, changed_files: changed });

  // runtime.in へ変換して委譲。runtime の stdout は契約上空だが、念のため stderr へ寄せて
  // gate の JSON 契約チャネル(stdout)を汚さない。
  const r = spawnSync('sh', [scriptPath], {
    input: runtimeIn,
    stdio: ['pipe', 2, 2],
  });
  const code = r.error !== undefined ? 127 : (r.status ?? 1);

  if (code !== 0) emitFail(`${gate} failed (runtime ${runtimeScript} exit ${code})`, gate);
  process.exit(0);
}
