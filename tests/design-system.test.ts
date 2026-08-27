import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TERM } from '@lib/terminal/ansi';

/**
 * Story 015 requires `.claude/DESIGN-SYSTEM.md` to reproduce the token sets and
 * the terminal palette, and to be verified "by diffing the values, not by eye".
 *
 * This is that diff. A doc that drifts from the code is worse than no doc: it
 * gets trusted. Editing a token now fails here until the table is updated too.
 */

const read = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf8');

const tokensCss = read('src/styles/tokens.css');
const designSystem = read('.claude/DESIGN-SYSTEM.md');

/** Pull `--cc-name: #value;` pairs out of a CSS block. */
function parseTokens(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/(--cc-[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})/gi)) {
    tokens[match[1]] = match[2].toLowerCase();
  }
  return tokens;
}

function block(source: string, startPattern: RegExp): string {
  const start = source.search(startPattern);
  expect(start, `could not find ${startPattern} in tokens.css`).toBeGreaterThan(-1);
  const end = source.indexOf('}', start);
  return source.slice(start, end);
}

const darkTokens = parseTokens(block(tokensCss, /:root\s*\{/));
const lightTokens = parseTokens(block(tokensCss, /body\[data-theme='light'\]\s*\{/));

describe('DESIGN-SYSTEM.md — colour tokens', () => {
  it('parses a complete dark token set from tokens.css', () => {
    // Guards the parser itself: a regex that silently matched nothing would
    // make every assertion below vacuously true.
    expect(Object.keys(darkTokens)).toHaveLength(39);
  });

  it('documents every dark token with the value tokens.css defines', () => {
    for (const [token, value] of Object.entries(darkTokens)) {
      expect(
        designSystem,
        `DESIGN-SYSTEM.md is missing dark ${token}: ${value}`,
      ).toContain(`\`${token}\``);
      expect(
        designSystem,
        `DESIGN-SYSTEM.md has a stale value for dark ${token} (expected ${value})`,
      ).toContain(value);
    }
  });

  it('documents every light override with the value tokens.css defines', () => {
    for (const [token, value] of Object.entries(lightTokens)) {
      expect(
        designSystem,
        `DESIGN-SYSTEM.md has a stale value for light ${token} (expected ${value})`,
      ).toContain(value);
    }
  });

  it('gives the terminal a light surface in light mode', () => {
    /**
     * This assertion used to say the opposite — that `--cc-term-bg` and
     * `--cc-term-input` had *no* light override, because the terminal stayed
     * dark in both themes. It was inverted deliberately: the terminal shares
     * the centre stage with an editor that follows the theme, and one dark slab
     * in a light app reads as a panel that failed to load.
     *
     * Every `--cc-term-*` token is checked, not just the two surfaces. The
     * chrome that sits *on* the terminal ground has to move with it, or the
     * table headers and row highlights end up dark-on-light.
     */
    for (const token of [
      '--cc-term-bg',
      '--cc-term-input',
      '--cc-term-row-hover',
      '--cc-term-row-active',
      '--cc-term-head',
      '--cc-term-track',
    ]) {
      expect(
        lightTokens[token],
        `${token} has no light override — the terminal would stay dark`,
      ).toBeDefined();
      expect(lightTokens[token]).not.toBe(darkTokens[token]);
    }

    // Dark is untouched by the change.
    expect(darkTokens['--cc-term-bg']).toBe('#0b1023');
    // And the light ground is the editor's, which is the whole point.
    expect(lightTokens['--cc-term-bg']).toBe(lightTokens['--cc-panel-2']);
  });

  /**
   * "Different from dark" is not "visible", and the check above cannot tell
   * them apart.
   *
   * The first cut of the light theme set `--cc-term-row-hover` to `--cc-hover`
   * (#f4f9ff), which is calibrated against a **white** panel and is therefore
   * *lighter* than the terminal's #f7fafb ground. It passed every assertion
   * above while moving a hovered row by 1.008:1 — no affordance at all.
   *
   * Light lifts by deepening, so both row states must be darker than the
   * ground, and the selected row must read stronger than a merely hovered one.
   */
  it('gives the light terminal row states that can actually be seen', () => {
    const luminance = (hex: string) =>
      [0, 2, 4]
        .map((i) => Number.parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + [0.2126, 0.7152, 0.0722][i] * c, 0);

    const ground = luminance(lightTokens['--cc-term-bg']);
    const hover = luminance(lightTokens['--cc-term-row-hover']);
    const active = luminance(lightTokens['--cc-term-row-active']);

    expect(hover, 'hover must deepen against the light ground').toBeLessThan(ground);
    expect(active, 'active must deepen further than hover').toBeLessThan(hover);

    // And the step has to be big enough to register: the app's own light hover
    // moves 1.058:1 on a panel, so anything near 1.0 is a non-affordance.
    const contrast = (a: number, b: number) =>
      (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    expect(contrast(ground, hover)).toBeGreaterThan(1.03);
  });

  it('does not document a token that no longer exists', () => {
    const documented = [
      ...designSystem.matchAll(/`(--cc-[a-z0-9-]+)`/g),
    ].map((match) => match[1]);

    for (const token of new Set(documented)) {
      expect(darkTokens, `DESIGN-SYSTEM.md documents removed token ${token}`)
        .toHaveProperty(token);
    }
  });
});

describe('DESIGN-SYSTEM.md — terminal palette', () => {
  it('documents every TERM value exactly', () => {
    for (const [key, value] of Object.entries(TERM)) {
      expect(
        designSystem,
        `DESIGN-SYSTEM.md has a stale value for TERM.${key} (expected ${value})`,
      ).toContain(value);
    }
  });

  it('lists every TERM key', () => {
    for (const key of Object.keys(TERM)) {
      expect(designSystem).toContain(`\`${key}\``);
    }
  });
});

describe('AGENTS.md', () => {
  const agents = read('AGENTS.md');

  it('stays under 200 lines — anything longer belongs in a deep-dive', () => {
    expect(agents.split('\n').length).toBeLessThan(200);
  });

  it('routes to every deep-dive doc that exists', () => {
    for (const doc of [
      'docs/terminal-architecture.md',
      'docs/explorer-and-editor.md',
      'docs/state-and-data.md',
      'docs/component-patterns.md',
      'docs/simulation.md',
      '.claude/DESIGN-SYSTEM.md',
      '.claude/COMPONENTS.md',
    ]) {
      expect(agents, `AGENTS.md does not route to ${doc}`).toContain(doc);
      // And the target must exist — a routing table pointing at a missing file
      // is worse than no table.
      expect(() => read(doc)).not.toThrow();
    }
  });

  it('states the always-on rules', () => {
    expect(agents).toContain('pnpm lint');
    expect(agents).toContain('pnpm type-check');
    expect(agents).toContain('TerminalTransport');
    expect(agents).toContain('selector hook');
    expect(agents).toContain('80%');
  });
});
