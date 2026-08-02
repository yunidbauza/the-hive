import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Path aliases are declared twice on purpose: TypeScript reads `tsconfig.json`
 * for type resolution, Vite reads this list for bundling. Neither reads the
 * other's, so the two must be kept in sync (story 010).
 *
 * Aliases are matched in insertion order and only against `<key>/…`, so the
 * bare `@` entry is listed last and cannot swallow scoped package names such as
 * `@phosphor-icons/react`.
 */
const srcPath = (segment = '') =>
  fileURLToPath(new URL(`./src/${segment}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
});
