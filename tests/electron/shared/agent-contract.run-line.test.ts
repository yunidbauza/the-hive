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
   * What binds them is **this type**, and it has to be a type rather than an
   * assertion. The assignability test above assigns a *variable*, so excess
   * property checking does not apply: rename main's marker to `turnEnd` and
   * `RunLine` stays perfectly assignable to `TermLine` — the field simply stops
   * being read. `turnsOf` would find no boundaries and render one long
   * unseparated turn, which both docblocks describe as the *correct*
   * degradation for an old buffer. The bug would be indistinguishable from
   * working software.
   *
   * Runtime assertions cannot catch that either: `expect(x.endsTurn).toBe(true)`
   * on a literal that just set it is true by construction whatever the other
   * declaration says. So the gate is `pnpm type-check`, and what follows is
   * written to fail there.
   */
  it('carries the turn marker under the same name on both sides', () => {
    // `never` unless the type has an optional `endsTurn?: true`. Assigning a
    // real value to a `never` is the compile error a rename produces.
    type Marks<T> = T extends { endsTurn?: true } ? 'marked' : never;

    const runLineIsMarked: Marks<RunLine> = 'marked';
    const termLineIsMarked: Marks<TermLine> = 'marked';

    // And the field is genuinely optional on both — a required one would break
    // every ordinary line.
    const plainRun: RunLine = { text: 'reading the ledger', color: 'dim' };
    const plainTerm: TermLine = { text: 'reading the ledger', color: 'dim' };

    expect([runLineIsMarked, termLineIsMarked]).toEqual(['marked', 'marked']);
    expect(plainRun.endsTurn).toBeUndefined();
    expect(plainTerm.endsTurn).toBeUndefined();
  });

  /*
    A fold really does travel from main's type to the renderer's with the marker
    intact — the one assertion here that is about values rather than types.
  */
  it('carries a fold across the boundary with its marker', () => {
    const fold: RunLine = {
      text: '● turn ended — success',
      color: 'cyan',
      endsTurn: true,
    };
    const asTerm: TermLine = fold;

    expect(asTerm.endsTurn).toBe(true);
  });
});
