// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The splash's palette must not drift from the app's.
 *
 * `src/splash/splash-tokens.css` is a deliberate copy: `tokens.css` opens with
 * `@import 'tailwindcss'`, and pulling the framework into a document whose job
 * is to paint before the app would defeat the point of having it. This is the
 * same arrangement `ansi.test.ts` polices between `--cc-term-bg` and
 * `TERM_LIGHT.bg` — two systems that cannot share a definition, held to one
 * value by a test rather than by a promise.
 *
 * Change a colour in `tokens.css` and this fails until the splash follows.
 */

const appRoot = join(import.meta.dirname, '../..');

const readTokens = (path: string): Map<string, string> => {
  const css = readFileSync(join(appRoot, path), 'utf8');
  // Comments first: `tokens.css` documents several values in prose that would
  // otherwise be read as declarations.
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Map<string, string>();
  for (const [, name, value] of declarations.matchAll(
    /(--[a-z0-9-]+)\s*:\s*([^;]+);/g,
  )) {
    // `:root` first, and `body[data-theme='light']` after it — the splash is
    // dark-only, so the first (dark) definition is the one that must match.
    if (!found.has(name)) found.set(name, value.trim());
  }
  return found;
};

describe('splash tokens', () => {
  const app = readTokens('src/styles/tokens.css');
  const splash = readTokens('src/splash/splash-tokens.css');

  it('copies at least the colours the chamber paints with', () => {
    // A guard against the file being emptied and the suite still passing.
    expect(splash.size).toBeGreaterThanOrEqual(13);
  });

  it.each([...splash.keys()])('%s matches src/styles/tokens.css', (name) => {
    expect(app.has(name)).toBe(true);
    expect(splash.get(name)).toBe(app.get(name));
  });

  it('declares nothing the app does not', () => {
    const unknown = [...splash.keys()].filter((name) => !app.has(name));
    expect(unknown).toEqual([]);
  });
});
