import { describe, it, expect, vi } from 'vitest';
import {
  redactSecrets,
  computeGatePassRate,
  formatIterationLog,
  buildLogPath,
  createLogger,
  LOGGER_DEFAULTS,
  type IterationInput,
  type GateResult,
} from './logger.js';

describe('redactSecrets', () => {
  it('masks a GitHub PAT while leaving surrounding text intact', () => {
    const input = 'clone failed using ghp_abcdefghijklmnopqrstuvwxyz0123 end';
    const out = redactSecrets(input);
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(out).toContain('clone failed using');
    expect(out).toContain(LOGGER_DEFAULTS.redactionMask);
  });

  it('masks token= / GH_TOKEN= assignments', () => {
    const gh = redactSecrets('GH_TOKEN=supersecretvalue');
    expect(gh).not.toContain('supersecretvalue');
    expect(gh).toContain('***REDACTED***');
    expect(redactSecrets('authorization: Bearer abc.def.ghi')).toBe('***REDACTED***');
  });

  it('honours injected patterns and mask (no hardcoded initial values)', () => {
    const out = redactSecrets('code=1234', { secretPatterns: [/code=\d+/g], redactionMask: '#' });
    expect(out).toBe('#');
  });

  it('returns input unchanged when nothing matches', () => {
    expect(redactSecrets('a perfectly ordinary log line')).toBe('a perfectly ordinary log line');
  });
});

describe('computeGatePassRate', () => {
  it('is pass / (pass + fail), excluding skipped', () => {
    const gates: GateResult[] = [
      { name: '10-typecheck', result: 'pass' },
      { name: '20-lint', result: 'pass' },
      { name: '30-test', result: 'fail' },
      { name: '40-ai-review', result: 'skipped' },
    ];
    expect(computeGatePassRate(gates)).toBeCloseTo(2 / 3);
  });

  it('returns null when no gate ran (no false 0.0)', () => {
    expect(computeGatePassRate([])).toBeNull();
    expect(computeGatePassRate([{ name: 'x', result: 'skipped' }])).toBeNull();
  });

  it('returns 1 when every counted gate passed', () => {
    expect(computeGatePassRate([{ name: 'x', result: 'pass' }])).toBe(1);
  });
});

describe('formatIterationLog', () => {
  const base: IterationInput = {
    iter: 3,
    startedAt: '2026-07-11T00:00:00Z',
    endedAt: '2026-07-11T00:05:00Z',
    profile: 'nightly',
    autonomy: 'L1',
    outcome: 'passed',
  };

  it('defaults missing task fields (task_id null, kind=code)', () => {
    const log = formatIterationLog(base);
    expect(log.task.task_id).toBeNull();
    expect(log.task.kind).toBe('code');
    expect(log.gates).toEqual([]);
    expect(log.gate_pass_rate).toBeNull();
  });

  it('uses an injected default kind', () => {
    const log = formatIterationLog(base, { defaultKind: 'docs' });
    expect(log.task.kind).toBe('docs');
  });

  it('maps camelCase input to snake_case schema fields', () => {
    const log = formatIterationLog({
      ...base,
      trigger: 'polling',
      task: { taskId: '42', kind: 'code', retryCount: 2, runtimes: ['node-pnpm'] },
      executor: { status: 'done', turnsUsed: 12, cost: { inputTokens: 100, usdEstimate: null } },
      gates: [{ name: '30-test', result: 'pass', durationSec: 1.5 }],
    });
    expect(log.task.retry_count).toBe(2);
    expect(log.executor?.turns_used).toBe(12);
    expect(log.executor?.cost?.input_tokens).toBe(100);
    expect(log.executor?.cost?.usd_estimate).toBeNull();
    expect(log.gates[0]).toMatchObject({ name: '30-test', result: 'pass', duration_sec: 1.5 });
    expect(log.gate_pass_rate).toBe(1);
  });

  it('redacts secrets from gate reason before persisting', () => {
    const log = formatIterationLog({
      ...base,
      gates: [{ name: '30-test', result: 'fail', reason: 'auth failed token=deadbeefdeadbeef' }],
    });
    expect(JSON.stringify(log)).not.toContain('deadbeefdeadbeef');
    expect(log.gates[0]?.reason).toContain('***REDACTED***');
  });
});

describe('buildLogPath', () => {
  it('builds flat iter_N.json paths and tolerates trailing slash', () => {
    expect(buildLogPath('.halo/logs', 7)).toBe('.halo/logs/iter_7.json');
    expect(buildLogPath('.halo/logs/', 7)).toBe('.halo/logs/iter_7.json');
  });
});

describe('createLogger', () => {
  it('writes formatted JSON to iter_N.json under logDir, no global state', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const logger = createLogger({ logDir: '/tmp/.halo/logs', fs: { mkdir, writeFile } });

    const { path, log } = await logger.writeIteration({
      iter: 1,
      startedAt: 'a',
      endedAt: 'b',
      profile: 'continuous',
      autonomy: 'L3',
      outcome: 'no_task',
    });

    expect(path).toBe('/tmp/.halo/logs/iter_1.json');
    expect(mkdir).toHaveBeenCalledWith('/tmp/.halo/logs', { recursive: true });
    const written = writeFile.mock.calls[0]![1] as string;
    expect(JSON.parse(written).iter).toBe(1);
    expect(written.endsWith('\n')).toBe(true);
    expect(log.outcome).toBe('no_task');
  });
});
