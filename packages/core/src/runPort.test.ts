// runPort contract tests (D2 §3, D1 §3): real process boundary via bash fixtures.
// No network, no claude — fixtures echo canned JSON so the API is never billed (D8 §2).
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyExit, parseJsonStdout, runPort, RunPortError } from './runPort.js';

const dir = mkdtempSync(join(tmpdir(), 'halo-runport-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fixture(name: string, script: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe('runPort', () => {
  it('writes stdin JSON, captures stdout JSON, exit 0 (D1 §3.2)', async () => {
    const p = fixture('echo.sh', 'input=$(cat); echo "{\\"got\\":$input}"');
    const r = await runPort({ execPath: p, stdin: { a: 1 }, timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    const parsed = parseJsonStdout<{ got: { a: number } }>(r.stdout);
    expect(parsed).toEqual({ ok: true, value: { got: { a: 1 } } });
  });

  it('propagates exit 2 as fail without throwing (D1 §3.1)', async () => {
    const p = fixture('fail.sh', 'echo \'{"verdict":"fail"}\'; exit 2');
    const r = await runPort({ execPath: p, stdin: {}, timeoutMs: 5000 });
    expect(r.exitCode).toBe(2);
    expect(classifyExit(r)).toBe('fail');
  });

  it('classifies other exit codes as error (D1 §3.1)', async () => {
    const p = fixture('err.sh', 'exit 1');
    const r = await runPort({ execPath: p, stdin: {}, timeoutMs: 5000 });
    expect(classifyExit(r)).toBe('error');
  });

  it('enforces timeoutMs with SIGTERM and reports timedOut (D2 §3.3)', async () => {
    const p = fixture('hang.sh', 'sleep 30');
    const r = await runPort({ execPath: p, stdin: {}, timeoutMs: 300, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(classifyExit(r)).toBe('error');
  }, 10_000);

  it('forwards stderr lines to onStderr, keeps stdout channel clean (D2 §3.4)', async () => {
    const p = fixture('diag.sh', 'echo "diag one" >&2; echo "diag two" >&2; echo "{}"');
    const lines: string[] = [];
    const r = await runPort({ execPath: p, stdin: {}, timeoutMs: 5000, onStderr: (l) => lines.push(l) });
    expect(lines).toEqual(['diag one', 'diag two']);
    expect(parseJsonStdout(r.stdout).ok).toBe(true);
  });

  it('rejects with RunPortError when the executable does not exist', async () => {
    await expect(
      runPort({ execPath: join(dir, 'nope.sh'), stdin: {}, timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(RunPortError);
  });

  it('survives a child that never reads stdin (EPIPE safe)', async () => {
    const p = fixture('noread.sh', 'exec 0<&-; echo "{}"');
    const r = await runPort({ execPath: p, stdin: { big: 'x'.repeat(1024) }, timeoutMs: 5000 });
    expect(r.exitCode).toBe(0);
  });
});

describe('parseJsonStdout', () => {
  it('rejects empty stdout', () => {
    expect(parseJsonStdout('').ok).toBe(false);
  });
  it('rejects non-JSON garbage with a clear error', () => {
    const r = parseJsonStdout('installing deps...\n{}');
    expect(r.ok).toBe(false);
  });
  it('rejects JSON that is not an object (array/scalar)', () => {
    expect(parseJsonStdout('[1,2]').ok).toBe(false);
    expect(parseJsonStdout('42').ok).toBe(false);
  });
});
