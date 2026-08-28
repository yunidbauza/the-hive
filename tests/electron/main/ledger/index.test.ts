// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LEDGER_ASK_TTL_MS,
  LEDGER_BODY_MAX,
  OVERMIND,
} from '../../../../electron/shared/ledger-contract';
import { createLedger, type Ledger } from '../../../../electron/main/ledger/index';

const AT = new Date(2026, 7, 28, 14, 15, 30).getTime();

describe('createLedger', () => {
  let dir: string;
  let clock: number;
  let ledger: Ledger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-ledger-'));
    clock = AT;
    ledger = createLedger({
      dir,
      now: () => clock,
      // Every party is known except the one explicitly named as gone.
      knowsParty: (id) => id !== 'sess-gone',
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a post from a known party', () => {
    const result = ledger.append({ from: 'sess-a', kind: 'post', body: 'hello' });

    expect(result).toMatchObject({ ok: true, id: '20260828-141530-0001' });
  });

  it('refuses a post from a party it does not know', () => {
    const result = ledger.append({ from: 'sess-gone', kind: 'post', body: 'hello' });

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(ledger.read({}).entries).toHaveLength(0);
  });

  it('refuses a body over the cap without appending', () => {
    const result = ledger.append({
      from: 'sess-a',
      kind: 'post',
      body: 'x'.repeat(LEDGER_BODY_MAX + 1),
    });

    expect(result).toMatchObject({ ok: false, status: 413 });
    expect(ledger.read({}).entries).toHaveLength(0);
  });

  it('refuses an unknown kind without appending', () => {
    const result = ledger.append({
      from: 'sess-a',
      // @ts-expect-error — the runtime guard is the subject here.
      kind: 'nonsense',
      body: 'hello',
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(ledger.read({}).entries).toHaveLength(0);
  });

  it('returns the ref it allocated for an ask', () => {
    const result = ledger.append({
      from: 'sess-a',
      to: OVERMIND,
      kind: 'ask',
      body: 'ship it?',
    });

    expect(result).toMatchObject({ ok: true, ref: 'a1' });
  });

  it('closes a thread named by its canonical id', () => {
    const ask = ledger.append({ from: 'sess-a', to: OVERMIND, kind: 'ask', body: 'ship?' });
    if (!ask.ok) throw new Error('setup failed');

    expect(ledger.answer({ thread: ask.id, body: 'yes' }, OVERMIND)).toMatchObject({ ok: true });
    expect(ledger.read({}).openAsks).toHaveLength(0);
  });

  it('closes a thread named by its short ref, storing the canonical id', () => {
    const ask = ledger.append({ from: 'sess-a', to: OVERMIND, kind: 'ask', body: 'ship?' });
    if (!ask.ok) throw new Error('setup failed');

    expect(ledger.answer({ thread: 'a1', body: 'yes' }, OVERMIND)).toMatchObject({ ok: true });

    const answer = ledger.read({ kind: 'answer' }).entries[0];
    expect(answer.thread).toBe(ask.id);
  });

  it('refuses an answer to a thread that is not open, with a reason', () => {
    const result = ledger.answer({ thread: 'a99', body: 'yes' }, OVERMIND);

    expect(result).toMatchObject({ ok: false, status: 400 });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toContain('a99');
    expect(ledger.read({}).entries).toHaveLength(0);
  });

  it('refuses a second answer to an already-closed thread', () => {
    const ask = ledger.append({ from: 'sess-a', to: OVERMIND, kind: 'ask', body: 'ship?' });
    if (!ask.ok) throw new Error('setup failed');
    ledger.answer({ thread: ask.id, body: 'yes' }, OVERMIND);

    expect(ledger.answer({ thread: ask.id, body: 'no' }, OVERMIND)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  /**
   * The openness rule belongs to `append`, not to `answer` (HIVE-111 final
   * review, finding 1).
   *
   * `answer()` is reachable over IPC alone; every out-of-process party comes
   * through `append`. These three cover it directly rather than through the
   * HTTP route, so a later refactor of the receiver cannot quietly take the
   * rule with it.
   */
  describe('an answer appended directly', () => {
    const ask = (): string => {
      const result = ledger.append({ from: 'sess-a', to: OVERMIND, kind: 'ask', body: 'ship?' });
      if (!result.ok) throw new Error('setup failed');
      return result.id;
    };

    it('closes an open thread', () => {
      const thread = ask();

      expect(ledger.append({ from: 'sess-b', kind: 'answer', thread, body: 'yes' })).toMatchObject({
        ok: true,
      });
      expect(ledger.read({}).openAsks).toHaveLength(0);
    });

    it('is refused once the thread is already closed, and appends nothing', () => {
      const thread = ask();
      ledger.append({ from: 'sess-b', kind: 'answer', thread, body: 'yes' });

      const second = ledger.append({ from: 'sess-b', kind: 'answer', thread, body: 'no' });

      expect(second).toMatchObject({ ok: false, status: 400 });
      if (second.ok) throw new Error('expected a refusal');
      expect(second.reason).toContain('not open');
      expect(ledger.read({}).entries).toHaveLength(2);
    });

    it('is refused once the thread has aged past the TTL', () => {
      const thread = ask();
      clock = AT + LEDGER_ASK_TTL_MS;

      expect(ledger.append({ from: 'sess-b', kind: 'answer', thread, body: 'late' })).toMatchObject(
        { ok: false, status: 400 },
      );
      expect(ledger.read({}).entries).toHaveLength(1);
    });

    /*
      `resolveRef` matches any entry id, so a thread naming an ordinary post
      resolves — only the openness check tells the two apart.
    */
    it('is refused when its thread names something that was never an ask', () => {
      const posted = ledger.append({ from: 'sess-a', kind: 'post', body: 'talking' });
      if (!posted.ok) throw new Error('setup failed');

      expect(
        ledger.append({ from: 'sess-b', kind: 'answer', thread: posted.id, body: 'eh' }),
      ).toMatchObject({ ok: false, status: 400 });
      expect(ledger.read({}).entries).toHaveLength(1);
    });

    /*
      Every other kind keeps the looser rule: a `post` may carry a `thread` to
      say "about that question" without pretending to close it.
    */
    it('does not stop a non-answer kind from naming a closed thread', () => {
      const thread = ask();
      ledger.append({ from: 'sess-b', kind: 'answer', thread, body: 'yes' });

      expect(
        ledger.append({ from: 'sess-c', kind: 'post', thread, body: 'noted' }),
      ).toMatchObject({ ok: true });
    });
  });

  it('filters a read and reports derived state', () => {
    ledger.append({ from: 'sess-a', kind: 'post', body: 'one' });
    ledger.append({ from: 'sess-b', kind: 'post', body: 'two' });
    ledger.append({ from: 'sess-a', kind: 'claim', body: '', meta: { task: 'HIVE-9' } });

    const snapshot = ledger.read({ from: 'sess-a' });

    expect(snapshot.entries.map((entry) => entry.from)).toEqual(['sess-a', 'sess-a']);
    expect(snapshot.claims).toEqual({ 'HIVE-9': 'sess-a' });
  });

  it('keeps the newest when a limit is given', () => {
    ledger.append({ from: 'sess-a', kind: 'post', body: 'one' });
    ledger.append({ from: 'sess-a', kind: 'post', body: 'two' });
    ledger.append({ from: 'sess-a', kind: 'post', body: 'three' });

    expect(ledger.read({ limit: 2 }).entries.map((entry) => entry.body)).toEqual([
      'two',
      'three',
    ]);
  });

  it('notifies listeners on an accepted write and not on a refused one', () => {
    const seen: string[] = [];
    ledger.onChange((entry) => seen.push(entry.body));

    ledger.append({ from: 'sess-a', kind: 'post', body: 'kept' });
    ledger.append({ from: 'sess-gone', kind: 'post', body: 'refused' });

    expect(seen).toEqual(['kept']);
  });
});
