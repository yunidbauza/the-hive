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
  'activity-feed',
  'agents',
  'inbox',
  'orchestrator',
  'projects',
  'pull-requests',
  'sessions',
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
const FENCED_COMPONENT_DIRS = ['terminal', 'ui'];

const fencedComponentDirs = FENCED_COMPONENT_DIRS.map(
  (dir) => `./src/components/${dir}/**/*`,
);

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      // Lint scope excludes tests/, matching incorpx. Type-checking still
      // covers them — tsconfig.json includes `tests`.
      'tests/**',
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
             * Fixtures are store-only consumers (story 012). Everything that
             * renders reads through a selector hook, never the raw data.
             */
            {
              target: [
                './src/components/**/*',
                './src/features/**/*',
                './src/hooks/**/*',
                './src/lib/**/*',
                './src/utils/**/*',
              ],
              from: './src/data/**/*',
              message:
                'Only stores/ may import data/. Read fixture-derived state through a selector hook.',
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
      'check-file/folder-naming-convention': ['error', { 'src/**/': 'KEBAB_CASE' }],

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
    files: ['*.config.{ts,mjs}', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
);
