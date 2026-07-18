import { expect, test, describe } from 'vitest';
import {
  checkTriggerLiveness,
  checkSkeleton,
  checkHarnessValid,
  checkGh,
  checkClaude,
  checkGit,
  checkLockStop,
  checkPlacement,
  checkDisk,
  checkLegacyLauncherConfig,
  aggregate,
} from './doctor.js';

describe('doctor pure checks (T28)', () => {
  test('trigger liveness: dead adapter → FAIL', () => {
    const r = checkTriggerLiveness([{ name: 'schedule', fire: '/x', alive: false }], '/bin/halo');
    expect(r.status).toBe('FAIL');
  });
  test('trigger liveness: none registered → OK', () => {
    expect(checkTriggerLiveness([], '/bin/halo').status).toBe('OK');
  });
  test('skeleton: missing dirs → FAIL', () => {
    expect(checkSkeleton(['ports/gate.d']).status).toBe('FAIL');
    expect(checkSkeleton([]).status).toBe('OK');
  });
  test('harness: absent/invalid → FAIL, valid → OK', () => {
    expect(checkHarnessValid(false, false).status).toBe('FAIL');
    expect(checkHarnessValid(true, false, 'no kinds').status).toBe('FAIL');
    expect(checkHarnessValid(true, true).status).toBe('OK');
  });
  test('gh: unauth → FAIL, overprivileged → WARN, healthy → OK', () => {
    expect(checkGh(true, { authenticated: false, overprivileged: false }).status).toBe('FAIL');
    expect(checkGh(true, { authenticated: true, overprivileged: true }).status).toBe('WARN');
    expect(checkGh(true, { authenticated: true, overprivileged: false }).status).toBe('OK');
    expect(checkGh(false, { authenticated: true, overprivileged: false }).status).toBe('FAIL');
  });
  test('claude / git existence and identity', () => {
    expect(checkClaude(false, false).status).toBe('FAIL');
    expect(checkClaude(true, false).status).toBe('FAIL');
    expect(checkClaude(true, true).status).toBe('OK');
    expect(checkGit(true, { isRepo: true, hasUserName: false, hasUserEmail: true }).status).toBe(
      'FAIL',
    );
    expect(checkGit(true, { isRepo: true, hasUserName: true, hasUserEmail: true }).status).toBe(
      'OK',
    );
  });
  test('lock/stop, placement, disk WARN mapping', () => {
    expect(checkLockStop(false, false).status).toBe('OK');
    expect(checkLockStop(true, false).status).toBe('WARN');
    expect(checkPlacement(false).status).toBe('WARN');
    expect(checkDisk(false).status).toBe('WARN');
  });
  test('aggregate maps FAIL→exit 1, WARN-only→exit 0', () => {
    const warnOnly = aggregate([checkPlacement(false), checkDisk(true)]);
    expect(warnOnly.exitCode).toBe(0);
    expect(warnOnly.warn).toBe(1);
    const withFail = aggregate([checkClaude(false, false)]);
    expect(withFail.exitCode).toBe(1);
  });
  test('legacy launcher config: 残存なし → OK / 残存あり → WARN', () => {
    expect(checkLegacyLauncherConfig([]).status).toBe('OK');
    const warn = checkLegacyLauncherConfig(['trigger.d/trigger-polling (.sh ファイル残存)']);
    expect(warn.status).toBe('WARN');
    expect(warn.detail).toContain('trigger-polling');
  });
});
