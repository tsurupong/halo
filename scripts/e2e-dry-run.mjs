#!/usr/bin/env node
// E2E dry-run smoke skeleton (T39, D8 §4). Offline, zero-billing wiring check:
// drives the *real* `halo run` CLI (MAX_ITER=1) against a throwaway git fixture
// repo whose executor/task-source/gate are tiny Node mocks (entry contract,
// ADR-0018) — no network, no `claude`, no real GitHub. Proves the process
// boundary + worktree lifecycle + loop + iteration log all connect. The paid
// real-GitHub smoke is manual — see test/e2e/smoke.md (D8 §4.3).
//
// Usage:  node scripts/e2e-dry-run.mjs
// Exit:   0 = one dry-run iteration completed and iter_1.json was written.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = process.env.HALO_CLI ?? join(ROOT, 'packages/cli/dist/index.js');

function log(msg) {
  process.stdout.write(`[e2e] ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`[e2e] FAIL: ${msg}\n`);
  process.exit(1);
}

function commandExists(cmd) {
  const res =
    process.platform === 'win32'
      ? spawnSync('where', [cmd])
      : spawnSync('sh', ['-c', `command -v ${cmd}`]);
  return res.status === 0;
}

if (!commandExists('git')) fail('git is required');

// Ensure the CLI is built (build is cheap and offline once deps are installed).
if (!existsSync(CLI)) {
  log(`CLI not built at ${CLI} — building…`);
  if (commandExists('pnpm')) {
    execFileSync('pnpm', ['-r', 'build'], { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
  } else {
    fail(`pnpm not found and ${CLI} missing`);
  }
}

const REPO = mkdtempSync(join(tmpdir(), 'halo-e2e-'));
const WORKTREE = join(tmpdir(), 'halo-wt-issue-1');

function cleanup() {
  spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', WORKTREE], { stdio: 'ignore' });
  rmSync(REPO, { recursive: true, force: true });
}
process.on('exit', cleanup);

log(`fixture repo: ${REPO}`);
execFileSync('git', ['-C', REPO, 'init', '-q']);
execFileSync('git', ['-C', REPO, 'config', 'user.email', 'e2e@halo.local']);
execFileSync('git', ['-C', REPO, 'config', 'user.name', 'e2e']);
execFileSync('git', ['-C', REPO, 'config', 'commit.gpgsign', 'false']);

const STATE = join(REPO, '.halo/state');
mkdirSync(STATE, { recursive: true });
mkdirSync(join(REPO, '.halo/profiles'), { recursive: true });

// --- profile: 1 iteration, L1, short timeout ---
writeFileSync(
  join(REPO, '.halo/profiles/e2e.env'),
  ['AUTONOMY=L1', 'MAX_ITER=1', 'TIMEOUT=5m', ''].join('\n'),
);

// --- mock plugins under .halo/ports/*.d (target-repo resolution, D2 §6, entry
// contract ADR-0018): each mock is a self-contained Node ESM entry module that
// reads one JSON object from stdin and writes one JSON object to stdout. ---
function mkplugin(port, dir, entryBody, env) {
  const d = join(REPO, '.halo/ports', `${port}.d`, dir);
  mkdirSync(d, { recursive: true });
  const manifest = {
    name: `@fx/${dir}`,
    version: '1.0.0',
    port,
    entry: './index.mjs',
    ...(env ? { env } : {}),
  };
  writeFileSync(join(d, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(d, 'index.mjs'), entryBody);
  chmodSync(join(d, 'index.mjs'), 0o755);
}

mkplugin(
  'task-source',
  'ts',
  `#!/usr/bin/env node
// Mock task-source: serves task "1" once, then reports queue-empty (D8 §4 dry-run).
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const op = input.op ?? 'next';
const servedMarker = join(process.env.STATE_DIR, 'served');

if (op === 'next') {
  if (existsSync(servedMarker)) {
    process.stdout.write(JSON.stringify({ task_id: null }));
  } else {
    writeFileSync(servedMarker, '');
    process.stdout.write(JSON.stringify({ task_id: '1', title: 'e2e', body: 'dry-run one iteration' }));
  }
} else {
  process.stdout.write(JSON.stringify({}));
}
`,
  { STATE_DIR: STATE },
);

mkplugin(
  'executor',
  'ex',
  `#!/usr/bin/env node
// Mock executor: no claude, no billing. Echoes a done result (D8 §4 dry-run).
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify({ status: 'done', summary: 'mock executor: no-op dry run' }));
`,
);

mkplugin(
  'gate',
  '10-pass',
  `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
`,
);

execFileSync('git', ['-C', REPO, 'add', '-A']);
execFileSync('git', ['-C', REPO, 'commit', '-q', '-m', 'e2e fixtures']);

// --- run one dry-run iteration ---
log(`halo run e2e --dry-run --cwd ${REPO}`);
const run = spawnSync(process.execPath, [CLI, 'run', 'e2e', '--dry-run', '--cwd', REPO, '--quiet'], {
  stdio: 'inherit',
});
if (run.status !== 0) fail(`halo run exited ${run.status} (expected 0)`);

// --- assert the iteration log was produced (D8 §4.2 #7) ---
const LOG = join(REPO, '.halo/logs/iter_1.json');
if (!existsSync(LOG)) fail(`expected ${LOG} to be written`);
const outcome = JSON.parse(readFileSync(LOG, 'utf8')).outcome;
if (outcome !== 'passed') fail(`iter_1 outcome=${outcome} (expected passed)`);

log(`OK — dry-run completed one iteration, iter_1.json outcome=${outcome}`);
log('PASS');
