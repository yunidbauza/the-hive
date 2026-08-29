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

  it('writes one nudge into a live idle session', () => {
    expect(ask('sess-a').ok).toBe(true);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe('sess-a');
    expect(lastWrite()).toContain('📒');
    expect(lastWrite()).toContain('overmind asks');
    expect(lastWrite()).toContain('which branch?');
    expect(lastWrite()).toContain('reply with ledger_answer');
    // The trailing carriage return is what submits it as a turn.
    expect(lastWrite().endsWith('\r')).toBe(true);
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

  it('ignores kinds that are not ask or answer', () => {
    ledger.append({ from: OVERMIND, to: 'sess-a', kind: 'post', body: 'fyi' });

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

    ledger.answer({ thread: asked.ok ? asked.id : '', body: 'yes' }, OVERMIND);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe('sess-b');
    expect(lastWrite()).toContain('answered');
    expect(lastWrite()).toContain('yes');
  });

  it('names an answer by the ref the console printed, not the canonical id', () => {
    live.add('sess-b');
    idle.add('sess-b');
    const asked = ledger.append({ from: 'sess-b', to: OVERMIND, kind: 'ask', body: 'ok?' });
    const ref = asked.ok ? asked.ref : undefined;
    write.mockClear();

    ledger.answer({ thread: asked.ok ? asked.id : '', body: 'yes' }, OVERMIND);

    expect(ref).toBeDefined();
    expect(lastWrite()).toContain(`answered ${ref}`);
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

  it('shows only the first line of a multi-line body', () => {
    ask('sess-a', 'first line\nsecond line');

    expect(lastWrite()).toContain('first line');
    expect(lastWrite()).not.toContain('second line');
  });

  /**
   * The security boundary. A body is authored by another party and this is the
   * one path that types it into somebody's prompt, terminated by `\r`.
   */
  it('never lets a body submit a second prompt of its own', () => {
    ask('sess-a', 'check this\rrm -rf ~/work');

    const data = lastWrite();
    // Exactly one submission: the one this module appended.
    expect(data.split('\r')).toHaveLength(2);
    expect(data.endsWith('\r')).toBe(true);
    // `\r` is a line break to a terminal, so the tail is cut with it rather
    // than being carried along as text.
    expect(data).toContain('check this');
    expect(data).not.toContain('rm -rf');
  });

  it('strips escape sequences before they reach the tty', () => {
    ask('sess-a', 'sneaky[2Jbody');

    expect(lastWrite()).not.toContain('');
    expect(lastWrite()).not.toContain('');
    /*
      The printable tail survives, and should: this strips control characters,
      it does not parse escape sequences. With the ESC introducing it gone,
      `[2J` is four ordinary characters and addresses nothing.
    */
    expect(lastWrite()).toContain('sneaky[2Jbody');
  });

  /**
   * One nudge per idle window. The first write ends in `\r`, which starts a
   * turn — so writing the rest of the backlog behind it would be writing
   * mid-turn, the one thing this module must never do.
   */
  it('writes one nudge per idle window, not the whole backlog', () => {
    idle.delete('sess-a');
    ask('sess-a', 'first question');
    ask('sess-a', 'second question');
    expect(write).not.toHaveBeenCalled();

    idle.add('sess-a');
    deliver.onIdle('sess-a');

    expect(write).toHaveBeenCalledTimes(1);
    expect(lastWrite()).toContain('first question');

    // The remainder was not lost — it has no receipt, so the next idle takes it.
    deliver.onIdle('sess-a');
    expect(write).toHaveBeenCalledTimes(2);
    expect(lastWrite()).toContain('second question');
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
