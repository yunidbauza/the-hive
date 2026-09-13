// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { createDeliver, type Deliver } from '../../../../electron/main/ledger/deliver';
import { createLedger, type Ledger } from '../../../../electron/main/ledger/index';
import { OVERMIND } from '../../../../electron/shared/ledger-contract';

/**
 * Delivery: what happens to a ledger entry after it is written (HIVE-113).
 *
 * Collaborators are three closures and a recording `write`, so nothing here
 * loads Electron, a pty or the session layer — the same shape
 * `createLedger`'s own suite uses for `knowsParty`.
 */

const AT = new Date(2026, 7, 29, 14, 15, 30).getTime();

describe('createDeliver', () => {
  let dir: string;
  let clock: number;
  let ledger: Ledger;
  let deliver: Deliver;
  let write: Mock<(entityId: string, data: string) => boolean>;
  let live: Set<string>;
  let idle: Set<string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-deliver-'));
    clock = AT;
    live = new Set(['sess-a']);
    idle = new Set(['sess-a']);
    write = vi.fn((_entityId: string, _data: string) => true);

    ledger = createLedger({ dir, now: () => clock, knowsParty: () => true });
    deliver = createDeliver({
      ledger,
      isLive: (id) => live.has(id),
      isIdle: (id) => idle.has(id),
      write: (id, data) => write(id, data),
    });
    ledger.onChange((entry) => deliver.onEntry(entry));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const ask = (to: string, body = 'which branch?') =>
    ledger.append({ from: OVERMIND, to, kind: 'ask', body });

  const receipts = () => ledger.read({}).entries.filter((e) => e.meta?.delivered !== undefined);

  const lastWrite = () => write.mock.calls.at(-1)?.[1] as string;

  it('writes one marker into a live idle session, and nothing of the entry', () => {
    const result = ask('sess-a');
    expect(result.ok).toBe(true);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe('sess-a');
    /*
      The marker names the ask by its ref and carries nothing else (HIVE-138):
      the entry reaches the model as hook context from the receiver, not as
      bytes on the pty. The trailing carriage return is what submits it.
    */
    expect(lastWrite()).toBe(`📒 ${result.ok ? result.ref : ''}\r`);
    expect(lastWrite()).not.toContain('which branch?');
  });

  it('records a receipt naming the delivered entry', () => {
    const result = ask('sess-a');

    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]?.meta?.delivered).toBe(result.ok ? result.id : '');
    expect(receipts()[0]?.from).toBe(OVERMIND);
    expect(receipts()[0]?.to).toBe('sess-a');
  });

  it('never writes twice for the same entry', () => {
    ask('sess-a');
    deliver.onIdle('sess-a');
    deliver.onIdle('sess-a');

    expect(write).toHaveBeenCalledTimes(1);
  });

  /*
    Retro C: an ask with `meta.after: "owner/repo#N"` waits for that PR's
    `closed` entry, which is the shipper's, addressed to whoever it reports to.
  */
  describe('a held ask (meta.after)', () => {
    const held = (to: string, after: string) =>
      ledger.append({ from: OVERMIND, to, kind: 'ask', body: 'after the merge', meta: { after } });
    const closed = (pr: number, repo: string, to = 'sess-z') =>
      ledger.append({
        from: 'shipper',
        to,
        kind: 'post',
        body: `PR #${String(pr)} merged`,
        meta: { pr, repo, stage: 'closed' },
      });

    it('is not written while its PR is open, on arrival or on idle', () => {
      held('sess-a', 'a/b#3');
      deliver.onIdle('sess-a');

      expect(write).not.toHaveBeenCalled();
    });

    it("is written once when its PR's closed entry lands, and receipted once", () => {
      const result = held('sess-a', 'a/b#3');
      closed(3, 'a/b');

      expect(write).toHaveBeenCalledTimes(1);
      expect(lastWrite()).toBe(`📒 ${result.ok ? result.ref : ''}\r`);

      deliver.onIdle('sess-a');
      expect(write).toHaveBeenCalledTimes(1);
      expect(receipts()).toHaveLength(1);
    });

    it('stays held on a closed entry for another PR or another repo', () => {
      held('sess-a', 'a/b#3');
      closed(4, 'a/b');
      closed(3, 'a/c');
      deliver.onIdle('sess-a');

      expect(write).not.toHaveBeenCalled();
    });

    it('is written at once when its PR had already closed', () => {
      closed(3, 'a/b');
      const result = held('sess-a', 'a/b#3');

      expect(write).toHaveBeenCalledTimes(1);
      expect(lastWrite()).toBe(`📒 ${result.ok ? result.ref : ''}\r`);
    });

    it('writes one line when the closed entry and the held ask share a session', () => {
      held('sess-a', 'a/b#3');
      closed(3, 'a/b', 'sess-a');

      // The first owed entry goes in; the next waits for the next idle.
      expect(write).toHaveBeenCalledTimes(1);
      deliver.onIdle('sess-a');
      expect(write).toHaveBeenCalledTimes(2);
    });
  });

  it('holds a nudge while the session is mid-turn, then flushes at idle', () => {
    idle.delete('sess-a');
    ask('sess-a');
    expect(write).not.toHaveBeenCalled();

    idle.add('sess-a');
    deliver.onIdle('sess-a');

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('holds a nudge for an ended session, then flushes on resume', () => {
    live.delete('sess-a');
    idle.delete('sess-a');
    ask('sess-a');
    expect(write).not.toHaveBeenCalled();

    live.add('sess-a');
    idle.add('sess-a');
    deliver.onReady('sess-a');

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not flush an ask that was answered while the session was away (HIVE-167)', () => {
    live.delete('sess-a');
    idle.delete('sess-a');
    const result = ask('sess-a');
    if (!result.ok) throw new Error(result.reason);
    // The overmind answered it from the inbox, where a redirect put it.
    const answered = ledger.answer({ thread: result.id, body: 'main' }, OVERMIND);
    if (!answered.ok) throw new Error(answered.reason);
    write.mockClear();

    live.add('sess-a');
    idle.add('sess-a');
    deliver.onReady('sess-a');

    // The answer to the overmind's own ask is addressed to the overmind, so
    // nothing at all is owed to this terminal any more.
    expect(write).not.toHaveBeenCalled();
  });

  it('writes nothing for an ask addressed to the overmind', () => {
    // The overmind's copy is an inbox card (HIVE-118), not a terminal line.
    ledger.append({ from: 'sess-a', to: OVERMIND, kind: 'ask', body: 'hi' });

    expect(write).not.toHaveBeenCalled();
  });

  it('writes nothing for a broadcast', () => {
    ledger.append({ from: OVERMIND, kind: 'ask', body: 'anyone?' });

    expect(write).not.toHaveBeenCalled();
  });

  it('writes nothing for a party that is not a live session', () => {
    // An agent is HIVE-120; an unknown party has nowhere to write to.
    ask('pr-reviewer');

    expect(write).not.toHaveBeenCalled();
  });

  it('ignores kinds that are not ask, answer or post', () => {
    ledger.append({ from: OVERMIND, to: 'sess-a', kind: 'done', body: 'finished' });

    expect(write).not.toHaveBeenCalled();
  });

  /**
   * A post addressed to a session is a one-way notice (the shipper's "PR
   * merged"): it reaches the terminal the way an ask does, and is receipted
   * once. A broadcast post still wakes nobody.
   */
  it('writes a marker for a post addressed to the session, and receipts it once', () => {
    const result = ledger.append({ from: 'shipper', to: 'sess-a', kind: 'post', body: 'PR #9 merged' });

    expect(result.ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe('sess-a');
    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]?.meta?.delivered).toBe(result.ok ? result.id : undefined);

    deliver.onIdle('sess-a');

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for a broadcast post', () => {
    ledger.append({ from: 'shipper', kind: 'post', body: 'PR #9 merged' });

    expect(write).not.toHaveBeenCalled();
  });

  it('never writes a post addressed to another session into this one', () => {
    ledger.append({ from: 'shipper', to: 'sess-b', kind: 'post', body: 'PR #9 merged' });
    deliver.onIdle('sess-a');

    expect(write).not.toHaveBeenCalled();
  });

  it('ignores its own receipts rather than feeding itself', () => {
    /*
      The loop guard. This module subscribes to `onChange` *and* appends a
      receipt for every nudge; without the kind gate each receipt would
      re-enter `onEntry` and it would write forever.
    */
    ask('sess-a');

    expect(write).toHaveBeenCalledTimes(1);
    expect(receipts()).toHaveLength(1);
  });

  it('nudges the asker when an answer arrives', () => {
    live.add('sess-b');
    idle.add('sess-b');
    const asked = ledger.append({ from: 'sess-b', to: OVERMIND, kind: 'ask', body: 'ok?' });
    write.mockClear();

    const answered = ledger.answer({ thread: asked.ok ? asked.id : '', body: 'yes' }, OVERMIND);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe('sess-b');
    expect(lastWrite()).toBe(`📒 ${answered.ok ? answered.id : ''}\r`);
    expect(lastWrite()).not.toContain('yes');
  });

  it('names an answer by its own id, never the ask ref', () => {
    /*
      An answer has no ref, and a thread can carry more than one entry, so the
      ask's ref would not tell the receiver which entry to carry.
    */
    live.add('sess-b');
    idle.add('sess-b');
    const asked = ledger.append({ from: 'sess-b', to: OVERMIND, kind: 'ask', body: 'ok?' });
    const ref = asked.ok ? asked.ref : undefined;
    write.mockClear();

    const answered = ledger.answer({ thread: asked.ok ? asked.id : '', body: 'yes' }, OVERMIND);

    expect(ref).toBeDefined();
    expect(answered.ok).toBe(true);
    expect(lastWrite()).toContain(answered.ok ? answered.id : '');
    expect(lastWrite()).not.toContain(`${ref}\r`);
  });

  it('does not record a receipt when the write did not land', () => {
    /*
      A receipt for a nudge that never reached a terminal would suppress the
      retry forever — which is why `write` reports whether it landed.
    */
    write.mockReturnValue(false);
    ask('sess-a');
    expect(receipts()).toHaveLength(0);

    write.mockReturnValue(true);
    deliver.onIdle('sess-a');

    expect(write).toHaveBeenCalledTimes(2);
    expect(receipts()).toHaveLength(1);
  });

  /**
   * The security boundary this module used to hold. A body is authored by
   * another party, and this was the one path that typed it into somebody's
   * prompt terminated by `\r`. Since HIVE-138 no byte of it reaches the pty at
   * all: the marker is a ref or an id main minted, and the body travels as
   * JSON the model reads (`context.ts`).
   */
  it('carries nothing of the body onto the pty, whatever the body holds', () => {
    const result = ask('sess-a', 'check this\r[2Jrm -rf ~/work\nsecond line');

    const data = lastWrite();
    expect(data).toBe(`📒 ${result.ok ? result.ref : ''}\r`);
    // Exactly one submission: the one this module appended.
    expect(data.split('\r')).toHaveLength(2);
  });

  /**
   * One nudge per idle window. The first write ends in `\r`, which starts a
   * turn — so writing the rest of the backlog behind it would be writing
   * mid-turn, the one thing this module must never do.
   */
  it('writes one nudge per idle window, not the whole backlog', () => {
    idle.delete('sess-a');
    const first = ask('sess-a', 'first question');
    const second = ask('sess-a', 'second question');
    expect(write).not.toHaveBeenCalled();

    idle.add('sess-a');
    deliver.onIdle('sess-a');

    expect(write).toHaveBeenCalledTimes(1);
    expect(lastWrite()).toBe(`📒 ${first.ok ? first.ref : ''}\r`);

    // The remainder was not lost — it has no receipt, so the next idle takes it.
    deliver.onIdle('sess-a');
    expect(write).toHaveBeenCalledTimes(2);
    expect(lastWrite()).toBe(`📒 ${second.ok ? second.ref : ''}\r`);
  });

  /**
   * The input box is a precondition beside idleness (HIVE-135). `isIdle` is
   * about the agent; a user who typed half a sentence and stopped has an idle
   * agent and a full box, and a nudge written then is submitted together with
   * their draft. The visible surface reports what it sees; main refuses to
   * write into a draft and picks the nudge up when the box clears.
   */
  /**
   * Two surface ids, standing in for two devices attached to one server
   * (HIVE-145). The registry's real ids are opaque strings; nothing here
   * depends on their shape.
   */
  const A = 'surface-a';
  const B = 'surface-b';

  describe('the focused session', () => {
    it('holds a nudge while the focused session reports a draft', () => {
      deliver.onPrompt(A, 'sess-a', 'draft');
      ask('sess-a');

      expect(write).not.toHaveBeenCalled();
      expect(receipts()).toHaveLength(0);
    });

    it('delivers the held nudge the moment the box is reported empty', () => {
      deliver.onPrompt(A, 'sess-a', 'draft');
      ask('sess-a');
      deliver.onPrompt(A, 'sess-a', 'empty');

      expect(write).toHaveBeenCalledTimes(1);
      expect(receipts()).toHaveLength(1);
    });

    it('holds at idle too — idle is about the agent, not the box', () => {
      idle.delete('sess-a');
      ask('sess-a');
      deliver.onPrompt(A, 'sess-a', 'draft');
      idle.add('sess-a');
      deliver.onIdle('sess-a');

      expect(write).not.toHaveBeenCalled();
    });

    it('delivers to a session that is not the focused one, as before', () => {
      live.add('sess-b');
      idle.add('sess-b');
      deliver.onPrompt(A, 'sess-a', 'draft');
      ask('sess-b');

      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0]).toBe('sess-b');
    });

    it('treats an unfocused report as "no session is focused"', () => {
      deliver.onPrompt(A, 'sess-a', 'draft');
      deliver.onPrompt(A, 'sess-a', 'unfocused');
      ask('sess-a');

      expect(write).toHaveBeenCalledTimes(1);
    });

    it('ignores an unfocused report from a surface that already lost focus', () => {
      // sess-a was focused with a draft; focus moved to sess-b, also a draft.
      live.add('sess-b');
      idle.add('sess-b');
      deliver.onPrompt(A, 'sess-a', 'draft');
      deliver.onPrompt(A, 'sess-b', 'draft');
      // A late `unfocused` from sess-a must not clear sess-b's record.
      deliver.onPrompt(A, 'sess-a', 'unfocused');
      ask('sess-b');

      expect(write).not.toHaveBeenCalled();
    });

    it('does not flush on an empty report that is not a transition', () => {
      /*
        After a nudge is submitted the renderer's next screen read says
        `empty` again, and main's idle answer can lag the busy-state hook.
        A repeat report must not flush the backlog behind the turn the last
        nudge started. Staged so the session *is* idle when the repeat
        arrives: with the transition guard removed this writes twice.
      */
      deliver.onPrompt(A, 'sess-a', 'empty');
      ask('sess-a', 'first');
      expect(write).toHaveBeenCalledTimes(1);

      idle.delete('sess-a');
      ask('sess-a', 'second');
      idle.add('sess-a');
      deliver.onPrompt(A, 'sess-a', 'empty');

      expect(write).toHaveBeenCalledTimes(1);
      // The second is not lost: the next idle transition takes it.
      deliver.onIdle('sess-a');
      expect(write).toHaveBeenCalledTimes(2);
    });

    it('clears the record when the renderer goes away', () => {
      deliver.onPrompt(A, 'sess-a', 'draft');
      deliver.onSurfaceGone(A);
      ask('sess-a');

      expect(write).toHaveBeenCalledTimes(1);
    });

    it('flushes a held nudge on the first empty report after a renderer reset', () => {
      deliver.onPrompt(A, 'sess-a', 'draft');
      ask('sess-a');
      deliver.onSurfaceGone(A);
      expect(write).not.toHaveBeenCalled();

      // The surface remounts and reads an empty box: this is the transition.
      deliver.onPrompt(A, 'sess-a', 'empty');

      expect(write).toHaveBeenCalledTimes(1);
    });

    /**
     * Two surfaces, and the reason this record stopped being one value
     * (HIVE-145).
     *
     * "The stage shows one terminal at a time" was a fact about a single
     * renderer. Server mode makes every attached socket a surface, and all of
     * them report down the same `pty:prompt` notify — so the old single record
     * said whatever the last one to speak said, about whichever session *it*
     * was watching.
     */
    describe('two surfaces', () => {
      it('holds while any surface reports a draft for that session', () => {
        deliver.onPrompt(A, 'sess-a', 'draft');
        deliver.onPrompt(B, 'sess-a', 'empty');
        ask('sess-a');

        expect(write).not.toHaveBeenCalled();
      });

      it('does not release one surface\'s hold when another reports elsewhere', () => {
        live.add('sess-b');
        idle.add('sess-b');
        deliver.onPrompt(A, 'sess-a', 'draft');
        ask('sess-a');

        // B is looking at a different session entirely. Under the old single
        // record this `empty` overwrote A's draft and the nudge landed
        // mid-typing.
        deliver.onPrompt(B, 'sess-b', 'empty');

        expect(write).not.toHaveBeenCalled();
      });

      it('delivers only once the last surface holding a draft clears it', () => {
        deliver.onPrompt(A, 'sess-a', 'draft');
        deliver.onPrompt(B, 'sess-a', 'draft');
        ask('sess-a');

        deliver.onPrompt(A, 'sess-a', 'empty');
        expect(write).not.toHaveBeenCalled();

        deliver.onPrompt(B, 'sess-a', 'empty');
        expect(write).toHaveBeenCalledTimes(1);
      });

      it('keeps a live surface\'s hold when a different surface goes away', () => {
        deliver.onPrompt(A, 'sess-a', 'draft');
        ask('sess-a');

        /*
          The regression this story exists to stop. `onRendererReset` was wired
          to every socket's `destroyed`, so *any* attached socket dropping wiped
          the record — and the held nudge was then written into the half-typed
          box belonging to a surface that never went anywhere. That is HIVE-135's
          own failure, arriving through a second client rather than through a
          change to the nudge logic.
        */
        deliver.onSurfaceGone(B);

        expect(write).not.toHaveBeenCalled();
      });

      it('releases the hold when the surface holding it goes away', () => {
        deliver.onPrompt(A, 'sess-a', 'draft');
        deliver.onSurfaceGone(A);
        ask('sess-a');

        expect(write).toHaveBeenCalledTimes(1);
      });

      it('tracks the two surfaces separately when they watch different sessions', () => {
        live.add('sess-b');
        idle.add('sess-b');
        deliver.onPrompt(A, 'sess-a', 'draft');
        deliver.onPrompt(B, 'sess-b', 'draft');

        ask('sess-a');
        ask('sess-b');
        expect(write).not.toHaveBeenCalled();

        deliver.onPrompt(A, 'sess-a', 'empty');
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0][0]).toBe('sess-a');
      });

      it('ignores a late unfocused from one surface against another\'s record', () => {
        deliver.onPrompt(A, 'sess-a', 'draft');
        deliver.onPrompt(B, 'sess-a', 'draft');
        // A late report from B about a session it has already left must not
        // clear A's hold on the same session.
        deliver.onPrompt(B, 'sess-a', 'unfocused');
        ask('sess-a');

        expect(write).not.toHaveBeenCalled();
      });
    });

    it('flushes a held nudge after a draft, away, and back to an empty box', () => {
      deliver.onPrompt(A, 'sess-a', 'draft');
      ask('sess-a');
      deliver.onPrompt(A, 'sess-a', 'unfocused');
      // Delivered as an unfocused session? No entry arrived and no idle fired.
      expect(write).not.toHaveBeenCalled();

      deliver.onPrompt(A, 'sess-a', 'empty');

      expect(write).toHaveBeenCalledTimes(1);
    });
  });

  /*
    The two halves of the reason delivery is recorded in the log rather than
    held in memory. A second `createLedger` over the same directory is what a
    relaunch actually is.
  */
  const relaunch = () => {
    const reopened = createLedger({ dir, now: () => clock, knowsParty: () => true });
    const write2 = vi.fn((_entityId: string, _data: string) => true);
    const deliver2 = createDeliver({
      ledger: reopened,
      isLive: (id) => live.has(id),
      isIdle: (id) => idle.has(id),
      write: (id, data) => write2(id, data),
    });
    return { deliver2, write2 };
  };

  it('does not re-deliver a nudge that landed before a restart', () => {
    ask('sess-a');
    expect(write).toHaveBeenCalledTimes(1);

    const { deliver2, write2 } = relaunch();
    deliver2.onReady('sess-a');

    expect(write2).not.toHaveBeenCalled();
  });

  it('delivers a nudge that was still pending when the app quit', () => {
    idle.delete('sess-a');
    ask('sess-a');
    expect(write).not.toHaveBeenCalled();

    const { deliver2, write2 } = relaunch();
    idle.add('sess-a');
    deliver2.onReady('sess-a');

    expect(write2).toHaveBeenCalledTimes(1);
  });
});
