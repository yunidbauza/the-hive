// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { entryContext } from '../../../../electron/main/ledger/context';
import type { LedgerEntry } from '../../../../electron/shared/ledger-contract';

const ask: LedgerEntry = {
  id: '20260906-141530-0001',
  ts: 1,
  from: 'overmind',
  to: 'sess-a',
  kind: 'ask',
  ref: 'a12',
  body: 'first line\nsecond line with [31mcontrol[0m bytes\nthird line',
  meta: { intent: 'rebase onto it and push', ttlMs: 60000 },
};

const answer: LedgerEntry = {
  id: '20260906-141600-0003',
  ts: 2,
  from: 'pr-watcher',
  to: 'sess-a',
  kind: 'answer',
  thread: ask.id,
  body: 'yes, merged',
  meta: { pr: 190 },
};

describe('entryContext (HIVE-138)', () => {
  it("speaks as the app, names the marker, and says it is not the user's words", () => {
    const text = entryContext(ask);
    expect(text.startsWith('The Hive, the desktop app that runs this terminal session, delivered')).toBe(true);
    expect(text).toContain('"📒 a12"');
    expect(text).toContain('from the app, not from the user');
  });

  it('carries an ask whole: sender, ref, body verbatim, every meta key, the reply instruction', () => {
    const text = entryContext(ask);
    expect(text).toContain('From: overmind');
    expect(text).toContain('Kind: ask, ref a12, addressed to you');
    // Untruncated, unstripped, line breaks intact: the bytes go into JSON, not a pty.
    expect(text).toContain(ask.body);
    expect(text).toContain('Meta: {"intent":"rebase onto it and push","ttlMs":60000}');
    expect(text).toContain('ledger_answer');
    expect(text).toContain('thread "a12"');
    expect(text).toContain('reaches overmind');
    // A session without the tool is told what to do instead, not left to guess.
    expect(text).toContain('If that tool is not available');
  });

  it("carries an answer with the ask it closes and the asker's intent", () => {
    const text = entryContext(answer, ask);
    expect(text).toContain('"📒 20260906-141600-0003"');
    expect(text).toContain('From: pr-watcher');
    expect(text).toContain('Kind: answer, closing your ask a12');
    expect(text).toContain('yes, merged');
    expect(text).toContain('You asked so you could: rebase onto it and push');
    expect(text).toContain('Meta: {"pr":190}');
    expect(text).toContain('Nothing is owed back');
    expect(text).not.toContain('ledger_answer');
  });

  it('omits the intent line when the ask has none, and the meta line when there is none', () => {
    const bare = entryContext({ ...answer, meta: undefined }, { ...ask, meta: {} });
    expect(bare).not.toContain('You asked so you could');
    expect(bare).not.toContain('Meta:');

    const blank = entryContext(answer, { ...ask, meta: { intent: '   ' } });
    expect(blank).not.toContain('You asked so you could');
  });

  it("names an answer's thread by id when the ask is gone", () => {
    const text = entryContext(answer);
    expect(text).toContain(`closing your ask ${ask.id}`);
    expect(text).not.toContain('You asked so you could');
  });
});
