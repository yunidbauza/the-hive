import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import checkFile from 'eslint-plugin-check-file';
import importPlugin from 'eslint-plugin-import';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Absolute path to this package, so zone globs do not depend on the cwd. */
const appRoot = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');

/**
 * Feature slices. One per domain surface; `shared` is the only slice other
 * slices may import from.
 *
 * Adding a slice means adding it here — otherwise it gets no isolation zone and
 * silently becomes importable from everywhere.
 */
const FEATURE_SLICES = [
  'agents',
  'editor',
  'explorer',
  'inbox',
  'orchestrator',
  'projects',
  'pull-requests',
  'sessions',
  'settings',
  'simulation',
  'work',
];

/**
 * Feature isolation, expressed as one zone per slice.
 *
 * The obvious formulation — a single zone with `target: './src/features/**' +
 * '/*'` and the same value for `from` — also forbids a slice from importing
 * *itself*, because `import/no-restricted-paths` compares the importing file
 * against `target` and the imported file against `from` without any notion of
 * "same directory". incorpx works around that by switching the rule off
 * entirely inside `src/features/**`, which has the side effect of disabling
 * cross-slice enforcement too: the fence is declared but never fires.
 *
 * Generating a zone per slice avoids the workaround. Each slice may import
 * itself and `shared`, and nothing else under `features/`.
 *
 * `except` globs must be ABSOLUTE. When `from` is a glob, the rule matches each
 * `except` pattern straight against the resolved absolute path of the imported
 * module without first resolving it against `basePath` (unlike `target` and
 * `from`, which are resolved). A relative `except` therefore silently never
 * matches, and the exemption quietly does nothing.
 */
const featureIsolationZones = FEATURE_SLICES.map((slice) => ({
  target: `./src/features/${slice}/**/*`,
  from: './src/features/**/*',
  except: [
    `${appRoot}/src/features/${slice}/**/*`,
    `${appRoot}/src/features/shared/**/*`,
  ],
  message: `features/${slice} may not import another feature slice. Slices talk through the store, or through features/shared.`,
}));

/**
 * Component directories that stay domain-agnostic.
 *
 * `components/layout/` is deliberately absent: it is THE COMPOSITION ROOT. The
 * rails and the center stage exist to mount feature panels, so a blanket
 * `components/ → features/` ban would make story 030's own file layout illegal.
 * Every alternative is worse — a `features/` slice importing three sibling
 * slices defeats the per-slice isolation zone, and threading slot props from
 * `app.tsx` moves the whole app's wiring into one untestable module.
 *
 * The exemption cannot be expressed as an `except` on a single wide zone:
 * `except` filters the *imported* module, never the importing file. Listing the
 * fenced directories is the only formulation that says what it means — with the
 * cost that a NEW directory under `src/components/` gets no fence until it is
 * added here.
 *
 * `scripts/verify-boundaries.mjs` proves both halves: `ui/` still blocked,
 * `layout/` allowed.
 */
const FENCED_COMPONENT_DIRS = ['editor', 'terminal', 'ui'];

const fencedComponentDirs = FENCED_COMPONENT_DIRS.map(
  (dir) => `./src/components/${dir}/**/*`,
);

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      // electron-vite's build output (story 080). Flat config does not read
      // .gitignore, so a built bundle is lintable unless it is named here.
      'out/**',
      '.tmp/**',
      'coverage/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      // Lint scope excludes tests/, matching incorpx. Type-checking still
      // covers them — tsconfig.json includes `tests`.
      'tests/**',
      /**
       * Vendored third-party bundles (HIVE-71).
       *
       * `marked` is copied verbatim so the ADF pipeline needs no runtime
       * dependency — the same property the epic was protecting when it rejected
       * the bash client. Linting somebody else's minified-ish bundle reports
       * their style choices as our errors, and reformatting it would destroy
       * the one thing that makes a vendored copy auditable: that it is
       * byte-identical to upstream.
       */
      'electron/main/integrations/jira/adf/vendor/**',
      /**
       * Git worktrees live under the repo now that the app sits at the root.
       * Each one is a whole second checkout — linting them re-lints the app
       * once per branch and walks their `node_modules`, which is what turned
       * `pnpm lint` into a hang.
       */
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'check-file': checkFile,
      'jsx-a11y': jsxA11y,
      import: importPlugin,
    },
    settings: {
      /**
       * Without an explicit parser mapping, eslint-plugin-import cannot parse
       * `.ts`/`.tsx` sources, so its export map comes back empty and graph
       * rules such as `import/no-cycle` silently never fire.
       */
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx', '.mts', '.cts'],
      },
      'import/extensions': ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
        node: true,
      },
    },
    rules: {
      ...jsxA11y.configs.recommended.rules,

      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      /**
       * Architecture boundaries. The zone list is reproduced in AGENTS.md
       * (story 015) so the rules are discoverable without reading this file.
       */
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            ...featureIsolationZones,

            // Chrome and atoms stay domain-agnostic — everywhere but the
            // composition root. See FENCED_COMPONENT_DIRS above.
            {
              target: fencedComponentDirs,
              from: './src/features/**/*',
              message:
                'Only components/layout/ (the composition root) may import features/. Atoms and the terminal stay domain-agnostic.',
            },

            /**
             * THE SEAM. The terminal is infrastructure, not a feature: it
             * knows only its transport (story 042). This turns "the component
             * has zero imports from data/" from a review note into a build
             * failure.
             */
            {
              target: './src/components/terminal/**/*',
              from: ['./src/features/**/*', './src/data/**/*', './src/stores/**/*'],
              message:
                'components/terminal/ speaks only TerminalTransport. It may not import features/, data/, or stores/.',
            },

            /**
             * THE SAME SEAM, for the editor. `components/editor/` is a
             * CodeMirror instance that knows its props and nothing else — the
             * composition root reads the stores and passes values down, which
             * is what `center-stage.tsx` already does for terminal appearance.
             */
            {
              target: './src/components/editor/**/*',
              from: ['./src/features/**/*', './src/data/**/*', './src/stores/**/*'],
              message:
                'components/editor/ knows only its props. It may not import features/, data/, or stores/.',
            },

            /**
             * THE SPLASH, which is a seam of a different kind.
             *
             * `src/splash/` is a second renderer document, opened before the
             * app and destroyed when it arrives. Its constraint is not layering
             * but *time*: anything it imports from the app is a module Rollup
             * puts in a chunk the splash then has to parse before it can paint,
             * which is the exact wait the window exists to cover. The ban is
             * wider than the component seams for that reason — it includes
             * `components/`, `lib/` and `hooks/`, none of which the splash has
             * any business reaching for.
             */
            {
              target: './src/splash/**/*',
              from: [
                './src/features/**/*',
                './src/components/**/*',
                './src/data/**/*',
                './src/stores/**/*',
                './src/hooks/**/*',
                './src/lib/**/*',
              ],
              message:
                'splash/ is a standalone document that must paint before the app loads. It may not import from the app at all.',
            },

            // Library code is leaf-level.
            {
              target: './src/lib/**/*',
              from: ['./src/features/**/*', './src/components/**/*'],
              message: 'lib/ is leaf-level and may not import features/ or components/.',
            },

            // Shared hooks stay shared.
            {
              target: './src/hooks/**/*',
              from: './src/features/**/*',
              message: 'hooks/ is shared and may not import from features/.',
            },

            // Stores are the bottom of the dependency graph.
            {
              target: './src/stores/**/*',
              from: ['./src/features/**/*', './src/components/**/*'],
              message:
                'stores/ is the bottom of the dependency graph and may not import features/ or components/.',
            },

            /**
             * Test scaffolding never ships.
             *
             * `tests/support/` holds the sample fleet the store used to seed
             * itself with. Moving it there is what made the app boot empty, and
             * this fence is what stops it moving back one convenient import at a
             * time — a panel reaching for `@tests/support/demo-fleet` would put
             * ten fake sessions on screen again, which is the whole bug.
             */
            {
              target: ['./src/**/*', './electron/**/*'],
              from: './tests/**/*',
              message:
                'tests/ is test scaffolding and never ships. Production code may not import it — that is how the seeded demo fleet got into the app in the first place.',
            },

            /**
             * Fixtures are store-only consumers (story 012). Everything that
             * renders reads through a selector hook, never the raw data.
             */
            /*
              THE `data/` FENCE IS GONE, WITH `data/` (HIVE-75).

              It existed to stop panels reading fixtures directly instead of
              going through a selector. `src/data/fixtures.ts` was the last
              fixture in the app and the inbox is fed by the main process now,
              so the directory is empty and the rule has no subject.

              Keeping a hollow module alive to satisfy a lint zone would be the
              tail wagging the dog: the fence protected an invariant, and the
              invariant left with the directory.
            */

            /**
             * THE PROCESS BOUNDARY (story 080).
             *
             * Three zones, one idea: `electron/shared/` is the only module the
             * two processes share, and it carries types and constants only.
             * Everything else stays on its own side of the bridge.
             *
             * `electron/shared/**` is importable from all three and imports
             * from none of them — it has no zone of its own because it has no
             * imports to restrict.
             */
            {
              target: './electron/main/**/*',
              from: './src/**/*',
              message:
                'The main process has no renderer, no DOM and no store. It may import electron/shared/ only.',
            },
            {
              target: './electron/preload/**/*',
              from: ['./src/**/*', './electron/main/**/*'],
              message:
                'preload is a bridge, not a participant. It may import electron/shared/ only.',
            },
            {
              target: './src/**/*',
              from: [
                './electron/main/**/*',
                './electron/preload/**/*',
                './electron/pty-host/**/*',
              ],
              message:
                'The renderer may only see @shared. Reaching into electron/main/ or electron/preload/ would bundle main-process code into the renderer.',
            },
            /**
             * THE HOST IS DUMB ON PURPOSE (story 091).
             *
             * It owns processes, not policy: it does not read config, does not
             * know what a project is, and does not decide what to run. Shell,
             * args, cwd and env all arrive fully resolved on the command.
             *
             * That is not a style preference — it is what makes the host
             * drivable in isolation by the conformance suite (story 098), and
             * what stops a process whose job is to run whatever it is told
             * from also being the thing that decides what to run.
             */
            {
              target: './electron/pty-host/**/*',
              from: [
                './src/**/*',
                './electron/main/**/*',
                './electron/preload/**/*',
              ],
              message:
                'The pty host owns processes, not policy. It may import electron/shared/ only — config, fixtures and main-process code are all off limits.',
            },
          ],
        },
      ],

      'import/no-cycle': 'error',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          pathGroups: [{ pattern: '@/**', group: 'internal', position: 'before' }],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      'check-file/filename-naming-convention': [
        'error',
        { '**/*.{ts,tsx}': 'KEBAB_CASE' },
        { ignoreMiddleExtensions: true },
      ],
      // `electron/**` earns the same naming discipline as `src/**` (story 080).
      'check-file/folder-naming-convention': [
        'error',
        { 'src/**/': 'KEBAB_CASE', 'electron/**/': 'KEBAB_CASE' },
      ],

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // shadcn primitives are vendored verbatim; they are not ours to re-style.
    files: ['src/components/ui/{dialog,tooltip,dropdown-menu}.tsx'],
    rules: {
      'import/order': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // Config and tooling run on Node, not in the browser.
    files: ['*.config.{ts,mjs}', 'scripts/**/*.mjs', '*.aliases.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    /**
     * The main process runs on Node — `globals.browser` would declare `window`
     * and `document` as legal there, which is exactly the mistake the zones
     * above and `tsconfig.electron.json`'s DOM-free `lib` exist to catch.
     *
     * `electron/preload/` is deliberately absent: it runs inside a renderer and
     * legitimately touches browser globals, so it keeps the default.
     */
    files: ['electron/main/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
);
