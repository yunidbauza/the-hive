import { fileURLToPath, URL } from 'node:url';

/**
 * The ONE place a bundler alias is declared (story 080).
 *
 * Before Electron there were three copies of this map — `vite.config.ts`,
 * `vitest.config.ts` and `tsconfig.json`. Adding `electron.vite.config.ts`
 * would have made four hand-synced copies, which is a defect waiting for a
 * quiet afternoon. Every JS-loaded config now imports this module instead.
 *
 * `tsconfig.json` still declares its own `paths`: TypeScript cannot import a
 * JS module to build its config. So the count is two, not one, and
 * `pnpm verify:boundaries` asserts the two agree rather than trusting them to.
 *
 * Aliases are matched in insertion order and only against `<key>/…`, so the
 * bare `@` entry is listed last and cannot swallow scoped package names such
 * as `@phosphor-icons/react`.
 */
const srcPath = (segment = '') =>
  fileURLToPath(new URL(`./src/${segment}`, import.meta.url));

export const aliases = {
  '@components': srcPath('components'),
  '@features': srcPath('features'),
  '@stores': srcPath('stores'),
  '@config': srcPath('config'),
  '@hooks': srcPath('hooks'),
  '@utils': srcPath('utils'),
  '@types': srcPath('types'),
  '@lib': srcPath('lib'),
  /**
   * The IPC contract — the one module both processes may import. It is how the
   * renderer reaches the contract's *types* without reaching into the main
   * process, which the ESLint zones forbid outright.
   */
  '@shared': fileURLToPath(new URL('./electron/shared', import.meta.url)),
  '@': srcPath(),
};
