// gate-runtime-check 共通委譲ロジック(D1 §1.4 / D5 §2.4)。
// gate.in JSON {task_id, workdir, changed_files} を runtime.in {workdir, changed_files} に変換し、
// 採用 runtime(既定: 隣接の runtime-node-pnpm、HALO_RUNTIME_DIR で上書き)の plugin.json の
// entry/aux から解決したスクリプトへ委譲する(HALO_PLUGIN_DIR + manifest ベース、ADR-0017)。
// 終了コードを gate 規約へ伝播: pass=exit 0(stdout 空)/ fail=exit 2 + gate.out {reason, gate}。
// gate 側にコマンドを重複させない薄いラッパー(DRY、D5 §3.2 の注記)。
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readStdinJson, writeStdoutJson, str } from '../lib/io.js';

function emitFail(reason: string, gate: string): never {
  writeStdoutJson({ reason, gate });
  process.exit(2);
}

/** gate 名と runtime ロール('check'|'test'|'setup')を受け、runtime へ委譲して gate 規約で終了する。 */
export async function delegate(gate: string, runtimeRole: 'check' | 'test' | 'setup'): Promise<never> {
  const pluginDir = process.env['HALO_PLUGIN_DIR'] ?? '.';
  const runtimeDir =
    process.env['HALO_RUNTIME_DIR'] ?? join(pluginDir, '..', '..', 'runtime.d', 'runtime-node-pnpm');

  const input = await readStdinJson().catch(() => undefined);
  const workdir = str(input, 'workdir');
  if (workdir === undefined) emitFail('invalid gate input: workdir required', gate);

  const manifestPath = join(runtimeDir, 'plugin.json');
  if (!existsSync(manifestPath)) emitFail(`runtime plugin.json not found: ${manifestPath}`, gate);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    entry?: string;
    aux?: Record<string, string>;
  };
  const rel = runtimeRole === 'setup' ? manifest.entry : manifest.aux?.[runtimeRole];
  if (rel === undefined) emitFail(`runtime entry '${runtimeRole}' not declared: ${manifestPath}`, gate);
  const scriptPath = isAbsolute(rel) ? rel : join(runtimeDir, rel);
  if (!existsSync(scriptPath)) emitFail(`runtime script not found: ${scriptPath}`, gate);

  const changed =
    typeof input === 'object' && input !== null
      ? ((input as Record<string, unknown>)['changed_files'] ?? [])
      : [];

  // runtime.in へ変換して委譲。runtime の stdout は契約上空だが、念のため stderr へ寄せて
  // gate の JSON 契約チャネル(stdout)を汚さない。
  const r = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify({ workdir, changed_files: changed }),
    stdio: ['pipe', 2, 2],
  });
  const code = r.error !== undefined ? 127 : (r.status ?? 1);

  if (code !== 0) emitFail(`${gate} failed (runtime ${runtimeRole} exit ${code})`, gate);
  process.exit(0);
}
