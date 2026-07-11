#!/usr/bin/env node
// halo CLI — thin delegation layer over @halo/core (D3 §0).
// Real commands land in M4 (T22+). Scaffold only.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HALO_CORE_VERSION } from '@halo/core';

export function main(): void {
  process.stdout.write(`halo ${HALO_CORE_VERSION}\n`);
}

// Invoked as the `halo` bin (D3 §0); the shim resolves through symlinks, so
// compare real paths. Argument parsing lands in M4 (T22).
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main();
}
