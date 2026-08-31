// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  LEDGER_ASK_TTL_MS,
  OVERMIND,
  type LedgerEntry,
} from '../../../electron/shared/ledger-contract';
import {
  claims,
  expiredAsks,
  keepNewest,
  matches,
  nextRef,
  openAsks,
  resolveRef,
  thread,
  ttlOf,
} from '../../../electron/shared/ledger-derive';

const NOW = 1_800_000_000_000;

const entry = (over: Partial<LedgerEntry> & Pick<LedgerEntry, 'id'>): LedgerEntry => ({
  ts: NOW,
  from: 'sess-a',
  kind: 'post',
  body: '',
  ...over,
});

describe('openAsks', () => {
  it('reports an unanswered ask as open, with its age', () => {
    const entries = [entry({ id: '20260828-100000-0001', kind: 'ask', ts: NOW - 60_000 })];

    expect(openAsks(entries, NOW)).toEqual([
      { ...entries[0], open: true, ageMs: 60_000 },
    ]);
  });

  it('closes an ask once an answer names its thread', () => {
    const entries = [
      entry({ id: '20260828-100000-0001', kind: 'ask' }),
      entry({ id: '20260828-100001-0001', kind: 'answer', thread: '20260828-100000-0001' }),
    ];

    expect(openAsks(entries, NOW)).toEqual([]);
  });

  /**
   * HIVE-118 self-review, findings 2 and 6. `done` and `failed` both take a
   * `thread` — `ledger-tools.ts` calls them "the ask this completes" and "the
   * ask this abandons" — and neither closed the ask here.
   *
   * The `done` half was visible: `notify.ts` dismissed the card while this
   * function kept the ask open, so the left rail's Agents badge — counted off
   * the ledger, immune to notification state — stayed lit with nothing behind
   * it. The `failed` half was the mirror image: the card stayed, offering
   * buttons `Ledger.append` would refuse.
   */
  it.each(['done', 'failed'] as const)(
    'closes an ask when a %s names its thread, exactly as an answer does',
    (kind) => {
      const entries = [
        entry({ id: '20260828-100000-0001', kind: 'ask' }),
        entry({ id: '20260828-100001-0001', kind, thread: '20260828-100000-0001' }),
      ];

      expect(openAsks(entries, NOW)).toEqual([]);
    },
  );

  /**
   * A `done` or `failed` with no thread is an agent reporting on its wake, not
   * on a question. It must leave every open ask exactly where it was.
   */
  it.each(['done', 'failed'] as const)(
    'leaves an unrelated ask open when a threadless %s lands',
    (kind) => {
      const ask = entry({ id: '20260828-100000-0001', kind: 'ask', ts: NOW - 60_000 });
      const entries = [ask, entry({ id: '20260828-100001-0001', kind })];

      expect(openAsks(entries, NOW)).toEqual([{ ...ask, open: true, ageMs: 60_000 }]);
    },
  );

  it('expires an ask older than the TTL even with no answer', () => {
    const entries = [
      entry({ id: '20260827-100000-0001', kind: 'ask', ts: NOW - LEDGER_ASK_TTL_MS - 1 }),
    ];

    expect(openAsks(entries, NOW)).toEqual([]);
  });

  it('ignores non-ask kinds', () => {
    const entries = [entry({ id: '20260828-100000-0001', kind: 'done' })];

    expect(openAsks(entries, NOW)).toEqual([]);
  });
});

describe('claims', () => {
  it('gives a task to the latest claim without a later release', () => {
    const entries = [
      entry({ id: '1', kind: 'claim', from: 'sess-a', meta: { task: 'HIVE-9' } }),
      entry({ id: '2', kind: 'claim', from: 'sess-b', meta: { task: 'HIVE-8' } }),
    ];

    expect(claims(entries)).toEqual({ 'HIVE-9': 'sess-a', 'HIVE-8': 'sess-b' });
  });

  it('drops a claim once released', () => {
    const entries = [
      entry({ id: '1', kind: 'claim', from: 'sess-a', meta: { task: 'HIVE-9' } }),
      entry({ id: '2', kind: 'release', from: 'sess-a', meta: { task: 'HIVE-9' } }),
    ];

    expect(claims(entries)).toEqual({});
  });

  it('lets a later claim take a released task', () => {
    const entries = [
      entry({ id: '1', kind: 'claim', from: 'sess-a', meta: { task: 'HIVE-9' } }),
      entry({ id: '2', kind: 'release', from: 'sess-a', meta: { task: 'HIVE-9' } }),
      entry({ id: '3', kind: 'claim', from: 'sess-b', meta: { task: 'HIVE-9' } }),
    ];

    expect(claims(entries)).toEqual({ 'HIVE-9': 'sess-b' });
  });

  it('ignores a claim with no task in meta', () => {
    expect(claims([entry({ id: '1', kind: 'claim' })])).toEqual({});
  });
});

describe('thread', () => {
  it('returns the ask and everything naming it, in order', () => {
    const entries = [
      entry({ id: 'a', kind: 'ask' }),
      entry({ id: 'b', kind: 'post' }),
      entry({ id: 'c', kind: 'answer', thread: 'a' }),
    ];

    expect(thread(entries, 'a').map((found) => found.id)).toEqual(['a', 'c']);
  });
});

describe('matches', () => {
  const subject = entry({
    id: '20260828-100000-0001',
    from: 'sess-a',
    to: 'sess-b',
    kind: 'ask',
    thread: 't1',
  });

  it('matches an empty query', () => {
    expect(matches(subject, {})).toBe(true);
  });

  it('filters on from, kind and thread', () => {
    expect(matches(subject, { from: 'sess-a' })).toBe(true);
    expect(matches(subject, { from: 'sess-z' })).toBe(false);
    expect(matches(subject, { kind: 'ask' })).toBe(true);
    expect(matches(subject, { kind: 'post' })).toBe(false);
    expect(matches(subject, { thread: 't1' })).toBe(true);
    expect(matches(subject, { thread: 't2' })).toBe(false);
  });

  /**
   * "The conversation" has to mean the same thing here as it does in
   * `thread()` above, which includes the ask. Matching only `entry.thread`
   * gave one contract two definitions: a read for `thread: <askId>` came back
   * with every reply and not the question they were replying to.
   */
  it('counts the ask itself as part of its own thread', () => {
    expect(matches(subject, { thread: subject.id })).toBe(true);

    const reply = entry({ id: 'reply', thread: subject.id });
    expect(matches(reply, { thread: subject.id })).toBe(true);

    const unrelated = entry({ id: 'other', thread: undefined });
    expect(matches(unrelated, { thread: subject.id })).toBe(false);
  });

  it('treats `to` as "addressed to me, or broadcast"', () => {
    expect(matches(subject, { to: 'sess-b' })).toBe(true);
    expect(matches(subject, { to: 'sess-c' })).toBe(false);

    const broadcast = entry({ id: '2', to: undefined });
    expect(matches(broadcast, { to: 'sess-c' })).toBe(true);
  });

  it('treats `since` as an exclusive lower bound on the id', () => {
    expect(matches(subject, { since: '20260828-095959-0001' })).toBe(true);
    expect(matches(subject, { since: '20260828-100000-0001' })).toBe(false);
    expect(matches(subject, { since: '20260828-100001-0001' })).toBe(false);
  });
});

describe('resolveRef', () => {
  const entries = [entry({ id: '20260828-100000-0001', kind: 'ask', ref: 'a7' })];

  it('resolves a short ref to the canonical id', () => {
    expect(resolveRef(entries, 'a7')).toBe('20260828-100000-0001');
  });

  it('passes a canonical id straight through', () => {
    expect(resolveRef(entries, '20260828-100000-0001')).toBe('20260828-100000-0001');
  });

  it('returns undefined for anything it does not know', () => {
    expect(resolveRef(entries, 'a9')).toBeUndefined();
  });
});

describe('keepNewest', () => {
  const entries = [
    entry({ id: '1', body: 'one' }),
    entry({ id: '2', body: 'two' }),
    entry({ id: '3', body: 'three' }),
  ];

  it('returns everything when no limit is given', () => {
    expect(keepNewest(entries, undefined)).toEqual(entries);
  });

  it('keeps the newest `limit` entries', () => {
    expect(keepNewest(entries, 2).map((e) => e.body)).toEqual(['two', 'three']);
  });

  /**
   * `slice(-0)` is `slice(0)` — a whole copy — so the narrowest request a
   * caller can make used to return the widest possible answer. `0` is not an
   * exotic input: `parseLedgerReadQuery` explicitly admits it, so
   * `{"limit": 0}` returned the entire log over both the HTTP and IPC paths.
   */
  it('returns nothing, not everything, for a limit of zero', () => {
    expect(keepNewest(entries, 0)).toEqual([]);
  });

  it('returns everything when the limit is larger than the log', () => {
    expect(keepNewest(entries, 10)).toEqual(entries);
  });
});

describe('nextRef', () => {
  it('starts at a1 on an empty log', () => {
    expect(nextRef([])).toBe('a1');
  });

  it('takes the highest existing ref and adds one', () => {
    const entries = [
      entry({ id: '1', kind: 'ask', ref: 'a3' }),
      entry({ id: '2', kind: 'ask', ref: 'a11' }),
    ];

    expect(nextRef(entries)).toBe('a12');
  });

  it('ignores entries with no ref', () => {
    expect(nextRef([entry({ id: '1', kind: 'post' })])).toBe('a1');
  });
});

describe('ttlOf', () => {
  it('is the constant when no meta.ttlMs is given', () => {
    expect(ttlOf({})).toBe(LEDGER_ASK_TTL_MS);
    expect(ttlOf({ meta: {} })).toBe(LEDGER_ASK_TTL_MS);
  });

  it('honours a shorter meta.ttlMs', () => {
    expect(ttlOf({ meta: { ttlMs: 60_000 } })).toBe(60_000);
  });

  it('clamps a longer one to the constant', () => {
    // An agent may shorten its own ask; it may not outlive the log's own rule.
    expect(ttlOf({ meta: { ttlMs: LEDGER_ASK_TTL_MS * 2 } })).toBe(LEDGER_ASK_TTL_MS);
  });

  it('ignores a ttlMs that is not a positive finite number', () => {
    const bad: unknown[] = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5m', null];

    for (const ttlMs of bad) {
      expect(ttlOf({ meta: { ttlMs } })).toBe(LEDGER_ASK_TTL_MS);
    }
  });
});

describe('expiredAsks', () => {
  const ask = (over: Partial<LedgerEntry> = {}): LedgerEntry =>
    entry({ id: 'a1', kind: 'ask', ts: 0, from: 'pr-reviewer', to: 'overmind', ...over });

  it('is empty while the ask is inside its ttl', () => {
    expect(expiredAsks([ask()], LEDGER_ASK_TTL_MS - 1)).toEqual([]);
  });

  it('names an ask that has crossed its ttl', () => {
    expect(expiredAsks([ask()], LEDGER_ASK_TTL_MS).map((found) => found.id)).toEqual([
      'a1',
    ]);
  });

  it('uses the ask own meta.ttlMs', () => {
    expect(expiredAsks([ask({ meta: { ttlMs: 1_000 } })], 1_000)).toHaveLength(1);
  });

  it('ignores an ask something already closed', () => {
    const answer = entry({ id: 'x1', ts: 5, kind: 'answer', thread: 'a1' });

    expect(expiredAsks([ask(), answer], LEDGER_ASK_TTL_MS)).toEqual([]);
  });

  it('ignores an ask that already has its expiry event — the sweep is idempotent', () => {
    const expiry = entry({
      id: 'e1',
      ts: 5,
      from: OVERMIND,
      kind: 'event',
      thread: 'a1',
      meta: { expired: 'a1' },
    });

    expect(expiredAsks([ask(), expiry], LEDGER_ASK_TTL_MS)).toEqual([]);
  });

  it('ignores kinds that are not asks', () => {
    expect(expiredAsks([ask({ kind: 'post' })], LEDGER_ASK_TTL_MS)).toEqual([]);
  });

  it('only lets the overmind retire an ask', () => {
    /*
      `meta` is a free-form rider any writer controls, so a forged marker would
      otherwise put an id in the "already told" set permanently — retiring a
      question nobody answered, with no expiry event ever written for it.
    */
    const forged = entry({
      id: 'e2',
      ts: 5,
      from: 'sess-9',
      kind: 'event',
      thread: 'a1',
      meta: { expired: 'a1' },
    });

    expect(expiredAsks([ask(), forged], LEDGER_ASK_TTL_MS)).toHaveLength(1);
  });
});
