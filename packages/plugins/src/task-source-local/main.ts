// task-source-local(旧 run.sh の TS 移植, ADR-0018): ローカル md ファイルキューをタスク源にする
// アダプタ(gh 未導入環境用)。task-source-github と同じ契約(op=next/complete/fail/release)。
//   キュー : $HALO_TASKS_DIR/queue/*.md   (先頭の "# " 行を title、全文を body に)
//   claim  : op=next で queue → doing/ へ atomic rename(占有, ADR-0025)。以後の next は
//            doing/ にあるタスクを二度と返さない。
//   完了   : doing → done/ へ移動(完了記録は done/<id>.result に PR URL)
//   失敗   : doing に留め置き(release されるまで claim 済みのまま)、通算失敗数が閾値に
//            達したら doing → needs-human/ へ移動(エスカレーション)。
//   release: doing → queue/ へ戻し、claim を解除する(失敗記録はしない、ADR-0025)。
//   stale 回収: op=next の実行毎に doing/ を走査し、mtime が HALO_CLAIM_STALE_SEC 秒
//            (既定 3600) を超えたエントリを queue/ へ戻してから通常の queue 先頭選択に入る
//            (claim したまま launch が異常終了した「幽霊 claim」の回収、ADR-0025 Decision #4)。
// task_id はファイル名(拡張子除く)。同一タスクは complete まで doing に残り、
// コアのリトライ再注入(D2 §2.4)が同じ task_id で効く。
import {
  readdirSync,
  readFileSync,
  renameSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { readStdinJson, writeStdoutJson, diag, str } from '../lib/io.js';

const tasksDir = process.env['HALO_TASKS_DIR'] ?? join(process.cwd(), '.halo', 'tasks');
const failThreshold = Number(process.env['HALO_FAIL_THRESHOLD'] ?? '3');
const claimStaleSec = Number(process.env['HALO_CLAIM_STALE_SEC'] ?? '3600');
const queueDir = join(tasksDir, 'queue');
const doingDir = join(tasksDir, 'doing');
const doneDir = join(tasksDir, 'done');
const needsHumanDir = join(tasksDir, 'needs-human');
// 通算リトライ回数の置き場 (N4)。コアの retry_count は runLoop 内の in-memory 値なので、
// trigger が run を都度起動する運用では毎回 0 起点になり閾値に到達しない。
const retryDir = join(tasksDir, 'retry');
mkdirSync(queueDir, { recursive: true });
mkdirSync(doingDir, { recursive: true });
mkdirSync(doneDir, { recursive: true });
mkdirSync(needsHumanDir, { recursive: true });

/**
 * mtime を現在時刻に更新する。claim (queue→doing) の直前、まだ queue/ にある間に呼ぶ
 * ことで、stale 判定の基準時刻を「最後に書かれた時刻」ではなく「claim された時刻」に
 * する。これをしないと、queue に長時間置かれていた(mtime が古い)タスクを claim した
 * 直後に、それ自体が stale 判定されて即座に回収対象になってしまう。
 *
 * 必ず rename の**前**に呼ぶこと。rename 自体は mtime を更新しないので、
 * 「rename してから touch する」順だと、doing/ に現れてから touch が効くまでの間、
 * claim 直後のファイルが古い mtime のまま doing/ に見える窓ができる。この窓を他
 * プロセスの recoverStaleClaims が stale と誤認して queue/ へ奪い返すと、さらに別の
 * プロセスがそれを再 claim して同じ task_id が二重に払い出される(レビューで実測)。
 */
function touch(path: string): void {
  const now = new Date();
  utimesSync(path, now, now);
}

/** 現在時刻からの経過秒が閾値を超えているか。ファイルが既に無ければ false(他プロセス処理済み)。 */
function isStale(path: string): boolean {
  try {
    return (Date.now() - statSync(path).mtimeMs) / 1000 > claimStaleSec;
  } catch {
    return false;
  }
}

/**
 * stale な doing/ エントリを queue/ へ回収する(ADR-0025 Decision #4)。claim したまま
 * launch が死んだタスクの回収責務は task-source にある。op=next の都度呼び、通常の
 * queue 先頭選択より前に走らせることで、回収されたタスクもその場で再取得の対象になる。
 *
 * 不変条件: この関数がやるのは doing→queue の「戻す」だけであり、queue→doing の claim
 * は必ず op=next 本体の rename(下の case 'next')を経由する。ここでは claim を新たに
 * 作らない。
 *
 * 複数プロセスが同時にこの関数を呼ぶ(=同時に op=next する)と、同じ stale ファイルを
 * 複数プロセスが同時に「戻そう」とする。rename は最初の 1 件しか成功しないので、
 * 2 件目以降は ENOENT になる — これは他プロセスが同じ回収(または並行する
 * complete/release)を先に済ませたことを意味する無害なレースなので、握り潰して次の
 * ファイルへ進む(未捕捉のままだと exit 1 でクラッシュする)。
 */
function recoverStaleClaims(): void {
  for (const file of readdirSync(doingDir)) {
    if (!file.endsWith('.md')) continue;
    const path = join(doingDir, file);
    if (!isStale(path)) continue;
    // TOCTOU: rename 直前に stale 判定を再確認して競合窓を縮める。この間に他プロセスが
    // 再 claim していれば touch() で mtime が更新済みのはずなので、ここで stale で
    // なくなっていれば奪い返さず素通りする。
    if (!isStale(path)) continue;
    try {
      renameSync(path, join(queueDir, file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // 他プロセスが先に処理済み(レース、上記コメント参照)。無視して次へ。
    }
  }
}

function die(msg: string, code = 2): never {
  diag(`task-source-local: ${msg}`);
  process.exit(code);
}

// bash `date -u +%FT%TZ` と一致させるため秒精度に揃える
function timestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// bash 移植元(grep -m1 '^# ' → 空なら id フォールバック)とのパリティ:
// 「内容のある最初の '# ' 行」ではなく「'# ' で始まる最初の行」を採用してから空判定する。
function extractTitle(body: string, fallback: string): string {
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith('# ')) {
      const title = line.slice(2);
      return title === '' ? fallback : title;
    }
  }
  return fallback;
}

/** task_id をファイル名として使う前の最低限の検証 (パス区切り等の混入を拒否)。 */
function safeTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId) || taskId.startsWith('.')) {
    die(`unsafe task_id: '${taskId}'`);
  }
  return taskId;
}

function retryCountPath(taskId: string): string {
  return join(retryDir, `${safeTaskId(taskId)}.count`);
}

/** 通算リトライ回数を読む。欠損・破損は 0 (安全側: エスカレーションが遅れるだけ)。 */
function readRetryCount(taskId: string): number {
  const path = retryCountPath(taskId);
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, 'utf8').trim();
  return /^[0-9]+$/.test(raw) ? Number(raw) : 0;
}

function writeRetryCount(taskId: string, count: number): void {
  mkdirSync(retryDir, { recursive: true });
  writeFileSync(retryCountPath(taskId), `${count}\n`);
}

function clearRetryCount(taskId: string): void {
  rmSync(retryCountPath(taskId), { force: true });
}

const input = await readStdinJson().catch(() => undefined);
const op = str(input, 'op');

switch (op) {
  case 'next': {
    recoverStaleClaims();
    // 複数プロセスが同時に op=next すると、同じ queue 先頭ファイルの claim (rename) を
    // 取り合うことがある。負けた側は ENOENT を握り潰し、次の候補で readdir をやり直す
    // (queue のファイル名は ASCII 前提。bash sort とのパリティは ASCII 範囲で保証)。
    for (;;) {
      const file = readdirSync(queueDir)
        .filter((f) => f.endsWith('.md'))
        .sort()[0];
      if (file === undefined) {
        writeStdoutJson({ task_id: null });
        process.exit(0);
      }
      const id = basename(file, '.md');
      // claim: 同一ファイルシステム内の atomic rename で占有する(ADR-0025)。以後の next
      // は doing/ にあるこのファイルを二度と返さない。
      const queuePath = join(queueDir, file);
      const claimedPath = join(doingDir, file);
      // touch は必ず rename の**前**、まだ queue/ にある間に行う。rename は mtime を
      // 更新しないので、rename→touch の順だと「doing/ に現れてから touch が効くまで」の
      // 間、claim 直後のファイルが古い mtime のまま doing/ に見えてしまう。この窓で他
      // プロセスの recoverStaleClaims が stale と誤認して queue/ へ奪い返し、さらに
      // 別プロセスがそれを再 claim すると同じ task_id が二重に払い出される
      // (レビューで実測: 8 プロセス同時実行で発生)。touch を rename 前に済ませておけば、
      // ファイルは doing/ に「最初から」新しい mtime で現れるので、この窓が生じない。
      try {
        touch(queuePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // 他プロセスが先に claim
        throw err;
      }
      try {
        renameSync(queuePath, claimedPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // 他プロセスが先に claim
        throw err;
      }
      const body = readFileSync(claimedPath, 'utf8');
      const title = extractTitle(body, id);
      writeStdoutJson({ task_id: id, title, body, kind: 'code' });
      break;
    }
    break;
  }
  case 'complete': {
    const taskId = str(input, 'task_id');
    const prUrl = str(input, 'pr_url') ?? '';
    if (taskId === undefined) die('complete requires task_id');
    const src = join(doingDir, `${taskId}.md`);
    if (!existsSync(src)) die(`unknown task: ${taskId}`);
    renameSync(src, join(doneDir, `${taskId}.md`));
    writeFileSync(
      join(doneDir, `${taskId}.result`),
      `completed_at=${timestamp()}\npr_url=${prUrl}\n`,
    );
    // 完了したタスクの計数は残さない。残すと同名 task_id を再投入したときに
    // 前回の回数を引き継いでしまう。
    clearRetryCount(taskId);
    break;
  }
  case 'fail': {
    const taskId = str(input, 'task_id');
    const reason = str(input, 'reason') ?? '';
    const rcRaw =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>)['retry_count']
        : undefined;
    const rc = typeof rcRaw === 'number' ? rcRaw : 0;
    if (taskId === undefined) die('fail requires task_id');
    // 通算回数はファイルに持つ (N4)。コアの retry_count はプロセス内の値なので、
    // run を都度起動する trigger 運用では毎回 0 起点になり閾値に到達しない。
    const attempts = Math.max(readRetryCount(taskId) + 1, rc);
    writeRetryCount(taskId, attempts);
    appendFileSync(join(tasksDir, 'failures.log'), `${timestamp()} fail #${attempts}: ${reason}\n`);
    // ADR-0025: fail は記録のみ。閾値未達なら claim (doing/) はそのまま保持し、解除は
    // 別 op である release に委ねる。閾値到達時のみ従来通り needs-human へ隔離する。
    if (attempts >= failThreshold) {
      const src = join(doingDir, `${taskId}.md`);
      if (existsSync(src)) renameSync(src, join(needsHumanDir, `${taskId}.md`));
      clearRetryCount(taskId);
    }
    break;
  }
  case 'release': {
    // ADR-0025: claim (doing/) を解除して queue/ へ戻す。失敗記録はしない — それは
    // op=fail の責務であり、release は「今回は成果に至らなかったが、まだ隔離段階では
    // ない」ことをタスクの所在で表すだけ。
    const taskId = str(input, 'task_id');
    if (taskId === undefined) die('release requires task_id');
    const src = join(doingDir, `${taskId}.md`);
    if (!existsSync(src)) die(`unknown (unclaimed) task: ${taskId}`);
    renameSync(src, join(queueDir, `${taskId}.md`));
    break;
  }
  default:
    die(`unknown op: '${op ?? ''}'`);
}
process.exit(0);
