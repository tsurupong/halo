# sh ランチャー全廃(entry 実行契約)実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** リポジトリ内の .sh を完全ゼロにし、plugin.json を `exec`(実行ファイル)から `entry`/`aux`(JSモジュール)契約へ破壊的移行して core が `process.execPath` で直接 spawn する(v0.3.0)。

**Architecture:** spec は `product/docs/superpowers/specs/2026-07-16-remove-sh-launchers-design.md`。契約型(contracts)→ core(discovery/run-wiring)→ plugins(registry/実装)→ cli(enable)→ 周辺(.sh の Node 化)→ docs の順に、各段でテスト green を保って進める。stdio 契約・timeout・watchdog・contract fixtures は不変。

**Tech Stack:** TypeScript / Node >= 22 / pnpm 10.14.0 / Vitest。作業ディレクトリは常に `/mnt/d/workspace/project/halo/product`。

## Global Constraints

- ブランチ: `design/remove-sh-launchers`(継続使用)。push・npm publish はユーザー承認必須。
- テストコマンド: `pnpm test`(vitest run)、型: `pnpm build`(tsc -b)、lint: `pnpm lint`。
- 破壊的変更: 旧 `exec` フィールドは fail-fast(黙認しない)。後方互換コードを書かない。
- NTFS 注意: 新規ファイルに exec-bit は不要になる設計だが、既存 .sh の削除は `git rm` で行う。
- CLAUDE.md / PROMPT.md / .harness.yml / 既存テストの仕様変更を伴わない書き換え禁止(ADR-0004)。本計画でのテスト変更は契約変更に伴う正当な更新。
- 各タスク完了時にコミット(日本語本文、type は英語)。

---

### Task 1: contracts — PluginManifest を entry/aux 契約へ

**Files:**
- Modify: `packages/contracts/src/manifest.ts:48-49`(`exec` を置換)
- Test: `packages/contracts/src/index.test.ts`(既存 manifest テストの追随)
- 再生成: `packages/contracts` の JSON Schema(`pnpm --filter @tsurupong/halo-contracts build` 内の gen-schema)

**Interfaces:**
- Produces: `PluginManifest.entry: string`(必須、plugin.json からの相対 or 絶対パスの JS モジュール)、`PluginManifest.aux?: Record<string, string>`(補助エントリ名 → JS パス)。`exec` フィールドは型から削除。

- [ ] **Step 1: manifest.ts の型を変更**

```ts
  /** Relative (or absolute) path to the plugin's main JS entry module.
   *  Spawned as `process.execPath <entry>` by the core (ADR-0018). */
  entry: string;
```

を `exec: string;` の位置に置き、optional 群に追加:

```ts
  /** Auxiliary JS entries (e.g. trigger install/uninstall, runtime check/test),
   *  keyed by role name. Not spawned by the core loop. */
  aux?: Record<string, string>;
```

- [ ] **Step 2: schema 再生成とテスト追随** — `pnpm --filter @tsurupong/halo-contracts test` を実行し、`exec` 参照のテストを `entry`/`aux` へ書き換え、PASS を確認。
- [ ] **Step 3: Commit** — `git commit -m "feat(contracts)!: replace exec with entry/aux in PluginManifest (ADR-0018)"`

---

### Task 2: core discovery — entry 検証・sh フォールバック削除

**Files:**
- Modify: `packages/core/src/discovery.ts`(validatePluginManifest 142-198、DiscoveredPlugin 56-78、discoverPort 271-315、isShellShebang/resolveExecArgv 317-343 削除)
- Test: `packages/core/src/discovery.test.ts`

**Interfaces:**
- Consumes: Task 1 の `PluginManifest.entry` / `aux`
- Produces: `DiscoveredPlugin.entryPath: string`(絶対パス。`execPath`/`execArgv` は削除)

- [ ] **Step 1: 失敗するテストを書く** — discovery.test.ts に追加:

```ts
it('resolves entry to an absolute entryPath', async () => {
  const fs = fakeFs({
    'ports/gate.d/g1/plugin.json': JSON.stringify({
      name: '@x/g1', version: '1.0.0', port: 'gate', entry: './dist/main.js',
    }),
  });
  const d = await discoverPort({ haloRoot: '/repo/.halo', port: 'gate', fs });
  expect(d.plugins[0]?.entryPath).toBe('/repo/.halo/ports/gate.d/g1/dist/main.js');
});

it('rejects legacy exec field with a migration message', async () => {
  const fs = fakeFs({
    'ports/gate.d/g1/plugin.json': JSON.stringify({
      name: '@x/g1', version: '1.0.0', port: 'gate', exec: './run.sh',
    }),
  });
  const d = await discoverPort({ haloRoot: '/repo/.halo', port: 'gate', fs });
  expect(d.plugins).toHaveLength(0);
  expect(d.issues[0]?.message).toMatch(/exec.*v0\.3\.0.*entry/);
});
```

(`fakeFs` は同ファイル既存のヘルパに合わせる)

- [ ] **Step 2: テストが FAIL することを確認** — `pnpm --filter @tsurupong/halo-core test -- discovery`
- [ ] **Step 3: 実装**
  - `validatePluginManifest`: `const exec = requireString(obj, 'exec');` を削除し、

    ```ts
    if ('exec' in obj) {
      throw new DiscoveryError(
        "plugin.json: 'exec' was removed in v0.3.0 — declare a JS module via 'entry' (see ADR-0018)",
      );
    }
    const entry = requireString(obj, 'entry');
    ```

    `aux` は `env` と同様の「string 値のみの object」検証を追加。known セットを `['name','version','port','entry','aux','order','minAutonomy','timeoutSec','env']` に更新。
  - `DiscoveredPlugin`: `execPath`/`execArgv` を `entryPath: string` に置換。
  - `discoverPort`: `const entryPath = isAbsolute(manifest.entry) ? manifest.entry : join(dir, manifest.entry);`(`node:path` の `isAbsolute` を import)。`requireExec` オプションは `requireEntry` に改名し、存在チェック対象を entryPath に。`resolveExecArgv` 呼び出しを削除。
  - `isShellShebang` / `resolveExecArgv` を削除。`DiscoveryFs.isExecutable` も参照が無くなるため削除(createNodeDiscoveryFs の実装ごと)。
- [ ] **Step 4: core 全テスト実行** — `pnpm --filter @tsurupong/halo-core test`。discovery 以外で `execPath`/`execArgv`/`exec:` を使う既存テストは entry 契約へ書き換え(モック plugin.json の `exec: './x.sh'` → `entry: './x.mjs'` 等。実ファイルモックは Task 8 で置換するため、ここでは fake-fs ベースのテストのみ)。PASS を確認。
- [ ] **Step 5: Commit** — `git commit -m "feat(core)!: discovery validates entry contract, drop sh shebang/exec-bit fallback"`

---

### Task 3: core/cli 起動配線 — process.execPath で spawn

**Files:**
- Modify: `packages/cli/src/core-ext/run-wiring.ts:238-250`(makeRunner)
- Test: `packages/cli/src/core-ext/run-wiring.test.ts`

**Interfaces:**
- Consumes: `DiscoveredPlugin.entryPath`(Task 2)
- Produces: プラグイン子プロセスは常に `spawn(process.execPath, [entryPath], …)`、env に `HALO_PLUGIN_DIR`(= plugin.dir)を注入。

- [ ] **Step 1: 失敗するテストを書く** — makeRunner が `execPath === process.execPath`、`args === [plugin.entryPath]`、`env.HALO_PLUGIN_DIR === plugin.dir` で runPort を呼ぶことを spawn シーム経由で検証するテストを追加。
- [ ] **Step 2: FAIL 確認** — `pnpm --filter @tsurupong/halo test -- run-wiring`
- [ ] **Step 3: 実装** — makeRunner を置換:

```ts
function makeRunner(ctx: RunContext): PortRunner {
  // entry 契約 (ADR-0018): 自プロセスの Node で JS エントリを直接起動する。
  // PATH 解決・exec-bit・shebang に依存しない (旧 D10 §5 フォールバックは廃止)。
  return (plugin: DiscoveredPlugin, stdin: unknown, opts?: { timeoutSec?: number }) =>
    runPort({
      execPath: process.execPath,
      args: [plugin.entryPath],
      cwd: ctx.cwd,
      env: { ...baseEnv(), ...(plugin.manifest.env ?? {}), HALO_PLUGIN_DIR: plugin.dir },
      stdin,
      timeoutMs: (opts?.timeoutSec ?? DEFAULT_PORT_TIMEOUT_SEC) * 1000,
    });
}
```

runPort 自体(`packages/core/src/runPort.ts`)は無変更。

- [ ] **Step 4: PASS 確認 + Commit** — `pnpm --filter @tsurupong/halo test` → `git commit -m "feat(cli)!: spawn plugins via process.execPath + entryPath, inject HALO_PLUGIN_DIR"`

---

### Task 4: plugins — HALO_LAUNCHER_DIR 廃止(delegate / trigger / scheduler)

**Files:**
- Modify: `packages/plugins/src/gate-runtime-check/delegate.ts`
- Modify: `packages/plugins/src/trigger-polling/install.ts`, `packages/plugins/src/trigger-schedule/install.ts`
- Modify: `packages/plugins/src/trigger/common.ts:51-59`(install)、`packages/plugins/src/lib/scheduler.ts:99-104`(schedulerInstall)
- Test: 各既存テスト(`gate-runtime-check/*.test.ts`, `trigger/*.test.ts`, `lib/scheduler.test.ts`)

**Interfaces:**
- Consumes: `HALO_PLUGIN_DIR`(Task 3)、runtime プラグインの plugin.json `aux`(Task 5 で定義するが、本タスクのテストは fake で先行)
- Produces: `schedulerInstall(trigger, profile, spec, fireArgv: readonly string[])` — コマンド文字列は `fireArgv` を quote して組む。

- [ ] **Step 1: delegate.ts を entry 解決へ(テスト先行)** — 「runtimeDir の plugin.json を読み、`aux[runtimeScript]` の JS を `process.execPath` で spawnSync する」テストを書き FAIL を確認後、実装:

```ts
export async function delegate(gate: string, runtimeRole: 'check' | 'test' | 'setup'): Promise<never> {
  const pluginDir = process.env['HALO_PLUGIN_DIR'] ?? '.';
  const runtimeDir = process.env['HALO_RUNTIME_DIR'] ?? join(pluginDir, '..', '..', 'runtime.d', 'runtime-node-pnpm');

  const input = await readStdinJson().catch(() => undefined);
  const workdir = str(input, 'workdir');
  if (workdir === undefined) emitFail('invalid gate input: workdir required', gate);

  const manifestPath = join(runtimeDir, 'plugin.json');
  if (!existsSync(manifestPath)) emitFail(`runtime plugin.json not found: ${manifestPath}`, gate);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entry?: string; aux?: Record<string, string> };
  const rel = runtimeRole === 'setup' ? manifest.entry : manifest.aux?.[runtimeRole];
  if (rel === undefined) emitFail(`runtime entry '${runtimeRole}' not declared: ${manifestPath}`, gate);
  const scriptPath = isAbsolute(rel) ? rel : join(runtimeDir, rel);
  if (!existsSync(scriptPath)) emitFail(`runtime script not found: ${scriptPath}`, gate);

  const changed = typeof input === 'object' && input !== null
    ? ((input as Record<string, unknown>)['changed_files'] ?? []) : [];
  const r = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify({ workdir, changed_files: changed }),
    stdio: ['pipe', 2, 2],
  });
  const code = r.error !== undefined ? 127 : (r.status ?? 1);
  if (code !== 0) emitFail(`${gate} failed (runtime ${runtimeRole} exit ${code})`, gate);
  process.exit(0);
}
```

呼び出し側(`gate-runtime-check/typecheck.ts` / `test.ts`)は `delegate('typecheck', 'check')` / `delegate('test', 'test')` のようにロール名渡しへ更新。

- [ ] **Step 2: scheduler / trigger install(テスト先行)** — scheduler.test.ts に「fireArgv が quote されてコマンドに載る」テストを追加し FAIL 確認後:
  - `schedulerInstall(..., fireArgv: readonly string[])` へ変更、`scheduler.ts:103` を `const cmd = \`${buildEnvAssign()}${fireArgv.map((a) => JSON.stringify(a)).join(' ')} ${profile}\`;` に。
  - `common.ts` の `install(trigger, profile, spec, fireArgv: readonly string[])` へ変更。
  - `trigger-polling/install.ts` / `trigger-schedule/install.ts`:

```ts
const pluginDir = process.env['HALO_PLUGIN_DIR'] ?? '.';
install('polling', profile, `interval:${interval}`, [process.execPath, join(pluginDir, 'fire.js')]);
```

  (`fire.js` の実パス解決は Task 6 の enable が plugin.json `aux.fire` を絶対パス化して配るため、install.ts は plugin.json を読んで `aux.fire` を使う実装にする — delegate と同じ読み方。)
- [ ] **Step 3: grep 検証** — `grep -rn "HALO_LAUNCHER_DIR" packages/` が 0 件。
- [ ] **Step 4: PASS 確認 + Commit** — `pnpm --filter @tsurupong/halo-plugins test` → `git commit -m "feat(plugins)!: resolve entries via HALO_PLUGIN_DIR + manifest aux, node-direct scheduler command"`

---

### Task 5: registry と同梱 plugin.json の entry 化 + ランチャー .sh 削除

**Files:**
- Modify: `packages/plugins/src/registry.ts`(全 11 エントリ)
- Modify: `plugins/*/plugin.json`(11 個)
- Delete: `plugins/**/​*.sh` 16 個と `plugins/*/fire` 2 個(git rm)
- Test: `packages/plugins/src/registry.test.ts`(drift 検出)

**Interfaces:**
- Produces: `BundledPlugin.manifest.entry`(dist 相対パスのロール `main`)+ `manifest.aux`。`BundledEntry` 型と `entries` 配列は廃止し、enable は manifest の entry/aux を絶対パス化するだけになる(Task 6)。

- [ ] **Step 1: registry.test.ts の drift 検証を entry 契約へ更新(FAIL 確認)**
- [ ] **Step 2: registry.ts 書き換え** — 例(他 10 件も同型):

```ts
{
  name: 'trigger-polling',
  port: 'trigger',
  manifest: {
    name: '@halo/plugin-trigger-polling',
    version: '1.0.0',
    port: 'trigger',
    entry: './trigger-polling/fire.js',      // dist ルート相対。enable が絶対化する
    aux: {
      fire: './trigger-polling/fire.js',
      install: './trigger-polling/install.js',
      uninstall: './trigger-polling/uninstall.js',
    },
  },
},
{
  name: 'runtime-node-pnpm',
  port: 'runtime',
  manifest: {
    name: '@halo/plugin-runtime-node-pnpm', version: '1.0.0', port: 'runtime',
    entry: './runtime-node-pnpm/setup.js',
    aux: { check: './runtime-node-pnpm/check.js', test: './runtime-node-pnpm/test.js' },
  },
},
```

  gate-runtime-check-typecheck/-test の `env.HALO_RUNTIME_DIR` テンプレートは現状維持。
- [ ] **Step 3: リポジトリ内 plugin.json を同内容に更新** — `plugins/<name>/plugin.json` の `exec` を削除し `entry`/`aux` へ。リポジトリ内では monorepo 相対 `"entry": "../../packages/plugins/dist/<...>.js"` 形式(既存の相対ランチャーと同じ到達性)。
- [ ] **Step 4: ランチャー削除** — `git rm plugins/*/​*.sh plugins/*/fire plugins/gate-runtime-check/10-typecheck/run.sh plugins/gate-runtime-check/30-test/run.sh`(対象一覧は `find plugins -name '*.sh' -o -name fire` で確認してから)。
- [ ] **Step 5: PASS 確認 + Commit** — `pnpm --filter @tsurupong/halo-plugins test && pnpm build` → `git commit -m "feat(plugins)!: entry-based manifests, remove all launcher scripts"`

---

### Task 6: `halo enable` — sh 生成廃止、絶対パス plugin.json 生成

**Files:**
- Modify: `packages/cli/src/commands/enable.ts`
- Test: `packages/cli/src/commands/enable.test.ts`

**Interfaces:**
- Consumes: Task 5 の registry(manifest.entry / aux は dist 相対)
- Produces: `.halo/ports/<port>.d/<name>/plugin.json` のみ生成。entry / aux 値は `join(distRoot, rel)` の絶対パス。

- [ ] **Step 1: 失敗するテストを書く** — enable 実行後 (a) plugin.json の entry/aux が distRoot 起点の絶対パス、(b) .sh ファイルが生成されない、(c) chmod が呼ばれない、を検証。
- [ ] **Step 2: FAIL 確認** — `pnpm --filter @tsurupong/halo test -- enable`
- [ ] **Step 3: 実装** — `launcherScript()`・`chmod` 依存・`BundledEntry` ループを削除し:

```ts
const absolutize = (rel: string): string => (isAbsolute(rel) ? rel : join(distRoot, rel));
const manifest: PluginManifest = {
  ...plugin.manifest,
  entry: absolutize(plugin.manifest.entry),
  ...(plugin.manifest.aux !== undefined
    ? { aux: Object.fromEntries(Object.entries(plugin.manifest.aux).map(([k, v]) => [k, absolutize(v)])) }
    : {}),
  ...(resolvedEnv !== undefined ? { env: resolvedEnv } : {}),
};
await deps.fs.writeFile(`${targetDir}/plugin.json`, `${JSON.stringify(manifest, null, 2)}\n`);
```

  `EnableDeps.chmod` と `nodeChmod` import も削除。
- [ ] **Step 4: doctor に旧設定検出を追加(spec §5)** — `packages/cli/src/commands/doctor.ts` に「スケジューラ登録コマンド / ports 配下に `.sh` 参照が残っている」場合 WARN を出すチェックをテスト先行で追加(FAIL → 実装 → PASS)。
- [ ] **Step 5: PASS 確認 + Commit** — `git commit -m "feat(cli)!: halo enable writes absolute-entry plugin.json, no launcher generation"`

---

### Task 7: task-source-local を同梱 TS プラグイン化

**Files:**
- Create: `packages/plugins/src/task-source-local/main.ts`
- Create: `packages/plugins/src/task-source-local/task-source-local.test.ts`
- Create: `plugins/task-source-local/plugin.json`, `plugins/task-source-local/contract.fixtures.json`
- Modify: `packages/plugins/src/registry.ts`(1 エントリ追加)

**Interfaces:**
- Consumes: `readStdinJson` / `writeStdoutJson`(`packages/plugins/src/lib/io.ts`、task-source-github と同じ)
- Produces: stdin `{op:'next'|'complete'|'fail', task_id?, pr_url?, reason?, retry_count?}` → 旧 run.sh と同一の挙動(仕様は run.sh 62 行のコメント+実装に一致させる: queue 先頭 md を task 化 / complete で done/ へ + .result / fail は failures.log 追記、retry_count >= HALO_FAIL_THRESHOLD(既定3) で needs-human/ へ)。

- [ ] **Step 1: テストを先に書く** — Vitest で tmpdir に queue/*.md を用意し、next(空 → `{task_id:null}`、非空 → 先頭ソート・title 抽出・body 全文・kind:"code")、complete(done へ移動 + result ファイル)、fail(閾値未満は残留、以上で needs-human へ)、unknown op(exit 2 相当エラー)を検証。FAIL 確認。
- [ ] **Step 2: main.ts 実装** — bash 版と同挙動。骨子:

```ts
// task-source-local: ローカル md キューをタスク源にする (旧 run.sh の TS 移植, ADR-0018)。
import { readdirSync, readFileSync, renameSync, mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readStdinJson, writeStdoutJson, str } from '../lib/io.js';

const tasksDir = process.env['HALO_TASKS_DIR'] ?? join(process.cwd(), '.halo', 'tasks');
const failThreshold = Number(process.env['HALO_FAIL_THRESHOLD'] ?? '3');
// … queue/done/needs-human を mkdirSync(recursive)、op で分岐。
// next: readdirSync(queue).filter(.md).sort()[0]; title = /^# (.+)$/m の初出 ?? id。
// complete: renameSync + writeFileSync(`${id}.result`, `completed_at=${new Date().toISOString()}\npr_url=${prUrl}\n`)
// fail: appendFileSync(failures.log, `${new Date().toISOString()} fail #${rc}: ${reason}\n`);
//       rc >= failThreshold && existsSync(src) で needs-human へ renameSync。
// エラーは stderr + exit 2 (die 相当)。
```

  (テストが仕様の一次情報。上記コメント部は実装時に全て実コード化する。)
- [ ] **Step 3: registry / plugin.json / fixtures 追加** — `entry: './task-source-local/main.js'`、port `task-source`。contract.fixtures.json は task-source-github のものを雛形に next/complete/fail の 3 ケース。
- [ ] **Step 4: PASS 確認 + Commit** — `pnpm --filter @tsurupong/halo-plugins test && pnpm test:contract` → `git commit -m "feat(plugins): promote task-source-local to bundled TS plugin"`

---

### Task 8: core テストモック .sh → .mjs

**Files:**
- Create: `packages/core/test/mocks/{executor,gate,on-fail,sink,task-source}.mjs`
- Delete: 同 `.sh` 5 個(git rm)
- Modify: モックを spawn している core テスト(`grep -rln "test/mocks" packages/core/src` で列挙)

**Interfaces:**
- Produces: 各モックは旧 .sh と同一の stdin/stdout/exit 契約。テスト側は `execPath: process.execPath, args: [mockPath]` で起動(= 新契約そのものの常時検証)。

- [ ] **Step 1: .mjs モック作成** — 例 executor.mjs(他 4 つも同型移植):

```js
// Mock executor plugin (D8 §2.2): 固定 JSON を返すだけ。claude は呼ばない。
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(`{"status":"${process.env.EXEC_STATUS ?? 'done'}","summary":"mock run"}\n`);
  process.exit(0);
});
process.stdin.on('data', () => {});
```

- [ ] **Step 2: テスト側の起動を新契約へ書き換え、`git rm packages/core/test/mocks/*.sh`**
- [ ] **Step 3: PASS 確認 + Commit** — `pnpm --filter @tsurupong/halo-core test` → `git commit -m "test(core): replace sh mocks with node mjs mocks (entry contract)"`

---

### Task 9: e2e-dry-run.sh → e2e-dry-run.mjs

**Files:**
- Create: `scripts/e2e-dry-run.mjs`(依存なし素の ESM、104 行の sh を等価移植)
- Delete: `scripts/e2e-dry-run.sh`(git rm)
- Modify: 参照箇所(`grep -rn "e2e-dry-run" . --exclude-dir=node_modules` — CLAUDE.md / CI / docs)

- [ ] **Step 1: 旧 .sh を読み、同一手順を child_process + fs で移植**(モック環境構築 → halo run → 期待ログ検証、という現行構成を維持)
- [ ] **Step 2: 実行して exit 0 を確認** — `node scripts/e2e-dry-run.mjs`
- [ ] **Step 3: 参照更新 + git rm + Commit** — `git commit -m "chore(scripts): port e2e-dry-run to node mjs"`

---

### Task 10: selfhost 環境の再生成(.halo/ports)

**Files:**
- 再生成: `product/.halo/ports/*`(`halo enable` を 12 プラグイン分 + task-source-local)
- 退避: 旧 `.halo/ports` → `.halo/ports-archive-2026-07-16b/`(削除しない。アーカイブ移動)

- [ ] **Step 1: ビルド** — `pnpm build`
- [ ] **Step 2: 旧 ports をアーカイブ移動**(mv。既存の `ports-archive-2026-07-16/` とは別名)
- [ ] **Step 3: `node packages/cli/dist/... enable <name>` を全同梱プラグイン分実行**(task-source は task-source-local を有効化。gh 未導入のため task-source-github は enable しない)
- [ ] **Step 4: 動作確認** — `.halo/tasks/queue/` にテスト用 md を 1 つ置き、`halo run`(または doctor + dry-run 相当)で next → 実行 → 完了系のログを目視。`find .halo/ports -name '*.sh'` が 0 件。
- [ ] **Step 5: Commit**(.halo が git 管理対象の範囲のみ) — `git commit -m "chore(selfhost): regenerate ports with entry contract"`

---

### Task 11: docs — ADR-0018 / D11 改訂 / CLAUDE.md / バージョン

**Files:**
- Create: `docs/adr/0018-entry-contract.md`(template.md 準拠。Context: sh ランチャーの環境依存残存 / Decision: entry+aux 契約、process.execPath 直接 spawn、HALO_PLUGIN_DIR / Consequences: 非 Node プラグイン非対応(将来 execArgv 拡張で再導入可)。Supersedes: ADR-0017 のランチャー節)
- Modify: `docs/design/d11-*.md` §3(launcher 生成 → plugin.json 生成)
- Modify: `packages/{cli,core,contracts,plugins}/package.json` version → `0.3.0`、相互依存も更新
- Modify: `/mnt/d/workspace/project/halo/.claude/CLAUDE.md`(「薄いPOSIX shランチャー」記述、現在の状態欄)

- [ ] **Step 1: ADR-0018 起草、D11 §3 改訂**
- [ ] **Step 2: 4 パッケージ version bump + `pnpm install`(lockfile 更新)**
- [ ] **Step 3: CLAUDE.md 更新**
- [ ] **Step 4: Commit** — `git commit -m "docs: ADR-0018 entry contract, D11 revision, bump to 0.3.0"`

---

### Task 12: 最終検証(quality-checklist 相当)

- [ ] **Step 1: sh ゼロ確認** — `find . -name '*.sh' -not -path './node_modules/*' -not -path './.git/*' -not -path './.halo/ports-archive-*/*'` → 0 件
- [ ] **Step 2: 残骸 grep** — `grep -rn "HALO_LAUNCHER_DIR\|execArgv\|isShellShebang\|launcherScript" packages plugins` → 0 件、`grep -rn "\"exec\"" plugins packages/plugins/src/registry.ts` → 0 件
- [ ] **Step 3: 全体検証** — `pnpm build && pnpm lint && pnpm test && pnpm test:contract`(480+ 全 green)
- [ ] **Step 4: selfhost 実動作** — Task 10 Step 4 の再確認(実行ログ添付)
- [ ] **Step 5: Commit / 報告** — 未コミット差分を確定し、テスト件数・検証結果を添えてユーザーへ報告。push / npm publish はユーザー承認後。
