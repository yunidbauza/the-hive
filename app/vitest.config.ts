import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const srcPath = (segment = '') =>
  fileURLToPath(new URL(`./src/${segment}`, import.meta.url));

/**
 * Vitest configuration.
 *
 * The alias list is duplicated from vite.config.ts rather than imported: this
 * config is loaded by Vitest, not by the app build, and keeping it standalone
 * means a broken app config cannot take the test suite down with it. If you add
 * an alias, add it in all three places (tsconfig.json, vite.config.ts, here).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@components': srcPath('components'),
      '@features': srcPath('features'),
      '@stores': srcPath('stores'),
      '@config': srcPath('config'),
      '@hooks': srcPath('hooks'),
      '@utils': srcPath('utils'),
      '@types': srcPath('types'),
      '@lib': srcPath('lib'),
      '@': srcPath(),
    },
  },
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
