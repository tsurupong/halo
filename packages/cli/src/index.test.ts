import { expect, test, vi } from 'vitest';
import { main } from './index.js';

test('main writes a version line to stdout', () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  main();
  expect(write).toHaveBeenCalledWith('halo 0.0.0\n');
  write.mockRestore();
});
