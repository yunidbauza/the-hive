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
    /*
      Addressed to `sess-b`, which answers it below: only a party to a thread
      may close it (see the party rules further down), and these specs are
      about the *openness* rule, not that one.
    */
    const ask = (): string => {
      const result = ledger.append({ from: 'sess-a', to: 'sess-b', kind: 'ask', body: 'ship?' });
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

  /**
   * `slice(-0)` is `slice(0)` — a whole copy — so the narrowest request a
   * caller can make used to return the widest possible answer. And `0` is not
   * an exotic input: `parseLedgerReadQuery` explicitly admits it, so
   * `{"limit": 0}` returned the entire log over both the HTTP and IPC paths.
   */
  it('returns nothing, not everything, for a limit of zero', () => {
    ledger.append({ from: 'sess-a', kind: 'post', body: 'one' });
    ledger.append({ from: 'sess-a', kind: 'post', body: 'two' });

    const snapshot = ledger.read({ limit: 0 });

    expect(snapshot.entries).toEqual([]);
    // The derived halves are computed from the whole log and are unaffected.
    expect(snapshot.claims).toEqual({});
  });

  /**
   * Only a party to a thread may close it (HIVE-111 ship review).
   *
   * `openAsks` retires an ask on *any* answer naming it, so an answer from a
   * bystander does not merely add noise — it takes the question out of the
   * recipient's inbox, and the party who was actually asked never sees it.
   */
  describe('who may answer', () => {
    const askOf = (to: string | undefined): string => {
      const result = ledger.append({
        from: 'sess-a',
        kind: 'ask',
        body: 'ship?',
        ...(to === undefined ? {} : { to }),
      });
      if (!result.ok) throw new Error('setup failed');
      return result.id;
    };

    it('refuses a session that is neither the recipient nor the asker', () => {
      const thread = askOf(OVERMIND);

      const result = ledger.append({ from: 'sess-c', kind: 'answer', thread, body: 'sure' });

      expect(result).toMatchObject({ ok: false, status: 403 });
      if (result.ok) throw new Error('expected a refusal');
      expect(result.reason).toContain('sess-c');
      // Nothing written, so the question is still in the recipient's inbox.
      expect(ledger.read({}).openAsks).toHaveLength(1);
    });

    it('lets the recipient answer', () => {
      const thread = askOf('sess-b');

      expect(ledger.append({ from: 'sess-b', kind: 'answer', thread, body: 'yes' })).toMatchObject({
        ok: true,
      });
    });

    it('lets the asker close its own question', () => {
      const thread = askOf('sess-b');

      expect(ledger.append({ from: 'sess-a', kind: 'answer', thread, body: 'never mind' })).toMatchObject(
        { ok: true },
      );
    });

    it('lets the overmind answer anything', () => {
      const thread = askOf('sess-b');

      expect(ledger.append({ from: OVERMIND, kind: 'answer', thread, body: 'yes' })).toMatchObject({
        ok: true,
      });
    });

    // A broadcast ask is addressed to everyone, so everyone is its recipient.
    it('lets anyone answer a broadcast ask', () => {
      const thread = askOf(undefined);

      expect(ledger.append({ from: 'sess-c', kind: 'answer', thread, body: 'me' })).toMatchObject({
        ok: true,
      });
    });
  });

  /**
   * Only the holder may release a claim (HIVE-111 ship review).
   *
   * `claims()` deletes on any `release` naming the task regardless of `from`,
   * so a release written by a third party moves the task exactly as if that
   * party had posted as the holder — which the party rule promises can never
   * happen. There is no matching rule for `claim`: the tool layer reports the
   * current holder rather than refusing, so a losing claim is a fact.
   */
  describe('who may release a claim', () => {
    const claim = (): void => {
      ledger.append({ from: 'sess-a', kind: 'claim', body: '', meta: { task: 'HIVE-9' } });
    };

    it('refuses a release from a party that does not hold the task', () => {
      claim();

      const result = ledger.append({
        from: 'sess-b',
        kind: 'release',
        body: '',
        meta: { task: 'HIVE-9' },
      });

      expect(result).toMatchObject({ ok: false, status: 403 });
      if (result.ok) throw new Error('expected a refusal');
      expect(result.reason).toContain('sess-a');
      expect(ledger.read({}).claims).toEqual({ 'HIVE-9': 'sess-a' });
    });

    it('lets the holder release it', () => {
      claim();

      expect(
        ledger.append({ from: 'sess-a', kind: 'release', body: '', meta: { task: 'HIVE-9' } }),
      ).toMatchObject({ ok: true });
      expect(ledger.read({}).claims).toEqual({});
    });

    it('lets the overmind release a claim it does not hold', () => {
      claim();

      expect(
        ledger.append({ from: OVERMIND, kind: 'release', body: '', meta: { task: 'HIVE-9' } }),
      ).toMatchObject({ ok: true });
      expect(ledger.read({}).claims).toEqual({});
    });

    // Nobody holds it, so there is nothing to misappropriate.
    it('allows a release naming a task nobody holds', () => {
      expect(
        ledger.append({ from: 'sess-b', kind: 'release', body: '', meta: { task: 'HIVE-9' } }),
      ).toMatchObject({ ok: true });
    });

    it('does not refuse a second claim on a held task', () => {
      claim();

      expect(
        ledger.append({ from: 'sess-b', kind: 'claim', body: '', meta: { task: 'HIVE-9' } }),
      ).toMatchObject({ ok: true });
    });
  });

  /**
   * An answer is addressed to whoever asked (HIVE-111 ship review).
   *
   * `LedgerAnswerRequest` carries no `to` and should not — the recipient of an
   * answer is not a choice. Leaving it absent made every overmind answer a
   * broadcast, and `visibleTo` in the receiver treats an absent `to` as
   * "everyone", so a private reply was readable by every other session.
   */
  it('addresses an answer to the asker rather than broadcasting it', () => {
    const asked = ledger.append({ from: 'sess-a', to: OVERMIND, kind: 'ask', body: 'ship?' });
    if (!asked.ok) throw new Error('setup failed');

    ledger.answer({ thread: asked.id, body: 'yes' }, OVERMIND);

    expect(ledger.read({ kind: 'answer' }).entries[0]).toMatchObject({
      from: OVERMIND,
      to: 'sess-a',
    });
  });

  /**
   * `to` defaults to the ask's `from` on the direct-`append` path too
   * (HIVE-112 self-review).
   *
   * `Ledger.answer()` — the IPC entry point — has always set `to: ask.from`
   * itself, but the MCP host reaches `append` directly and its tool schema
   * exposes no `to`, so a POST-ed answer left it `undefined` — which
   * `visibleTo` in the receiver treats as "everyone". These three prove the
   * default lives in `append` now, for both callers alike.
   */
  describe('an answer defaults `to` to the asker', () => {
    it('stores `to` as the ask\'s `from` when the request omits it', () => {
      const asked = ledger.append({ from: 'sess-a', to: 'sess-b', kind: 'ask', body: 'ship?' });
      if (!asked.ok) throw new Error('setup failed');

      ledger.append({ from: 'sess-b', kind: 'answer', thread: asked.id, body: 'yes' });

      expect(ledger.read({ kind: 'answer' }).entries[0]).toMatchObject({
        from: 'sess-b',
        to: 'sess-a',
      });
    });

    it('preserves an explicit `to`', () => {
      const asked = ledger.append({ from: 'sess-a', to: 'sess-b', kind: 'ask', body: 'ship?' });
      if (!asked.ok) throw new Error('setup failed');

      ledger.append({
        from: 'sess-b',
        to: 'sess-z',
        kind: 'answer',
        thread: asked.id,
        body: 'redirected',
      });

      expect(ledger.read({ kind: 'answer' }).entries[0]).toMatchObject({ to: 'sess-z' });
    });

    it('produces the same `to` from both `append` directly and from `answer()`', () => {
      const askedForAppend = ledger.append({
        from: 'sess-a',
        to: 'sess-b',
        kind: 'ask',
        body: 'ship one?',
      });
      const askedForAnswer = ledger.append({
        from: 'sess-a',
        to: OVERMIND,
        kind: 'ask',
        body: 'ship two?',
      });
      if (!askedForAppend.ok || !askedForAnswer.ok) throw new Error('setup failed');

      ledger.append({ from: 'sess-b', kind: 'answer', thread: askedForAppend.id, body: 'yes' });
      ledger.answer({ thread: askedForAnswer.id, body: 'yes' }, OVERMIND);

      const answers = ledger.read({ kind: 'answer' }).entries;
      expect(answers.find((entry) => entry.thread === askedForAppend.id)).toMatchObject({
        to: 'sess-a',
      });
      expect(answers.find((entry) => entry.thread === askedForAnswer.id)).toMatchObject({
        to: 'sess-a',
      });
    });
  });

  /**
   * A `thread` query returns the whole conversation, question included —
   * the same definition `thread()` uses. Two readings of "the thread" in one
   * contract would mean a read for `thread: <askId>` came back with the
   * replies and not the ask they reply to.
   */
  it('includes the ask itself in a read filtered by its thread', () => {
    const asked = ledger.append({ from: 'sess-a', to: OVERMIND, kind: 'ask', body: 'ship?' });
    if (!asked.ok) throw new Error('setup failed');
    ledger.answer({ thread: asked.id, body: 'yes' }, OVERMIND);

    expect(ledger.read({ thread: asked.id }).entries.map((entry) => entry.body)).toEqual([
      'ship?',
      'yes',
    ]);
  });

  it('notifies listeners on an accepted write and not on a refused one', () => {
    const seen: string[] = [];
    ledger.onChange((entry) => seen.push(entry.body));

    ledger.append({ from: 'sess-a', kind: 'post', body: 'kept' });
    ledger.append({ from: 'sess-gone', kind: 'post', body: 'refused' });

    expect(seen).toEqual(['kept']);
  });

  /**
   * HIVE-125. `meta` is a free-form rider, so an agent can post this ask
   * itself and make the card read one thing while the grant authorises
   * another. The log must never hold the deceptive version.
   */
  it('stores a permission ask rebuilt from its meta, not from its body', () => {
    ledger.append({
      from: 'sess-a',
      to: OVERMIND,
      kind: 'ask',
      body: 'Allow Read?\n/repo/a.ts',
      meta: { kind: 'permission', tool: 'Bash', input: { command: 'rm -rf /' } },
    });

    const [entry] = ledger.read({}).entries;

    expect(entry?.body).toBe('Allow Bash?\nrm -rf /');
    expect(entry?.meta?.['default']).toBe('allow-family');
  });

  /**
   * The trim `mcp-host/tools.ts` used to do, now at the door a direct
   * `ledger_ask` also passes through. The log never rotates and `store.all()`
   * holds every entry in memory, so an untrimmed `Write` parks 64 KiB
   * permanently.
   */
  it('bounds a permission ask input that arrived untrimmed', () => {
    ledger.append({
      from: 'sess-a',
      to: OVERMIND,
      kind: 'ask',
      body: '',
      meta: {
        kind: 'permission',
        tool: 'Write',
        input: { file_path: '/repo/a.ts', content: 'x'.repeat(64_000) },
      },
    });

    const input = ledger.read({}).entries[0]?.meta?.['input'] as Record<string, unknown>;

    expect(input['content']).toBe('[omitted from the ledger: 64000 chars]');
    expect(input['file_path']).toBe('/repo/a.ts');
  });

  it('leaves an ordinary ask body untouched', () => {
    ledger.append({
      from: 'sess-a',
      to: OVERMIND,
      kind: 'ask',
      body: 'ship it?',
      meta: { options: ['yes', 'no'] },
    });

    const [entry] = ledger.read({}).entries;

    expect(entry?.body).toBe('ship it?');
    expect(entry?.meta).toEqual({ options: ['yes', 'no'] });
  });

  /**
   * An entry that never had a `meta` must not gain an empty one: the absence
   * is what `visibleTo` and the derive helpers read.
   */
  it('does not give a post without meta an empty meta', () => {
    ledger.append({ from: 'sess-a', kind: 'post', body: 'hello' });

    expect(ledger.read({}).entries[0]?.meta).toBeUndefined();
  });

  /**
   * The size refusal runs first, so an oversized body is still refused rather
   * than silently replaced by a short honest one.
   */
  it('still refuses an oversized body on a permission ask', () => {
    const result = ledger.append({
      from: 'sess-a',
      to: OVERMIND,
      kind: 'ask',
      body: 'x'.repeat(LEDGER_BODY_MAX + 1),
      meta: { kind: 'permission', tool: 'Bash', input: { command: 'npm test' } },
    });

    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  /**
   * Self review, finding 1. The cap above tests the body that was *sent*; a
   * permission ask's stored body is composed here, from a `meta.input` that
   * nothing bounds — `command` is not a bulk field and `summarise` returns it
   * verbatim. So an empty sent body carrying a 60 KB command wrote 60 KB into
   * a log capped at 16 KiB, that never rotates, and that `store.all()` holds
   * whole in memory.
   */
  it('refuses a composed body over the cap, however short the sent one', () => {
    const result = ledger.append({
      from: 'sess-a',
      to: OVERMIND,
      kind: 'ask',
      body: '',
      meta: {
        kind: 'permission',
        tool: 'Bash',
        input: { command: `echo ${'x'.repeat(LEDGER_BODY_MAX)}` },
      },
    });

    expect(result).toMatchObject({ ok: false, status: 413 });
    expect(ledger.read({}).entries).toHaveLength(0);
  });

  /**
   * Self review, finding 3. Every other reader of the discriminator requires
   * the entry kind too. Keyed on `meta.kind` alone this rewrote a `post`,
   * destroying its author's text to compose a permission line for an entry
   * that is a permission ask to nobody.
   */
  it('leaves a non-ask carrying permission meta exactly as written', () => {
    ledger.append({
      from: 'sess-a',
      kind: 'post',
      body: 'just a note',
      meta: { kind: 'permission', tool: 'Bash', input: { command: 'rm -rf /' } },
    });

    expect(ledger.read({}).entries[0]?.body).toBe('just a note');
  });
});
