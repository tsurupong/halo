// scheduler.ts の単体テスト: schedulerInstall が fireArgv を JSON.stringify で quote して
// コマンド文字列に埋め込むことを検証する(firePath 文字列渡しから fireArgv 化, ADR-0017)。
// 実スケジューラには触れず、HALO_SCHEDULER=cron 強制 + crontab スタブで内容だけを見る。
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schedulerInstall } from './scheduler.js';

const tmpRoots: string[] = [];

function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'halo-scheduler-test-'));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env['HALO_SCHEDULER'];
  delete process.env['PATH_BACKUP_UNUSED'];
});

describe('schedulerInstall: fireArgv quoting', () => {
  it('fireArgv の各要素を JSON.stringify で quote してコマンドへ埋め込む', () => {
    const root = mkTmp();
    const stubDir = join(root, 'stubbin');
    mkdirSync(stubDir, { recursive: true });
    const state = join(root, 'crontab.state');
    writeFileSync(
      join(stubDir, 'crontab'),
      `#!/usr/bin/env bash\nif [ "\${1:-}" = "-l" ]; then\n  [ -f "${state}" ] || { echo "no crontab" >&2; exit 1; }\n  cat "${state}"\nelif [ "\${1:-}" = "-" ]; then\n  cat > "${state}"\nfi\nexit 0\n`,
    );
    chmodSync(join(stubDir, 'crontab'), 0o755);

    const originalPath = process.env['PATH'];
    const originalScheduler = process.env['HALO_SCHEDULER'];
    process.env['PATH'] = `${stubDir}:${originalPath ?? ''}`;
    process.env['HALO_SCHEDULER'] = 'cron';
    try {
      schedulerInstall('polling', 'p1', 'interval:15', ['/usr/bin/node', '/opt/plugins/trigger-polling/fire.js']);
    } finally {
      process.env['PATH'] = originalPath;
      if (originalScheduler === undefined) delete process.env['HALO_SCHEDULER'];
      else process.env['HALO_SCHEDULER'] = originalScheduler;
    }

    const stateContent = readFileSync(state, 'utf8');
    expect(stateContent).toContain(
      '"/usr/bin/node" "/opt/plugins/trigger-polling/fire.js" p1 # HALO:polling:p1',
    );
  });

  it('fireArgv に $(...) を含む要素があれば throw する(コマンド注入対策)', () => {
    process.env['HALO_SCHEDULER'] = 'cron';
    try {
      expect(() =>
        schedulerInstall('polling', 'p1', 'interval:15', ['/usr/bin/node', '$(whoami)']),
      ).toThrow(/scheduler: invalid fireArgv/);
    } finally {
      delete process.env['HALO_SCHEDULER'];
    }
  });

  it('fireArgv にバッククォートを含む要素があれば throw する(コマンド注入対策)', () => {
    process.env['HALO_SCHEDULER'] = 'cron';
    try {
      expect(() =>
        schedulerInstall('polling', 'p1', 'interval:15', ['/usr/bin/node', '`whoami`']),
      ).toThrow(/scheduler: invalid fireArgv/);
    } finally {
      delete process.env['HALO_SCHEDULER'];
    }
  });

  it('空白入り絶対パスの fireArgv は通る', () => {
    const root = mkTmp();
    const stubDir = join(root, 'stubbin');
    mkdirSync(stubDir, { recursive: true });
    const state = join(root, 'crontab.state');
    writeFileSync(
      join(stubDir, 'crontab'),
      `#!/usr/bin/env bash\nif [ "\${1:-}" = "-l" ]; then\n  [ -f "${state}" ] || { echo "no crontab" >&2; exit 1; }\n  cat "${state}"\nelif [ "\${1:-}" = "-" ]; then\n  cat > "${state}"\nfi\nexit 0\n`,
    );
    chmodSync(join(stubDir, 'crontab'), 0o755);

    const originalPath = process.env['PATH'];
    const originalScheduler = process.env['HALO_SCHEDULER'];
    process.env['PATH'] = `${stubDir}:${originalPath ?? ''}`;
    process.env['HALO_SCHEDULER'] = 'cron';
    try {
      expect(() =>
        schedulerInstall('polling', 'p1', 'interval:15', ['/usr/bin/node', '/opt/plugins with space/fire.js']),
      ).not.toThrow();
    } finally {
      process.env['PATH'] = originalPath;
      if (originalScheduler === undefined) delete process.env['HALO_SCHEDULER'];
      else process.env['HALO_SCHEDULER'] = originalScheduler;
    }
  });
});
