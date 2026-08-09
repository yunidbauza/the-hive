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
    expect(Object.keys(darkTokens)).toHaveLength(38);
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

  it('keeps the terminal dark in light mode', () => {
    // The concept and most real tools do this; the doc states it, so the code
    // had better agree.
    expect(lightTokens['--cc-term-bg']).toBeUndefined();
    expect(lightTokens['--cc-term-input']).toBeUndefined();
    expect(darkTokens['--cc-term-bg']).toBe('#0b1023');
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
