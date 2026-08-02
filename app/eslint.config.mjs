import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Baseline flat config (story 010).
 *
 * Story 014 (architecture boundaries) owns the rules that make this config
 * matter: the `import/no-restricted-paths` zones, `import/no-cycle`,
 * `check-file` kebab-case naming, `import/order`, and jsx-a11y.
 *
 * `tests/**` is excluded from lint scope, matching incorpx. Type-checking still
 * covers it via `pnpm type-check` (tsconfig.json includes `tests`).
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'tests/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
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
    files: ['*.config.{ts,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
