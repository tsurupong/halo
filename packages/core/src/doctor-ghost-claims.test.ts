// doctor c15: 幽霊 claim (doing/ 残留) の検査 (ADR-0025 Decision #4 / Risks, D3 §4)。
// task-source-local の doing/ (github の in-progress) に claim したまま launch が
// 死んだタスクが残っていないかを見る。回収そのものは task-source の責務 (ADR-0025)
// なので、ここは検知して WARN するだけ — 勝手に queue/ へ戻さない。
// 既存 doctor.test.ts には触れず追加分をここに置く (doctor-watchdog.test.ts に倣う)。
import { describe, expect, test } from 'vitest';
import { checkGhostClaims, type GhostClaimEntry } from './doctor.js';

describe('checkGhostClaims (c15)', () => {
  test('no claimed tasks is OK', () => {
    const r = checkGhostClaims([]);
    expect(r.id).toBe(15);
    expect(r.status).toBe('OK');
  });

  test('a freshly claimed task (well within the stale window) is OK', () => {
    const entries: GhostClaimEntry[] = [{ taskId: 'task-1', ageSec: 30 }];
    expect(checkGhostClaims(entries).status).toBe('OK');
  });

  test('a task claimed past the stale threshold warns and names it', () => {
    const entries: GhostClaimEntry[] = [{ taskId: 'task-9', ageSec: 4000 }];
    const r = checkGhostClaims(entries);
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('task-9');
  });

  test('a custom stale threshold is respected', () => {
    const entries: GhostClaimEntry[] = [{ taskId: 'task-2', ageSec: 100 }];
    expect(checkGhostClaims(entries, 50).status).toBe('WARN');
    expect(checkGhostClaims(entries, 200).status).toBe('OK');
  });

  test('mixes fresh and stale entries, reporting only the stale ones', () => {
    const entries: GhostClaimEntry[] = [
      { taskId: 'fresh', ageSec: 10 },
      { taskId: 'stale', ageSec: 9999 },
    ];
    const r = checkGhostClaims(entries, 3600);
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('stale');
    expect(r.detail).not.toContain('fresh');
  });

  test('never FAIL — a ghost claim degrades throughput, it does not corrupt state', () => {
    const entries: GhostClaimEntry[] = [{ taskId: 't', ageSec: 999_999 }];
    expect(checkGhostClaims(entries).status).not.toBe('FAIL');
  });
});
