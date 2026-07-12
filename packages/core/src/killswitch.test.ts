import { expect, test, describe } from 'vitest';
import { setStop, clearStop, formatStopFile, stopPath } from './killswitch.js';
import { memFs } from './testkit.js';

describe('killswitch (T25)', () => {
  test('stopPath appends STOP to the halo dir', () => {
    expect(stopPath('/repo/.halo')).toBe('/repo/.halo/STOP');
    expect(stopPath('/repo/.halo/')).toBe('/repo/.halo/STOP');
  });

  test('formatStopFile records reason and ISO timestamp', () => {
    const body = formatStopFile('maintenance', Date.parse('2026-07-11T00:00:00Z'));
    expect(body).toContain('reason: maintenance');
    expect(body).toContain('2026-07-11T00:00:00.000Z');
  });

  test('formatStopFile omits reason line when absent', () => {
    expect(formatStopFile(undefined, 0)).not.toContain('reason:');
  });

  test('setStop reports existed=false first, true on repeat', async () => {
    const fs = memFs();
    const first = await setStop({ haloDir: '/repo/.halo', fs, now: 0 });
    expect(first.existed).toBe(false);
    const second = await setStop({ haloDir: '/repo/.halo', fs, reason: 'x', now: 1 });
    expect(second.existed).toBe(true);
  });

  test('clearStop is idempotent', async () => {
    const fs = memFs({ files: { '/repo/.halo/STOP': 'x' } });
    expect((await clearStop('/repo/.halo', fs)).existed).toBe(true);
    expect((await clearStop('/repo/.halo', fs)).existed).toBe(false);
  });
});
