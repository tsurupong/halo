import { expect, test, describe, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createIo } from '../io.js';
import { triggerCommand } from './trigger.js';
import { EXIT, CliError } from '../exit-codes.js';
import { memFs, captureStreams } from '../testkit.js';
import type { SpawnResult } from '../core-ext/triggers.js';

function io(cap: ReturnType<typeof captureStreams>, json = false) {
  return createIo(cap.streams, { cwd: '/repo', json, quiet: false, verbose: false });
}
function okSpawn(result: Partial<SpawnResult> = {}) {
  return vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', ...result }));
}
function fsWithAdapter() {
  return memFs({
    dirs: ['/repo/.halo/ports/trigger.d/schedule'],
    files: { '/repo/.halo/ports/trigger.d/schedule/fire': '#!/bin/bash' },
  });
}

describe('trigger install/uninstall/list (T27)', () => {
  test('install spawns install.sh with the profile and HALO_BIN absolute path', async () => {
    const fs = fsWithAdapter();
    const spawn = okSpawn();
    const cap = captureStreams();
    const code = await triggerCommand(parseArgs(['install', 'schedule', 'nightly'], {}), io(cap), {
      fs,
      spawn,
    });
    expect(code).toBe(EXIT.OK);
    expect(spawn).toHaveBeenCalledWith(
      '/repo/.halo/ports/trigger.d/schedule/install.sh',
      ['nightly'],
      expect.objectContaining({ HALO_BIN: '/repo/node_modules/.bin/halo' }),
    );
  });

  test('install with a non-zero adapter exit maps to runtime error (exit 1)', async () => {
    const fs = fsWithAdapter();
    const spawn = okSpawn({ exitCode: 1, stderr: 'schtasks failed' });
    const cap = captureStreams();
    await expect(
      triggerCommand(parseArgs(['install', 'schedule', 'nightly'], {}), io(cap), { fs, spawn }),
    ).rejects.toMatchObject({
      exitCode: EXIT.RUNTIME,
    });
  });

  test('unknown adapter name is a usage error (exit 3)', async () => {
    const fs = memFs({ dirs: ['/repo/.halo/ports/trigger.d'] });
    const cap = captureStreams();
    await expect(
      triggerCommand(parseArgs(['install', 'ghost', 'nightly'], {}), io(cap), {
        fs,
        spawn: okSpawn(),
      }),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });

  test('invalid profile name is rejected before spawn', async () => {
    const fs = fsWithAdapter();
    const spawn = okSpawn();
    const cap = captureStreams();
    await expect(
      triggerCommand(parseArgs(['install', 'schedule', 'bad;rm'], {}), io(cap), { fs, spawn }),
    ).rejects.toBeInstanceOf(CliError);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('uninstall is idempotent — adapter exit 0 yields exit 0 even with no profile', async () => {
    const fs = fsWithAdapter();
    const spawn = okSpawn();
    const cap = captureStreams();
    const code = await triggerCommand(parseArgs(['uninstall', 'schedule'], {}), io(cap), {
      fs,
      spawn,
    });
    expect(code).toBe(EXIT.OK);
    expect(spawn).toHaveBeenCalledWith(
      '/repo/.halo/ports/trigger.d/schedule/uninstall.sh',
      [],
      expect.anything(),
    );
  });

  test('list --json reports adapters with liveness', async () => {
    const fs = fsWithAdapter();
    const cap = captureStreams();
    const code = await triggerCommand(parseArgs(['list'], {}), io(cap, true), {
      fs,
      spawn: okSpawn(),
    });
    expect(code).toBe(EXIT.OK);
    const out = JSON.parse(cap.out());
    expect(out.triggers[0]).toMatchObject({ name: 'schedule', alive: true });
  });

  test('unknown subcommand is a usage error', async () => {
    const fs = fsWithAdapter();
    const cap = captureStreams();
    await expect(
      triggerCommand(parseArgs(['frob'], {}), io(cap), { fs, spawn: okSpawn() }),
    ).rejects.toMatchObject({
      exitCode: EXIT.USAGE,
    });
  });
});
