// D10 §4 (portability) の doctor 拡張: c10 必須コマンド / c11 スケジューラバックエンド /
// c8 の WSL 条件化。probe 未注入時の後方互換 (従来 9 検査+c12) も assert する。
import { expect, test, describe } from 'vitest';
import {
  checkRequiredCommands,
  checkSchedulerBackend,
  checkPlacement,
  runAll,
  REQUIRED_COMMANDS,
  type CheckResult,
  type DoctorProbes,
  type SchedulerBackend,
} from './doctor.js';
import type { CliFs } from './fs.js';
import { memFs } from './testkit.js';

function stubFs(): CliFs {
  return {
    readFile: async () => {
      throw new Error('ENOENT');
    },
    writeFile: async () => {},
    mkdir: async () => {},
    readdir: async () => {
      throw new Error('ENOENT');
    },
    rm: async () => {},
    exists: async () => false,
    isDirectory: async () => false,
  };
}

function baseProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  const fs = stubFs();
  return {
    haloDir: '/repo/.halo',
    cwd: '/repo',
    fs,
    command: {
      exists: async () => true,
      ghAuth: async () => ({ authenticated: true, overprivileged: false }),
      claudeResponds: async () => true,
      gitStatus: async () => ({ isRepo: true, hasUserName: true, hasUserEmail: true }),
    },
    triggerCtx: {
      haloDir: '/repo/.halo',
      cwd: '/repo',
      fs,
      spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
    orphanLock: async () => false,
    onExt4: async () => true,
    diskOk: async () => true,
    ...overrides,
  };
}

function findCheck(checks: readonly CheckResult[], id: number): CheckResult | undefined {
  return checks.find((c) => c.id === id);
}

describe('c10 必須コマンド', () => {
  test('全コマンド存在 → OK', async () => {
    const report = await runAll(baseProbes({ commandExists: async () => true }));
    const c10 = findCheck(report.checks, 10);
    expect(c10?.status).toBe('OK');
  });
  test('一部欠落 → FAIL + 欠落名を detail に列挙', async () => {
    const report = await runAll(
      baseProbes({ commandExists: async (name) => name !== 'node' && name !== 'claude' }),
    );
    const c10 = findCheck(report.checks, 10);
    expect(c10?.status).toBe('FAIL');
    expect(c10?.detail).toContain('node');
    expect(c10?.detail).toContain('claude');
    expect(c10?.detail).not.toContain('git,');
  });
  test('純関数: 欠落なし → OK / hint にインストール例', () => {
    expect(checkRequiredCommands([]).status).toBe('OK');
    const fail = checkRequiredCommands(['node']);
    expect(fail.status).toBe('FAIL');
    expect(fail.detail).toMatch(/pacman -S nodejs|brew install/);
  });
  test('検査対象は node / git / claude (ADR-0017: jq/timeout は不要)', () => {
    expect([...REQUIRED_COMMANDS]).toEqual(['node', 'git', 'claude']);
  });
});

describe('c11 スケジューラバックエンド', () => {
  const backends: SchedulerBackend[] = ['schtasks', 'systemd', 'cron', 'launchd'];
  for (const b of backends) {
    test(`${b} 検出 → OK`, async () => {
      const report = await runAll(baseProbes({ schedulerBackend: async () => b }));
      const c11 = findCheck(report.checks, 11);
      expect(c11?.status).toBe('OK');
      expect(c11?.detail).toContain(b);
    });
  }
  test('none → FAIL + HALO_SCHEDULER の hint', async () => {
    const report = await runAll(baseProbes({ schedulerBackend: async () => 'none' }));
    const c11 = findCheck(report.checks, 11);
    expect(c11?.status).toBe('FAIL');
    expect(c11?.detail).toContain('HALO_SCHEDULER');
    expect(report.exitCode).toBe(1);
  });
  test('純関数: none 以外は OK', () => {
    expect(checkSchedulerBackend('cron').status).toBe('OK');
    expect(checkSchedulerBackend('none').status).toBe('FAIL');
  });
});

describe('c8 配置制約の WSL 条件化', () => {
  test('isWsl=false → /mnt/c 配下でも fail/warn しない', async () => {
    const report = await runAll(
      baseProbes({ onExt4: async () => false, isWsl: async () => false }),
    );
    const c8 = findCheck(report.checks, 8);
    expect(c8?.status).toBe('OK');
    expect(c8?.detail).toContain('スキップ');
  });
  test('isWsl=true → 従来どおり ext4 外は WARN', async () => {
    const report = await runAll(baseProbes({ onExt4: async () => false, isWsl: async () => true }));
    expect(findCheck(report.checks, 8)?.status).toBe('WARN');
  });
  test('純関数: isWsl 省略時は従来挙動 (WARN)', () => {
    expect(checkPlacement(false).status).toBe('WARN');
    expect(checkPlacement(false, false).status).toBe('OK');
  });
});

describe('後方互換: probe 未注入', () => {
  test('c10/c11 は実行されず c1-c9/c12 の10検査のまま、c8 は無条件実行', async () => {
    const report = await runAll(baseProbes({ onExt4: async () => false }));
    expect(report.checks).toHaveLength(10);
    expect(findCheck(report.checks, 10)).toBeUndefined();
    expect(findCheck(report.checks, 11)).toBeUndefined();
    expect(findCheck(report.checks, 8)?.status).toBe('WARN');
  });
});

describe('c12 旧ランチャー設定の検出 (entry契約化 Task 6 Step D)', () => {
  test('.sh ファイルが ports 配下に残存 → WARN', async () => {
    const fs = memFs({
      files: {
        '/repo/.harness.yml': 'kinds:\n',
        '/repo/.halo/ports/sink.d/sink-progress-log/plugin.json': JSON.stringify({
          entry: '/dist/sink-progress-log/main.js',
        }),
        '/repo/.halo/ports/sink.d/sink-progress-log/log.sh': '#!/bin/sh\n',
      },
    });
    const report = await runAll(baseProbes({ fs }));
    const c12 = findCheck(report.checks, 12);
    expect(c12?.status).toBe('WARN');
    expect(c12?.detail).toContain('sink-progress-log');
  });

  test('plugin.json が .sh を参照している → WARN', async () => {
    const fs = memFs({
      files: {
        '/repo/.harness.yml': 'kinds:\n',
        '/repo/.halo/ports/trigger.d/trigger-polling/plugin.json': JSON.stringify({
          entry: '/dist/trigger-polling/fire.js',
          aux: { fire: '/dist/trigger-polling/fire.sh' },
        }),
      },
    });
    const report = await runAll(baseProbes({ fs }));
    const c12 = findCheck(report.checks, 12);
    expect(c12?.status).toBe('WARN');
    expect(c12?.detail).toContain('trigger-polling');
  });

  test('.sh 参照が一切ない → OK', async () => {
    const fs = memFs({
      files: {
        '/repo/.harness.yml': 'kinds:\n',
        '/repo/.halo/ports/sink.d/sink-progress-log/plugin.json': JSON.stringify({
          entry: '/dist/sink-progress-log/main.js',
        }),
      },
    });
    const report = await runAll(baseProbes({ fs }));
    const c12 = findCheck(report.checks, 12);
    expect(c12?.status).toBe('OK');
  });

  test('ports 配下が空/未作成 → OK (FAIL にしない)', async () => {
    const report = await runAll(baseProbes());
    const c12 = findCheck(report.checks, 12);
    expect(c12?.status).toBe('OK');
  });
});
