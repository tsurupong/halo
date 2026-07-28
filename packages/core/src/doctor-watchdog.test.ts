// doctor c14: watchdog heartbeat の鮮度検査 (ADR-0023, D9 §2.7, D3 §4)。
// 既存 doctor.test.ts には触れず追加分をここに置く。
import { describe, expect, test } from 'vitest';
import { checkWatchdogHeartbeat, type WatchdogHeartbeatState } from './doctor.js';

describe('checkWatchdogHeartbeat (c14)', () => {
  test('absent heartbeat warns and names the command that fixes it', () => {
    // ここが「ハング検知が一度も動いていない」ことを製品として知らせる唯一の場所。
    const r = checkWatchdogHeartbeat({ present: false });
    expect(r.id).toBe(14);
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('halo watchdog install');
  });

  test('a heartbeat inside the interval is OK', () => {
    const state: WatchdogHeartbeatState = { present: true, ageSec: 120, intervalSec: 300 };
    expect(checkWatchdogHeartbeat(state).status).toBe('OK');
  });

  test('one missed cycle is still OK (the allowance is 2x the interval)', () => {
    // 1 周期の取りこぼしを異常と呼ぶと、5 分間隔では警告が常態化して読まれなくなる。
    expect(checkWatchdogHeartbeat({ present: true, ageSec: 599, intervalSec: 300 }).status).toBe(
      'OK',
    );
    expect(checkWatchdogHeartbeat({ present: true, ageSec: 600, intervalSec: 300 }).status).toBe(
      'OK',
    );
  });

  test('past twice the interval warns that the schedule is not firing', () => {
    const r = checkWatchdogHeartbeat({ present: true, ageSec: 601, intervalSec: 300 });
    expect(r.status).toBe('WARN');
    expect(r.detail).toContain('発火していない');
  });

  test('never FAIL — a suspended WSL2 VM produces the same symptom benignly', () => {
    // FAIL にすると doctor が exit 1 になり、無害な原因で運用が止まる (D7 §5.2)。
    const states: WatchdogHeartbeatState[] = [
      { present: false },
      { present: true, ageSec: 0, intervalSec: 300 },
      { present: true, ageSec: 86_400, intervalSec: 300 },
    ];
    for (const s of states) expect(checkWatchdogHeartbeat(s).status).not.toBe('FAIL');
  });
});
