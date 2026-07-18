// Mock on-fail plugin (D8 §2.2): records each failure input so the test can assert
// the failure path fired and inspect the re-injected retry_count. No output.
import { appendFileSync } from 'node:fs';
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
  appendFileSync(join(state, 'onfail'), `${input}\n`);
  process.exit(0);
});
