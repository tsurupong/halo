// 同梱プラグインのメタデータ台帳 (ADR-0017 / D11 §3)。`halo enable` はここを唯一の情報源として
// 絶対パスランチャーを生成する。各エントリの `manifest` はリポジトリの `plugins/**/plugin.json`
// と同一内容を保つ（drift は registry.test.ts が検出する）。
import type { PluginManifest, Port } from '@tsurupong/halo-contracts';

/** 生成するランチャー1本の定義。`script` はディレクトリ内のファイル名、`dist` は
 * `@tsurupong/halo-plugins` の dist ルートから見た実装ファイルへの相対パス。 */
export interface BundledEntry {
  script: string;
  dist: string;
}

/** 同梱プラグイン1件のメタデータ。 */
export interface BundledPlugin {
  /** `halo enable <name>` で指定する有効化名。 */
  name: string;
  /** 有効化先ポート (`.halo/ports/<port>.d/`)。 */
  port: Port;
  /** リポジトリの `plugins/<name>/plugin.json` と同一内容。 */
  manifest: PluginManifest;
  /** 生成するランチャー群。 */
  entries: BundledEntry[];
  /**
   * ランチャー生成時にマニフェストへ追加する環境変数のテンプレート。値中の
   * `{PORTS_DIR}` は `.halo/ports` の絶対パスへ展開される (例: HALO_RUNTIME_DIR)。
   */
  env?: Record<string, string>;
}

export const BUNDLED_PLUGINS: BundledPlugin[] = [
  {
    name: 'executor-claude',
    port: 'executor',
    manifest: {
      name: '@halo/plugin-executor-claude',
      version: '1.0.0',
      port: 'executor',
      exec: './run.sh',
      timeoutSec: 960,
    },
    entries: [{ script: 'run.sh', dist: 'executor-claude/main.js' }],
  },
  {
    name: 'gate-loop-audit',
    port: 'gate',
    manifest: {
      name: '@halo/plugin-gate-loop-audit',
      version: '1.0.0',
      port: 'gate',
      exec: './audit.sh',
      order: 50,
    },
    entries: [{ script: 'audit.sh', dist: 'gate-loop-audit/main.js' }],
  },
  {
    name: 'gate-runtime-check-typecheck',
    port: 'gate',
    manifest: {
      name: '@halo/plugin-gate-runtime-check-typecheck',
      version: '1.0.0',
      port: 'gate',
      exec: './run.sh',
      order: 10,
    },
    entries: [{ script: 'run.sh', dist: 'gate-runtime-check/typecheck.js' }],
    env: { HALO_RUNTIME_DIR: '{PORTS_DIR}/runtime.d/runtime-node-pnpm' },
  },
  {
    name: 'gate-runtime-check-test',
    port: 'gate',
    manifest: {
      name: '@halo/plugin-gate-runtime-check-test',
      version: '1.0.0',
      port: 'gate',
      exec: './run.sh',
      order: 30,
    },
    entries: [{ script: 'run.sh', dist: 'gate-runtime-check/test.js' }],
    env: { HALO_RUNTIME_DIR: '{PORTS_DIR}/runtime.d/runtime-node-pnpm' },
  },
  {
    name: 'on-fail-record',
    port: 'on-fail',
    manifest: {
      name: '@halo/plugin-on-fail-record',
      version: '1.0.0',
      port: 'on-fail',
      exec: './record.sh',
      order: 10,
    },
    entries: [{ script: 'record.sh', dist: 'on-fail-record/main.js' }],
  },
  {
    name: 'on-fail-requeue',
    port: 'on-fail',
    manifest: {
      name: '@halo/plugin-on-fail-requeue',
      version: '1.0.0',
      port: 'on-fail',
      exec: './requeue.sh',
      order: 20,
    },
    entries: [{ script: 'requeue.sh', dist: 'on-fail-requeue/main.js' }],
  },
  {
    name: 'runtime-node-pnpm',
    port: 'runtime',
    manifest: {
      name: '@halo/plugin-runtime-node-pnpm',
      version: '1.0.0',
      port: 'runtime',
      exec: './setup.sh',
    },
    entries: [
      { script: 'setup.sh', dist: 'runtime-node-pnpm/setup.js' },
      { script: 'check.sh', dist: 'runtime-node-pnpm/check.js' },
      { script: 'test.sh', dist: 'runtime-node-pnpm/test.js' },
    ],
  },
  {
    name: 'sink-git-commit',
    port: 'sink',
    manifest: {
      name: '@halo/plugin-sink-git-commit',
      version: '1.0.0',
      port: 'sink',
      exec: './commit.sh',
      order: 10,
      minAutonomy: 'L1',
    },
    entries: [{ script: 'commit.sh', dist: 'sink-git-commit/main.js' }],
  },
  {
    name: 'sink-progress-log',
    port: 'sink',
    manifest: {
      name: '@halo/plugin-sink-progress-log',
      version: '1.0.0',
      port: 'sink',
      exec: './log.sh',
      order: 20,
      minAutonomy: 'L1',
    },
    entries: [{ script: 'log.sh', dist: 'sink-progress-log/main.js' }],
  },
  {
    name: 'task-source-github',
    port: 'task-source',
    manifest: {
      name: '@halo/plugin-task-source-github',
      version: '1.0.0',
      port: 'task-source',
      exec: './index.sh',
    },
    entries: [{ script: 'index.sh', dist: 'task-source-github/main.js' }],
  },
  {
    name: 'trigger-polling',
    port: 'trigger',
    manifest: {
      name: '@halo/plugin-trigger-polling',
      version: '1.0.0',
      port: 'trigger',
      exec: './fire',
    },
    entries: [
      { script: 'fire', dist: 'trigger-polling/fire.js' },
      { script: 'install.sh', dist: 'trigger-polling/install.js' },
      { script: 'uninstall.sh', dist: 'trigger-polling/uninstall.js' },
    ],
  },
  {
    name: 'trigger-schedule',
    port: 'trigger',
    manifest: {
      name: '@halo/plugin-trigger-schedule',
      version: '1.0.0',
      port: 'trigger',
      exec: './fire',
    },
    entries: [
      { script: 'fire', dist: 'trigger-schedule/fire.js' },
      { script: 'install.sh', dist: 'trigger-schedule/install.js' },
      { script: 'uninstall.sh', dist: 'trigger-schedule/uninstall.js' },
    ],
  },
];
