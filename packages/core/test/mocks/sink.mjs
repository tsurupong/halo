// Mock sink plugin (D8 §2.2): side effect only — appends a marker so the test can
// assert it ran after the autonomy filter. No output.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const state = process.env.STATE_DIR;
  if (!state) {
    process.stderr.write('STATE_DIR required\n');
    process.exit(1);
  }
  const pluginName = process.env.PLUGIN_NAME ?? 'sink';
  appendFileSync(join(state, `sink_${pluginName}`), 'ran\n');
  process.exit(0);
});
