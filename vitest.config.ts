import { defineConfig } from 'vitest/config';

// Workspace-wide vitest config. Tests live beside sources in packages/*/src.
// Coverage targets per module are enforced in M3+ (D8 §1.2); scaffold ships
// the runner wired but leaves thresholds unset.
export default defineConfig({
  test: {
    // Glob is written so it resolves whether vitest runs from the repo root
    // (`pnpm test`) or from a package dir (`pnpm -r test`).
    include: ['**/src/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['**/src/**/*.ts'],
      exclude: ['**/src/**/*.test.ts', '**/src/index.ts'],
    },
  },
});
