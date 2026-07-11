// doctor の 9 検査 (D3 §4)。判定は各検査を純粋関数化し、環境事実 (バイナリ存在・
// 認証・パス整合) は Probes シームから注入してテスト可能にする。CLI は集計結果を
// 終了コードへ写像するだけ (D3 §5.2: FAIL あり=1 / WARN のみ=0)。
import type { CliFs } from './fs.js';
import { PORT_DIRS } from './scaffold.js';
import { resolveBinPath, listTriggers, type TriggerContext } from './triggers.js';

export type CheckStatus = 'OK' | 'WARN' | 'FAIL';

export interface CheckResult {
  id: number;
  title: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  ok: number;
  warn: number;
  fail: number;
  /** FAIL があれば exit 1、無ければ 0 (D3 §5.2)。 */
  exitCode: 0 | 1;
}

/** 外部コマンドの存在・応答・認証を返すシーム (実装はモック可)。 */
export interface CommandProbe {
  /** バイナリが PATH に存在するか。 */
  exists(bin: string): Promise<boolean>;
  /** `gh auth status` の判定。authenticated=未認証は false。scope で過剰権限を示す。 */
  ghAuth(): Promise<{ authenticated: boolean; overprivileged: boolean }>;
  /** `claude --version` が応答するか。 */
  claudeResponds(): Promise<boolean>;
  /** git 作業ツリー情報。 */
  gitStatus(): Promise<{ isRepo: boolean; hasUserName: boolean; hasUserEmail: boolean }>;
}

export interface DoctorProbes {
  haloDir: string;
  cwd: string;
  fs: CliFs;
  command: CommandProbe;
  triggerCtx: TriggerContext;
  /** クラッシュ後の孤児ロックが残っているか (flock 残留)。 */
  orphanLock(): Promise<boolean>;
  /** `.halo/` と worktree 先が ext4 側 (/mnt/c 配下でない) か。 */
  onExt4(): Promise<boolean>;
  /** worktree 展開に足る空き容量があるか。 */
  diskOk(): Promise<boolean>;
}

// --- 個別検査 (純粋: 事実→CheckResult) ------------------------------------

export function checkTriggerLiveness(
  entries: { name: string; fire: string; alive: boolean }[],
  binPath: string,
): CheckResult {
  const dead = entries.filter((e) => !e.alive);
  if (entries.length === 0) {
    return { id: 1, title: 'トリガー生存', status: 'OK', detail: '登録トリガーなし' };
  }
  if (dead.length > 0) {
    return {
      id: 1,
      title: 'トリガー生存',
      status: 'FAIL',
      detail: `パス不整合: ${dead.map((d) => d.name).join(', ')} — 'halo trigger install' で再登録 (期待 bin: ${binPath})`,
    };
  }
  return { id: 1, title: 'トリガー生存', status: 'OK', detail: `${entries.length} 件が整合` };
}

export function checkSkeleton(missing: string[]): CheckResult {
  if (missing.length === 0)
    return { id: 2, title: '.halo/ 骨格', status: 'OK', detail: '必須ディレクトリ・宣言あり' };
  return {
    id: 2,
    title: '.halo/ 骨格',
    status: 'FAIL',
    detail: `欠損: ${missing.join(', ')} — 'halo doctor --fix' で補完`,
  };
}

export function checkHarnessValid(present: boolean, valid: boolean, reason?: string): CheckResult {
  if (!present)
    return {
      id: 3,
      title: '.harness.yml 妥当性',
      status: 'FAIL',
      detail: '.harness.yml が存在しません',
    };
  if (!valid)
    return {
      id: 3,
      title: '.harness.yml 妥当性',
      status: 'FAIL',
      detail: reason ?? 'Schema 不適合',
    };
  return { id: 3, title: '.harness.yml 妥当性', status: 'OK', detail: 'Schema 準拠' };
}

export function checkGh(
  exists: boolean,
  auth: { authenticated: boolean; overprivileged: boolean },
): CheckResult {
  if (!exists)
    return { id: 4, title: 'gh 存在・認証', status: 'FAIL', detail: 'gh バイナリが見つかりません' };
  if (!auth.authenticated)
    return {
      id: 4,
      title: 'gh 存在・認証',
      status: 'FAIL',
      detail: '未認証 — `gh auth login` を実行',
    };
  if (auth.overprivileged)
    return {
      id: 4,
      title: 'gh 存在・認証',
      status: 'WARN',
      detail: '権限過剰 (repo フルスコープ) — fine-grained PAT を推奨',
    };
  return { id: 4, title: 'gh 存在・認証', status: 'OK', detail: '認証済み・適正権限' };
}

export function checkClaude(exists: boolean, responds: boolean): CheckResult {
  if (!exists)
    return {
      id: 5,
      title: 'claude 存在',
      status: 'FAIL',
      detail: 'claude バイナリが見つかりません',
    };
  if (!responds)
    return {
      id: 5,
      title: 'claude 存在',
      status: 'FAIL',
      detail: 'claude --version が応答しません',
    };
  return { id: 5, title: 'claude 存在', status: 'OK', detail: '応答あり' };
}

export function checkGit(
  exists: boolean,
  status: { isRepo: boolean; hasUserName: boolean; hasUserEmail: boolean },
): CheckResult {
  if (!exists)
    return {
      id: 6,
      title: 'git 存在・作業ツリー',
      status: 'FAIL',
      detail: 'git バイナリが見つかりません',
    };
  if (!status.isRepo)
    return {
      id: 6,
      title: 'git 存在・作業ツリー',
      status: 'FAIL',
      detail: 'git リポジトリではありません',
    };
  if (!status.hasUserName || !status.hasUserEmail) {
    return {
      id: 6,
      title: 'git 存在・作業ツリー',
      status: 'FAIL',
      detail: 'user.name / user.email が未設定',
    };
  }
  return {
    id: 6,
    title: 'git 存在・作業ツリー',
    status: 'OK',
    detail: 'リポジトリ・identity 設定済み',
  };
}

export function checkLockStop(orphanLock: boolean, stopPresent: boolean): CheckResult {
  const issues: string[] = [];
  if (orphanLock) issues.push('孤児 flock 残留');
  if (stopPresent) issues.push('.halo/STOP 残存');
  if (issues.length === 0)
    return { id: 7, title: 'flock / STOP 残留', status: 'OK', detail: '残留なし' };
  return { id: 7, title: 'flock / STOP 残留', status: 'WARN', detail: issues.join(', ') };
}

export function checkPlacement(onExt4: boolean): CheckResult {
  if (onExt4) return { id: 8, title: '配置制約 (WSL2)', status: 'OK', detail: 'ext4 側に配置' };
  return {
    id: 8,
    title: '配置制約 (WSL2)',
    status: 'WARN',
    detail: '/mnt/c 配下の可能性 — ext4 側 (~) への配置を推奨',
  };
}

export function checkDisk(diskOk: boolean): CheckResult {
  if (diskOk) return { id: 9, title: 'ディスク残量', status: 'OK', detail: 'worktree 展開に十分' };
  return { id: 9, title: 'ディスク残量', status: 'WARN', detail: '空き容量が少ない可能性' };
}

/** 集計 → 終了コード写像 (D3 §5.2)。 */
export function aggregate(checks: CheckResult[]): DoctorReport {
  const ok = checks.filter((c) => c.status === 'OK').length;
  const warn = checks.filter((c) => c.status === 'WARN').length;
  const fail = checks.filter((c) => c.status === 'FAIL').length;
  return { checks, ok, warn, fail, exitCode: fail > 0 ? 1 : 0 };
}

function join(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/$/, '') : p.replace(/^\/|\/$/g, '')))
    .join('/');
}

/** §4 の全 9 検査を実行して集計する。事実収集は Probes に委譲、判定は上の純粋関数。 */
export async function runAll(probes: DoctorProbes): Promise<DoctorReport> {
  const { haloDir, cwd, fs, command } = probes;

  const triggers = await listTriggers(probes.triggerCtx);
  const c1 = checkTriggerLiveness(triggers, resolveBinPath(cwd));

  const missing: string[] = [];
  for (const port of PORT_DIRS) {
    if (!(await fs.isDirectory(join(haloDir, 'ports', port)))) missing.push(`ports/${port}`);
  }
  if (!(await fs.isDirectory(join(haloDir, 'profiles')))) missing.push('profiles');
  if (!(await fs.isDirectory(join(haloDir, 'logs')))) missing.push('logs');
  const harnessPresent = await fs.exists(join(cwd, '.harness.yml'));
  if (!harnessPresent) missing.push('.harness.yml');
  const c2 = checkSkeleton(missing);

  let harnessValid = false;
  let harnessReason: string | undefined;
  if (harnessPresent) {
    try {
      const body = await fs.readFile(join(cwd, '.harness.yml'));
      harnessValid = /kinds\s*:/.test(body);
      if (!harnessValid) harnessReason = 'kinds: セクションがありません';
    } catch (err) {
      harnessReason = (err as Error).message;
    }
  }
  const c3 = checkHarnessValid(harnessPresent, harnessValid, harnessReason);

  const c4 = checkGh(await command.exists('gh'), await command.ghAuth());
  const c5 = checkClaude(await command.exists('claude'), await command.claudeResponds());
  const c6 = checkGit(await command.exists('git'), await command.gitStatus());

  const stopPresent = await fs.exists(join(haloDir, 'STOP'));
  const c7 = checkLockStop(await probes.orphanLock(), stopPresent);
  const c8 = checkPlacement(await probes.onExt4());
  const c9 = checkDisk(await probes.diskOk());

  return aggregate([c1, c2, c3, c4, c5, c6, c7, c8, c9]);
}
