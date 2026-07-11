import { expect, test } from 'vitest';
import { HALO_CORE_VERSION } from './index.js';

test('core package exposes a version placeholder', () => {
  expect(HALO_CORE_VERSION).toBe('0.0.0');
});
