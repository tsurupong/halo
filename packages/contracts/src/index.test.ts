import { expect, test } from 'vitest';
import { HALO_CONTRACTS_VERSION } from './index.js';

test('contracts package exposes a version placeholder', () => {
  expect(HALO_CONTRACTS_VERSION).toBe('0.0.0');
});
