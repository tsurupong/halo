// Mock executor plugin (D8 §2.2): echoes a fixed status JSON, never calls claude.
// EXEC_STATUS (done|stuck|timeout) selects the branch. Zero billing.
// EXEC_HANG_MS delays the reply, so a test can abort (ADR-0022) or time out mid-run
// and prove the child is actually torn down rather than awaited.
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const reply = () => {
    process.stdout.write(
      `{"status":"${process.env.EXEC_STATUS ?? 'done'}","summary":"mock run"}\n`,
    );
    process.exit(0);
  };
  const hangMs = Number(process.env.EXEC_HANG_MS ?? 0);
  // globalThis 経由: .mjs モックの lint グローバルは process/console/Buffer のみで、
  // タイマーを足すために共有の eslint 設定を広げたくない。
  if (hangMs > 0) globalThis.setTimeout(reply, hangMs);
  else reply();
});
