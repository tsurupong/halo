// Mock executor plugin (D8 §2.2): echoes a fixed status JSON, never calls claude.
// EXEC_STATUS (done|stuck|timeout) selects the branch. Zero billing.
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write(`{"status":"${process.env.EXEC_STATUS ?? 'done'}","summary":"mock run"}\n`);
  process.exit(0);
});
