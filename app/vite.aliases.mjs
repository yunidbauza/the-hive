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
  /**
   * Shared test scaffolding — `tests/support/`, and nothing the app ships.
   *
   * It exists because the suite now has to build its own preconditions. The
   * store used to boot pre-populated with a sample fleet, so panel tests got
   * their entities for free from a module they never imported; the app boots
   * empty now, and those tests seed themselves from `@tests/support/demo-fleet`.
   *
   * An alias rather than `../../../support/…` because the depth of that climb
   * depends on where in the mirrored tree the test happens to sit, and a path
   * that changes when a file moves is a path that will be wrong.
   *
   * Nothing under `src/` or `electron/` may import through it — those are
   * production bundles, and this resolves to test code. Listed before the bare
   * `@` entry for the same reason `@shared` is: insertion order decides.
   */
  '@tests': fileURLToPath(new URL('./tests', import.meta.url)),
  '@': srcPath(),
};
