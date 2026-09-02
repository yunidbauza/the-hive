import { describe, expect, it } from 'vitest';

import type { RunLine } from '../../../electron/shared/agent-contract';
import type { TermLine } from '../../../src/types/terminal';

describe('RunLine', () => {
  it('is assignable to TermLine, so main needs no colour mapping', () => {
    const line: RunLine = { text: 'hello', color: 'amber' };
    // A compile-time assertion: widening a colour in RunLine that TermColor
    // does not have breaks this line, which is the point of the test.
    const asTerm: TermLine = line;

    expect(asTerm).toEqual(line);
  });

  /**
   * `endsTurn` is declared twice — on `RunLine` in `electron/shared`, where main
   * writes it, and on `TermLine` in `src/types`, where the renderer reads it off
   * an agent's buffer. The duplication is forced: an agent's `lines` really is a
   * `TermLine[]` (the browser demo appends acknowledgements in colours
   * `RunLineColor` does not have), and `src/**` may not import runtime code from
   * main.
   *
   * What the assignability test above does **not** catch is the two names
   * drifting apart. It assigns a *variable*, so TypeScript's excess-property
   * check does not apply: rename main's marker to `turnEnd` and `RunLine` is
   * still perfectly assignable to `TermLine` — the field simply stops being
   * read. `turnsOf` would then find no boundaries and render one long
   * unseparated turn, which both docblocks describe as the *correct*
   * degradation for an old buffer. The bug would be indistinguishable from
   * working software.
   *
   * So this pins the field by name on both sides, in the direction the other
   * test cannot: the object literals are fresh, so an excess-property error is
   * exactly what a rename produces.
   */
  it('carries the turn marker under the same name on both sides', () => {
    const fold: RunLine = {
      text: '● turn ended — success',
      color: 'cyan',
      endsTurn: true,
    };
    const asTerm: TermLine = {
      text: '● turn ended — success',
      color: 'cyan',
      endsTurn: true,
    };

    expect(fold.endsTurn).toBe(true);
    expect(asTerm.endsTurn).toBe(true);
    expect(asTerm).toEqual(fold);
  });

  /*
    Optional on both, so a buffer written before the field existed still
    type-checks and still renders — as one turn, which is the documented
    degradation.
  */
  it('leaves the marker off an ordinary line', () => {
    const plain: RunLine = { text: 'reading the ledger', color: 'dim' };
    const asTerm: TermLine = plain;

    expect(plain.endsTurn).toBeUndefined();
    expect(asTerm.endsTurn).toBeUndefined();
  });
});
