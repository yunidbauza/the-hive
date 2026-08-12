import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { aliases } from './vite.aliases.mjs';

/**
 * Vitest configuration.
 *
 * The alias list used to be duplicated here rather than imported, so that a
 * broken app config could not take the test suite down with it. Story 080 made
 * that trade a losing one: Electron adds a third bundler config, and four
 * hand-synced copies of one map is a worse failure mode than the one this
 * duplication was guarding against.
 *
 * `vite.aliases.mjs` is the compromise — a dependency-free data module, not the
 * app config. It is the only thing imported here, so a broken `vite.config.ts`
 * still cannot reach the test suite.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: aliases },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    // Playwright owns tests/e2e (story 070).
    exclude: ['node_modules/**', 'dist/**', 'tests/e2e/**'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // Entry point — no logic to cover.
        'src/main.tsx',
        // Data, not logic (story 012).
        'src/data/**',
        // shadcn primitives are vendored verbatim.
        'src/components/ui/dialog.tsx',
        'src/components/ui/dropdown-menu.tsx',
        'src/components/ui/tooltip.tsx',
        // Type-only files contribute no executable statements.
        'src/types/**',
        'src/**/*.d.ts',
      ],
      /**
       * 80% across all four metrics — the incorpx number, applied globally.
       * `pnpm test:coverage` exits non-zero below any of them; this is what CI
       * runs (story 071).
       */
      thresholds: {
        lines: 80,
        statements: 80,
        branches: 80,
        functions: 80,
      },
    },
  },
});
