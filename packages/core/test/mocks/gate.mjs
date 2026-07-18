// Mock gate plugin (D8 §2.2): follows the D1 §3.1 exit-code contract (0=pass,
// 2=fail with a gate.out JSON). GATE_MODE selects behavior:
//   pass           always exit 0
//   fail           always exit 2 with a reason
//   fail_then_pass exit 2 on the first call, exit 0 afterwards (retry recovery)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const state = process.env.STATE_DIR;
  if (!state) {
    process.stderr.write('STATE_DIR required\n');
    process.exit(1);
  }
  const mode = process.env.GATE_MODE ?? 'pass';
  if (mode === 'pass') {
    process.exit(0);
  } else if (mode === 'fail') {
    process.stdout.write('{"reason":"coverage 87% < 90%","hint":"add tests","gate":"30-test"}\n');
    process.exit(2);
  } else if (mode === 'fail_then_pass') {
    const f = join(state, 'gate');
    let n = 0;
    try {
      n = Number(readFileSync(f, 'utf8'));
    } catch {
      n = 0;
    }
    writeFileSync(f, String(n + 1));
    if (n < 1) {
      process.stdout.write('{"reason":"coverage 87% < 90%","hint":"add tests","gate":"30-test"}\n');
      process.exit(2);
    }
    process.exit(0);
  }
});
