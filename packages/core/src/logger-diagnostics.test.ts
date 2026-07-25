// iter_N.json の diagnostics 欄 (D1 §3.3)。stderr は生のまま書くと二つ困る:
// トークンが混ざりうること (D8 §1.2 機微情報の非混入) と、executor の出力でログが
// 埋まること。redact + 末尾トリムをこの層でまとめて掛ける。
import { describe, expect, test } from 'vitest';
import { formatIterationLog, formatDiagnosticText, LOGGER_DEFAULTS } from './logger.js';

function baseInput() {
  return {
    iter: 1,
    startedAt: '2026-07-25T00:00:00.000Z',
    endedAt: '2026-07-25T00:01:00.000Z',
    profile: 'nightly',
    autonomy: 'L1' as const,
    outcome: 'passed' as const,
  };
}

describe('formatDiagnosticText', () => {
  test('redacts credentials that leaked into stderr', () => {
    const text = formatDiagnosticText('failed: GH_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaa denied');
    expect(text).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(text).toContain(LOGGER_DEFAULTS.redactionMask);
  });

  test('keeps the tail when the output is longer than the cap', () => {
    const text = formatDiagnosticText(`${'x'.repeat(5000)}THE-ACTUAL-ERROR`, {
      maxDiagnosticChars: 100,
    });
    expect(text.length).toBeLessThanOrEqual(101); // 先頭の省略記号ぶん
    expect(text.endsWith('THE-ACTUAL-ERROR')).toBe(true);
    expect(text.startsWith('…')).toBe(true);
  });

  test('trims surrounding whitespace', () => {
    expect(formatDiagnosticText('\n  boom  \n')).toBe('boom');
  });
});

describe('formatIterationLog diagnostics', () => {
  test('carries port/plugin through and redacts the text', () => {
    const log = formatIterationLog({
      ...baseInput(),
      diagnostics: [
        { port: 'gate', plugin: '50-loop-audit', stderr: 'Bearer sk-abcdefghijklmnopqrstuvwx' },
      ],
    });
    expect(log.diagnostics).toHaveLength(1);
    expect(log.diagnostics![0]!.port).toBe('gate');
    expect(log.diagnostics![0]!.plugin).toBe('50-loop-audit');
    expect(log.diagnostics![0]!.stderr).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });

  test('drops entries that are only whitespace, and omits the field when none remain', () => {
    const log = formatIterationLog({
      ...baseInput(),
      diagnostics: [{ port: 'sink', plugin: 's1', stderr: '   \n ' }],
    });
    expect(log.diagnostics).toBeUndefined();
  });

  test('is absent when the loop passed none', () => {
    expect(formatIterationLog(baseInput()).diagnostics).toBeUndefined();
  });
});
