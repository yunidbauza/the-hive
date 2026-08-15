import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** `tokens.css`, read from the Vitest root (import.meta.url is http under happy-dom). */
export const TOKENS_CSS = readFileSync(
  resolve(process.cwd(), 'src/styles/tokens.css'),
  'utf8',
);

/**
 * Pull `--cc-name: #value;` pairs out of one selector's block.
 *
 * Generalised from the helper `ansi.test.ts` has used since story 105 — the
 * same trick, now needed for the dark block as well as the light one.
 */
export function parseTokenBlock(
  css: string,
  selector: RegExp,
): Record<string, string> {
  const start = css.search(selector);
  if (start < 0) throw new Error(`block not found: ${String(selector)}`);
  const block = css.slice(start, css.indexOf('\n}', start));

  const parsed: Record<string, string> = {};
  for (const m of block.matchAll(/(--cc-[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})/gi)) {
    parsed[m[1]] = m[2].toLowerCase();
  }
  return parsed;
}

export const DARK_SELECTOR = /^:root\s*\{/m;
export const LIGHT_SELECTOR = /body\[data-theme='light'\]\s*\{/;
