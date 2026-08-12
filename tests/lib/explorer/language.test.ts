import { describe, expect, it } from 'vitest';

import { extensionOf, languageFor } from '@lib/explorer/language';

/**
 * Extension → language, and the loaders behind it.
 *
 * The **loaders are not invoked here.** Calling one would pull a Lezer grammar
 * into a happy-dom unit test to prove that a dynamic import resolves, which is
 * a fact about the bundler rather than about this table. What matters is the
 * mapping, and that an unlisted extension resolves to `null` rather than
 * throwing.
 */

describe('extensionOf', () => {
  it('returns the lowercased extension', () => {
    expect(extensionOf('App.TSX')).toBe('tsx');
  });

  /**
   * A leading dot is a name, not an extension. `.gitignore` has no extension —
   * treating `gitignore` as one would make every dotfile look like a type.
   */
  it('treats a leading dot as part of the name, not an extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('.env')).toBe('');
  });

  it('uses the last dot', () => {
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('.env.local')).toBe('local');
  });

  it('returns empty for a name with no dot', () => {
    expect(extensionOf('Makefile')).toBe('');
  });
});

describe('languageFor', () => {
  it.each([
    ['index.js', 'javascript'],
    ['index.mjs', 'javascript'],
    ['index.cjs', 'javascript'],
    ['app.jsx', 'jsx'],
    ['store.ts', 'typescript'],
    ['app.tsx', 'tsx'],
    ['tsconfig.json', 'json'],
    ['tokens.css', 'css'],
    ['index.html', 'html'],
    ['AGENTS.md', 'markdown'],
    ['ci.yml', 'yaml'],
    ['main.py', 'python'],
    ['schema.sql', 'sql'],
    ['main.rs', 'rust'],
    ['main.go', 'go'],
    ['App.java', 'java'],
    ['index.php', 'php'],
    ['icon.svg', 'xml'],
    ['setup.sh', 'shell'],
  ])('maps %s to %s', (name, id) => {
    expect(languageFor(name)?.id).toBe(id);
  });

  /**
   * `.mts` and `.cts` are TypeScript, not TSX.
   *
   * The module variants cannot contain JSX, and the JSX grammar changes how `<`
   * parses — which turns a generic type argument into an unclosed tag.
   */
  it('maps the module TypeScript variants away from JSX', () => {
    expect(languageFor('a.mts')?.id).toBe('typescript');
    expect(languageFor('a.cts')?.id).toBe('typescript');
  });

  it('matches whole filenames that carry no extension', () => {
    expect(languageFor('.zshrc')?.id).toBe('shell');
    expect(languageFor('.BASHRC')?.id).toBe('shell');
  });

  it('is case-insensitive on the extension', () => {
    expect(languageFor('README.MD')?.id).toBe('markdown');
  });

  /**
   * A supported outcome, not a gap. Plain text still gets line numbers,
   * wrapping and search — the file reads fine.
   */
  it('returns null for anything it does not know', () => {
    expect(languageFor('Dockerfile')).toBeNull();
    expect(languageFor('.gitignore')).toBeNull();
    expect(languageFor('data.parquet')).toBeNull();
    expect(languageFor('LICENSE')).toBeNull();
  });

  it('gives every language a label and a loader', () => {
    const language = languageFor('app.tsx');
    expect(language?.label).toBe('TSX');
    expect(typeof language?.load).toBe('function');
  });
});
