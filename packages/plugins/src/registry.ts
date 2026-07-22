// 同梱プラグインのメタデータ台帳 (ADR-0017 / D11 §3)。`halo enable` はここを唯一の情報源として
// 絶対パスランチャーを生成する。各エントリの `manifest` はリポジトリの `plugins/**/plugin.json`
// と同一内容を保つ（drift は registry.test.ts が検出する）。ただし `entry`/`aux` はリポジトリ側が
// monorepo 相対パス、registry 側が `@tsurupong/halo-plugins` の dist ルート相対パスと表現が異なる
// （enable がこれを絶対パス化する）。
import type { PluginManifest, Port } from '@tsurupong/halo-contracts';

/** 同梱プラグイン1件のメタデータ。 */
export interface BundledPlugin {
  /** `halo enable <name>` で指定する有効化名。 */
  name: string;
  /** 有効化先ポート (`.halo/ports/<port>.d/`)。 */
  port: Port;
  /** リポジトリの `plugins/<name>/plugin.json` と同内容(entry/aux はdistルート相対)。 */
  manifest: PluginManifest;
  /**
   * ランチャー生成時にマニフェストへ追加する環境変数のテンプレート。値中の
   * `{PORTS_DIR}` は `.halo/ports` の絶対パスへ展開される (例: HALO_RUNTIME_DIR)。
   */
  env?: Record<string, string>;
}

export const BUNDLED_PLUGINS: BundledPlugin[] = [
  {
    name: 'context-recent-failures',
    port: 'context',
    manifest: {
      name: '@halo/plugin-context-recent-failures',
      version: '1.0.0',
      port: 'context',
      entry: './context-recent-failures/main.js',
      order: 50,
    },
  },
  {
    name: 'executor-claude',
    port: 'executor',
    manifest: {
      name: '@halo/plugin-executor-claude',
      version: '1.0.0',
      port: 'executor',
      entry: './executor-claude/main.js',
      timeoutSec: 960,
    },
  },
  {
    name: 'gate-loop-audit',
    port: 'gate',
    manifest: {
      name: '@halo/plugin-gate-loop-audit',
      version: '1.0.0',
      port: 'gate',
      entry: './gate-loop-audit/main.js',
      order: 50,
    },
  },
  {
    name: 'gate-runtime-check-typecheck',
    port: 'gate',
    manifest: {
      name: '@halo/plugin-gate-runtime-check-typecheck',
      version: '1.0.0',
      port: 'gate',
      entry: './gate-runtime-check/typecheck.js',
      order: 10,
    },
    env: { HALO_RUNTIME_DIR: '{PORTS_DIR}/runtime.d/runtime-node-pnpm' },
  },
  {
    name: 'gate-runtime-check-test',
    port: 'gate',
    manifest: {
      name: '@halo/plugin-gate-runtime-check-test',
      version: '1.0.0',
      port: 'gate',
      entry: './gate-runtime-check/test.js',
      order: 30,
    },
    env: { HALO_RUNTIME_DIR: '{PORTS_DIR}/runtime.d/runtime-node-pnpm' },
  },
  {
    name: 'on-fail-record',
    port: 'on-fail',
    manifest: {
      name: '@halo/plugin-on-fail-record',
      version: '1.0.0',
      port: 'on-fail',
      entry: './on-fail-record/main.js',
      order: 10,
    },
  },
  {
    name: 'on-fail-notify',
    port: 'on-fail',
    manifest: {
      name: '@halo/plugin-on-fail-notify',
      version: '1.0.0',
      port: 'on-fail',
      entry: './on-fail-notify/main.js',
      order: 30,
    },
  },
  {
    name: 'on-fail-requeue',
    port: 'on-fail',
    manifest: {
      name: '@halo/plugin-on-fail-requeue',
      version: '1.0.0',
      port: 'on-fail',
      entry: './on-fail-requeue/main.js',
      order: 20,
    },
  },
  {
    name: 'runtime-node-pnpm',
    port: 'runtime',
    manifest: {
      name: '@halo/plugin-runtime-node-pnpm',
      version: '1.0.0',
      port: 'runtime',
      entry: './runtime-node-pnpm/setup.js',
      aux: {
        check: './runtime-node-pnpm/check.js',
        test: './runtime-node-pnpm/test.js',
      },
    },
  },
  {
    name: 'sink-git-commit',
    port: 'sink',
    manifest: {
      name: '@halo/plugin-sink-git-commit',
      version: '1.0.0',
      port: 'sink',
      entry: './sink-git-commit/main.js',
      order: 10,
      minAutonomy: 'L1',
    },
  },
  {
    name: 'sink-progress-log',
    port: 'sink',
    manifest: {
      name: '@halo/plugin-sink-progress-log',
      version: '1.0.0',
      port: 'sink',
      entry: './sink-progress-log/main.js',
      order: 20,
      minAutonomy: 'L1',
    },
  },
  {
    name: 'task-source-github',
    port: 'task-source',
    manifest: {
      name: '@halo/plugin-task-source-github',
      version: '1.0.0',
      port: 'task-source',
      entry: './task-source-github/main.js',
    },
  },
  {
    name: 'task-source-local',
    port: 'task-source',
    manifest: {
      name: '@halo/plugin-task-source-local',
      version: '1.0.0',
      port: 'task-source',
      entry: './task-source-local/main.js',
    },
  },
  {
    name: 'trigger-polling',
    port: 'trigger',
    manifest: {
      name: '@halo/plugin-trigger-polling',
      version: '1.0.0',
      port: 'trigger',
      entry: './trigger-polling/fire.js',
      aux: {
        fire: './trigger-polling/fire.js',
        install: './trigger-polling/install.js',
        uninstall: './trigger-polling/uninstall.js',
      },
    },
  },
  {
    name: 'trigger-schedule',
    port: 'trigger',
    manifest: {
      name: '@halo/plugin-trigger-schedule',
      version: '1.0.0',
      port: 'trigger',
      entry: './trigger-schedule/fire.js',
      aux: {
        fire: './trigger-schedule/fire.js',
        install: './trigger-schedule/install.js',
        uninstall: './trigger-schedule/uninstall.js',
      },
    },
  },
];
