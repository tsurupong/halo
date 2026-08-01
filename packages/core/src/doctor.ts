// doctor の環境自己診断 (D3 §4)。判定は各検査を純粋関数化し、環境事実 (バイナリ存在・
// 認証・パス整合) は Probes シームから注入してテスト可能にする。CLI は集計結果を
// 終了コードへ写像するだけ (D3 §5.2: FAIL あり=1 / WARN のみ=0)。
//
// 検査は常時実行の c1-c9 / c12 / c13 / c16 (失敗学習ペア, ADR-0027) に加え、probe を
// 注入した場合のみ走る c10 (必須コマンド, D10 §4) / c11 (スケジューラバックエンド,
// D10 §3.2) / c14 (watchdog heartbeat, ADR-0023) / c15 (幽霊 claim, ADR-0025) がある。
// 既定の CLI 配線 (deps.ts) は c10/c11/c14 を注入し c15 は未配線のため、実運用では
// 15 検査になる。
import type { CliFs } from './fs.js';
import { PORT_DIRS } from './scaffold.js';
import { resolveBinPath, listTriggers, type TriggerContext } from './triggers.js';
import {
  checkExecutorSettingsDrift,
  executorSettingsPath,
  type ExecutorSettingsDrift,
} from './executor-settings.js';
import { parseHarnessYaml } from './harness.js';
import { validateHarnessYml, ConfigError } from './config.js';

export type CheckStatus = 'OK' | 'WARN' | 'FAIL';

/** スケジューラバックエンドの検出結果 (D10 §3.2/§4)。 */
export type SchedulerBackend = 'schtasks' | 'systemd' | 'cron' | 'launchd' | 'none';

/** c10 で存在を要求するコマンド (D10 §4)。 */
export const REQUIRED_COMMANDS = ['node', 'git', 'claude'] as const;

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
  /** コマンドが PATH に存在するか (c10)。未注入なら c10 は実行しない (後方互換)。 */
  commandExists?(name: string): Promise<boolean>;
  /** スケジューラバックエンドの検出 (c11)。未注入なら c11 は実行しない (後方互換)。 */
  schedulerBackend?(): Promise<SchedulerBackend>;
  /** WSL 上か。未注入なら c8 (ext4 配置) は従来どおり無条件実行 (後方互換)。 */
  isWsl?(): Promise<boolean>;
  /** 現在時刻 (ms)。未注入なら c14 (watchdog heartbeat) は実行しない (後方互換)。 */
  now?(): number;
  /** heartbeat 不在時に想定する登録間隔 (分)。手書き cron 登録への配慮 (D9 §2.6 既定)。 */
  watchdogDefaultEveryMinutes?: number;
  /**
   * claim 中 (task-source-local の doing/、task-source-github の in-progress) タスクの
   * 列挙 (c15, ADR-0025)。未注入なら c15 は実行しない (後方互換)。task-source の種類を
   * doctor 自身は知らないので、実体の収集は CLI 配線側 (deps.ts) が担う。
   */
  ghostClaims?(): Promise<GhostClaimEntry[]>;
  /** c15 の stale 判定しきい値 (秒)。未指定は 3600 (1 時間)。 */
  ghostClaimStaleSec?: number;
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

export function checkPlacement(onExt4: boolean, isWsl = true, detectedPath?: string): CheckResult {
  // ext4 配置は WSL 固有の制約。WSL 以外ではスキップ扱い (fail にしない, D10 §4)。
  if (!isWsl)
    return { id: 8, title: '配置制約 (WSL2)', status: 'OK', detail: 'WSL 以外のためスキップ' };
  if (onExt4) return { id: 8, title: '配置制約 (WSL2)', status: 'OK', detail: 'ext4 側に配置' };
  const where = detectedPath ?? '/mnt/<drive>';
  return {
    id: 8,
    title: '配置制約 (WSL2)',
    status: 'WARN',
    detail: `${where} は drvfs (/mnt/<drive>) 配下の可能性 — ext4 側 (~) への配置を推奨`,
  };
}

export function checkDisk(diskOk: boolean): CheckResult {
  if (diskOk) return { id: 9, title: 'ディスク残量', status: 'OK', detail: 'worktree 展開に十分' };
  return { id: 9, title: 'ディスク残量', status: 'WARN', detail: '空き容量が少ない可能性' };
}

export function checkRequiredCommands(missing: string[]): CheckResult {
  if (missing.length === 0)
    return {
      id: 10,
      title: '必須コマンド',
      status: 'OK',
      detail: `${REQUIRED_COMMANDS.join(' / ')} すべて存在`,
    };
  return {
    id: 10,
    title: '必須コマンド',
    status: 'FAIL',
    detail: `欠損: ${missing.join(', ')} — 例: \`pacman -S nodejs git\` / \`brew install node git\``,
  };
}

/** 旧 `.sh` ランチャー構成の残存検出 (entry契約化 Task 6 Step D)。 */
/** `.halo/ports/<port>.d/<name>/` 配下で有効化中と見なせるディレクトリ1件分の事実。 */
export interface EnabledPluginEntry {
  port: string;
  name: string;
  /** そのプラグインディレクトリ直下のファイル/ディレクトリ名一覧。 */
  entries: string[];
}

/**
 * 有効化中プラグインの一覧を走査する (c12 の旧ランチャー検査 / c16 の失敗フィードバック
 * ペア検査が共有する)。個別プラグインの `readdir`/`isDirectory` 失敗は「未有効化」として
 * 無視し、走査自体は継続する。
 */
export async function listEnabledPlugins(
  haloDir: string,
  fs: CliFs,
): Promise<EnabledPluginEntry[]> {
  const result: EnabledPluginEntry[] = [];
  for (const port of PORT_DIRS) {
    const portDir = join(haloDir, 'ports', port);
    let names: string[];
    try {
      names = await fs.readdir(portDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const pluginDir = join(portDir, name);
      if (!(await fs.isDirectory(pluginDir))) continue;
      let entries: string[];
      try {
        entries = await fs.readdir(pluginDir);
      } catch {
        continue;
      }
      result.push({ port, name, entries });
    }
  }
  return result;
}

export function checkLegacyLauncherConfig(offenders: string[]): CheckResult {
  if (offenders.length === 0)
    return { id: 12, title: '旧ランチャー設定', status: 'OK', detail: '.sh 参照なし' };
  return {
    id: 12,
    title: '旧ランチャー設定',
    status: 'WARN',
    detail: `旧形式の .sh ランチャー設定が残存: ${offenders.join(', ')} — 'halo enable <name>' で再生成してください`,
  };
}

/** c13 に渡す事実: 注入 settings が存在するか、存在するなら権威リストとの差分。 */
export type ExecutorSettingsState =
  { present: false } | { present: true; drift: ExecutorSettingsDrift };

/**
 * c13: 注入 deny settings のドリフト検査 (ADR-0019 §Risks の緩和策)。層1(deny) と
 * 層2(gate) は同じ権威リストから生成されるが、実際に書かれたファイルが古い版のまま
 * 残っていると事前強制だけが静かに縮退する — それを検知できるのはここだけ。
 * 未生成 (初回 run 前) は WARN、内容の欠落・破損は FAIL。
 */
export function checkExecutorSettings(state: ExecutorSettingsState): CheckResult {
  const id = 13;
  const title = '注入 deny 設定';
  if (!state.present) {
    return {
      id,
      title,
      status: 'WARN',
      detail: '未生成 — `halo run` の起動時に生成されます (ADR-0019 層1)',
    };
  }
  if (state.drift.status === 'unreadable') {
    return {
      id,
      title,
      status: 'FAIL',
      detail: `解析不能 (${state.drift.reason}) — 次回 run で再生成されますが、事前強制が効いていません`,
    };
  }
  if (state.drift.status === 'drift') {
    const missing = [
      ...state.drift.missingDeny,
      ...state.drift.missingSandboxDenyRead.map((p) => `sandbox.denyRead:${p}`),
    ];
    return {
      id,
      title,
      status: 'FAIL',
      detail: `D4 §2.2 の deny が欠落 (${missing.length} 件): ${missing.join(', ')}`,
    };
  }
  return { id, title, status: 'OK', detail: 'D4 §2.2 の deny 標準集合を充足' };
}

/** c14 に渡す事実: heartbeat が読めたか、読めたなら経過秒と登録間隔 (ADR-0023, D9 §2.7)。 */
export type WatchdogHeartbeatState =
  { present: false } | { present: true; ageSec: number; intervalSec: number };

/**
 * c14: watchdog heartbeat の鮮度検査 (ADR-0023, D9 §2.7)。監督は正常時 `watchdog.jsonl`
 * に何も書かないので、「一度も登録されていない」と「登録済みで異常なし」を区別できる
 * 唯一の材料がこの heartbeat になる。
 *
 * 必ず WARN 止まりにする: WSL2 VM のサスペンドでも同じ症状 (古い ts) が出るので、
 * FAIL にすると無害な原因で run 全体が止まる (D7 §5.2)。
 */
export function checkWatchdogHeartbeat(state: WatchdogHeartbeatState): CheckResult {
  const id = 14;
  const title = 'watchdog heartbeat';
  if (!state.present) {
    return {
      id,
      title,
      status: 'WARN',
      detail:
        '未検出 — ハング検知が一度も動いていません。`halo watchdog install --action report` で登録してください',
    };
  }
  // 2 倍を許容幅にするのは、1 周期ぶんの取りこぼしを異常と呼ばないため。
  if (state.ageSec > state.intervalSec * 2) {
    return {
      id,
      title,
      status: 'WARN',
      detail: `最終実行が ${Math.round(state.ageSec)}s 前 (登録間隔 ${state.intervalSec}s の 2 倍超) — スケジュールが発火していない可能性`,
    };
  }
  return { id, title, status: 'OK', detail: `${Math.round(state.ageSec)}s 前に実行` };
}

/** c15 に渡す一件: claim 中 (doing/ 残留 or in-progress ラベル) のタスクと claim 経過秒。 */
export interface GhostClaimEntry {
  taskId: string;
  ageSec: number;
}

/**
 * c15: 幽霊 claim (doing/ 残留) の検査 (ADR-0025 Decision #4 / Risks)。claim したまま
 * launch が異常終了したタスクの回収そのものは task-source 実装の責務 (ADR-0025) なので、
 * ここでは検知して WARN するだけで、queue/ へは戻さない。
 *
 * 必ず WARN 止まりにする: 幽霊 claim はスループットを落とすだけで状態を破壊しないので、
 * doctor 全体を FAIL で止めるほどの重大度ではない (checkWatchdogHeartbeat と同じ判断)。
 */
export function checkGhostClaims(entries: GhostClaimEntry[], staleAfterSec = 3600): CheckResult {
  const id = 15;
  const title = '幽霊 claim (doing/ 残留)';
  const stale = entries.filter((e) => e.ageSec > staleAfterSec);
  if (stale.length === 0) {
    return {
      id,
      title,
      status: 'OK',
      detail:
        entries.length === 0
          ? 'claim 中のタスクなし'
          : `${entries.length} 件 claim 中 (すべて ${staleAfterSec}s 以内)`,
    };
  }
  return {
    id,
    title,
    status: 'WARN',
    detail: `${stale.length} 件が stale (${staleAfterSec}s 超) — ${stale.map((e) => e.taskId).join(', ')} の回収を確認してください`,
  };
}

/** c16 に渡す事実: on-fail-record / context-recent-failures それぞれの有効化有無。 */
export interface FailureFeedbackState {
  record: boolean;
  context: boolean;
}

/**
 * c16: 失敗フィードバック経路の対称性検査 (ADR-0027)。core の失敗理由再注入
 * (`lastFailure`, loop.ts, D2 §2.4) はプロセス内 in-memory のため、trigger が run を
 * 都度起動する実運用ではプロセスを跨げない。on-fail-record が書く
 * `.halo/failure-catalog.jsonl` を context-recent-failures が読むのが唯一のプロセス跨ぎ
 * 経路であり、record のみ有効で context が無効だと記録だけして再注入されず、同一失敗を
 * 反復する (2026-08-01 実 GitHub E2E で実証)。
 *
 * WARN 止まり: 恒久的に context-recent-failures を使わない構成もあり得るため FAIL にはしない
 * (c14/c15 と同じ基準)。
 */
export function checkFailureFeedbackPair(state: FailureFeedbackState): CheckResult {
  const id = 16;
  const title = '失敗フィードバックの対称性';
  if (state.record && !state.context) {
    return {
      id,
      title,
      status: 'WARN',
      detail:
        'on-fail-record は有効ですが context-recent-failures が無効です — ' +
        '記録した失敗理由がプロセス跨ぎで再注入されません。' +
        "'halo enable context-recent-failures' で有効化してください",
    };
  }
  return { id, title, status: 'OK', detail: '記録/再注入のペアに矛盾なし' };
}

export function checkSchedulerBackend(backend: SchedulerBackend): CheckResult {
  if (backend === 'none')
    return {
      id: 11,
      title: 'スケジューラバックエンド',
      status: 'FAIL',
      detail:
        '検出なし (schtasks / systemd / cron / launchd) — 環境変数 HALO_SCHEDULER=cron などで明示固定できます',
    };
  return {
    id: 11,
    title: 'スケジューラバックエンド',
    status: 'OK',
    detail: `${backend} を使用`,
  };
}

/** 集計 → 終了コード写像 (D3 §5.2)。 */
export function aggregate(checks: CheckResult[]): DoctorReport {
  const ok = checks.filter((c) => c.status === 'OK').length;
  const warn = checks.filter((c) => c.status === 'WARN').length;
  const fail = checks.filter((c) => c.status === 'FAIL').length;
  return { checks, ok, warn, fail, exitCode: fail > 0 ? 1 : 0 };
}

/** c13 の事実収集: 注入 settings を読んで権威リストと突き合わせる (I/O のみ)。 */
async function readExecutorSettingsState(
  haloDir: string,
  fs: CliFs,
): Promise<ExecutorSettingsState> {
  const path = executorSettingsPath(haloDir);
  if (!(await fs.exists(path))) return { present: false };
  try {
    return { present: true, drift: checkExecutorSettingsDrift(await fs.readFile(path)) };
  } catch (err) {
    return { present: true, drift: { status: 'unreadable', reason: (err as Error).message } };
  }
}

/**
 * c14 の事実収集 (I/O のみ)。heartbeat の `ts` から経過秒を、`watchdog-schedule.json`
 * (install が書く) から登録間隔を得る。marker が無くても heartbeat があれば既定間隔で
 * 評価する — 手で cron を書いた環境を「未登録」と決めつけないため。
 */
async function readWatchdogHeartbeatState(
  haloDir: string,
  fs: CliFs,
  now: number,
  defaultEveryMinutes: number,
): Promise<WatchdogHeartbeatState> {
  let ts: number;
  try {
    const raw = JSON.parse(await fs.readFile(join(haloDir, 'logs', 'watchdog-last.json'))) as {
      ts?: unknown;
    };
    if (typeof raw.ts !== 'string') return { present: false };
    ts = Date.parse(raw.ts);
    if (Number.isNaN(ts)) return { present: false };
  } catch {
    return { present: false };
  }
  let everyMinutes = defaultEveryMinutes;
  try {
    const sched = JSON.parse(
      await fs.readFile(join(haloDir, 'logs', 'watchdog-schedule.json')),
    ) as {
      every_minutes?: unknown;
    };
    if (typeof sched.every_minutes === 'number' && sched.every_minutes > 0) {
      everyMinutes = sched.every_minutes;
    }
  } catch {
    // marker 不在は既定間隔で評価する (上のコメント参照)。
  }
  return { present: true, ageSec: Math.max(0, (now - ts) / 1000), intervalSec: everyMinutes * 60 };
}

function join(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/$/, '') : p.replace(/^\/|\/$/g, '')))
    .join('/');
}

/** §4 の全検査を実行して集計する。事実収集は Probes に委譲、判定は上の純粋関数。 */
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

  // M4: 正規表現の粗い kinds: 検査を捨て、契約検証(parseHarnessYaml + validateHarnessYml)
  // で YAML の妥当性を判定し、続けて kinds[].runtimes の各名称が runtime.d/ に実在するかを
  // 照合する。loadHarnessYml は throw 型で runAll の集計方針(全検査を実行してから集める)
  // に合わないため使わない。
  let harnessValid = false;
  let harnessReason: string | undefined;
  if (harnessPresent) {
    try {
      const body = await fs.readFile(join(cwd, '.harness.yml'));
      const parsed = parseHarnessYaml(body);
      const harness = validateHarnessYml(parsed);
      const missingRuntimes: string[] = [];
      for (const kind of Object.values(harness.kinds)) {
        for (const runtime of kind.runtimes) {
          if (!(await fs.isDirectory(join(haloDir, 'ports', 'runtime.d', runtime)))) {
            missingRuntimes.push(runtime);
          }
        }
      }
      if (missingRuntimes.length > 0) {
        harnessReason = `未実在の runtime: ${[...new Set(missingRuntimes)].join(', ')}`;
      } else {
        harnessValid = true;
      }
    } catch (err) {
      harnessReason = err instanceof ConfigError ? err.message : (err as Error).message;
    }
  }
  const c3 = checkHarnessValid(harnessPresent, harnessValid, harnessReason);

  const c4 = checkGh(await command.exists('gh'), await command.ghAuth());
  const c5 = checkClaude(await command.exists('claude'), await command.claudeResponds());
  const c6 = checkGit(await command.exists('git'), await command.gitStatus());

  const stopPresent = await fs.exists(join(haloDir, 'STOP'));
  const c7 = checkLockStop(await probes.orphanLock(), stopPresent);
  // isWsl 未注入時は従来どおり無条件で ext4 検査 (後方互換, D10 §4)。
  const c8 = checkPlacement(await probes.onExt4(), probes.isWsl ? await probes.isWsl() : true, cwd);
  const c9 = checkDisk(await probes.diskOk());

  const enabledPlugins = await listEnabledPlugins(haloDir, fs);

  const legacyOffenders: string[] = [];
  for (const { port, name, entries } of enabledPlugins) {
    if (entries.some((e) => e.endsWith('.sh'))) {
      legacyOffenders.push(`${port}/${name} (.sh ファイル残存)`);
      continue;
    }
    if (!entries.includes('plugin.json')) continue;
    try {
      const content = await fs.readFile(join(haloDir, 'ports', port, name, 'plugin.json'));
      if (content.includes('.sh')) {
        legacyOffenders.push(`${port}/${name} (plugin.json が .sh を参照)`);
      }
    } catch {
      // plugin.json 読み取り失敗はここでは無視 (他検査の管轄外)。
    }
  }
  const c12 = checkLegacyLauncherConfig(legacyOffenders);
  const c13 = checkExecutorSettings(await readExecutorSettingsState(haloDir, fs));

  const hasEnabledPlugin = (port: string, name: string): boolean =>
    enabledPlugins.some(
      (p) => p.port === port && p.name === name && p.entries.includes('plugin.json'),
    );
  const c16 = checkFailureFeedbackPair({
    record: hasEnabledPlugin('on-fail.d', 'on-fail-record'),
    context: hasEnabledPlugin('context.d', 'context-recent-failures'),
  });

  const checks = [c1, c2, c3, c4, c5, c6, c7, c8, c9, c12, c13, c16];

  if (probes.commandExists) {
    const absent: string[] = [];
    for (const name of REQUIRED_COMMANDS) {
      if (!(await probes.commandExists(name))) absent.push(name);
    }
    checks.push(checkRequiredCommands(absent));
  }
  if (probes.schedulerBackend) {
    checks.push(checkSchedulerBackend(await probes.schedulerBackend()));
  }
  if (probes.now) {
    checks.push(
      checkWatchdogHeartbeat(
        await readWatchdogHeartbeatState(
          haloDir,
          fs,
          probes.now(),
          probes.watchdogDefaultEveryMinutes ?? 5,
        ),
      ),
    );
  }
  if (probes.ghostClaims) {
    checks.push(checkGhostClaims(await probes.ghostClaims(), probes.ghostClaimStaleSec));
  }

  return aggregate(checks);
}
