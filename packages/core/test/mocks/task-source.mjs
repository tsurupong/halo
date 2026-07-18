// Mock task-source plugin (D8 §2.2): returns a fixed JSON task, never calls the
// network. On `op=next` it hands out task_id "1" for the first TS_REPEAT calls
// (default 1) then `{"task_id":null}` to end the loop. `op=complete` records a
// marker so the test can assert Complete fired. Zero billing.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let input = '';
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const state = process.env.STATE_DIR;
  if (!state) {
    process.stderr.write('STATE_DIR required\n');
    process.exit(1);
  }
  if (input.includes('"op":"next"')) {
    const f = join(state, 'ts_next');
    let n = 0;
    try {
      n = Number(readFileSync(f, 'utf8'));
    } catch {
      n = 0;
    }
    writeFileSync(f, String(n + 1));
    const repeat = Number(process.env.TS_REPEAT ?? '1');
    if (n < repeat) {
      process.stdout.write('{"task_id":"1","title":"do the thing","body":"requirement text"}\n');
    } else {
      process.stdout.write('{"task_id":null}\n');
    }
  } else if (input.includes('"op":"complete"')) {
    appendFileSync(join(state, 'ts_complete'), `${input}\n`);
  } else {
    appendFileSync(join(state, 'ts_other'), `${input}\n`);
  }
  process.exit(0);
});
