import { describe, expect, it } from 'vitest';

import { ageLabel, isDeliveryReceipt, ledgerRows } from '@lib/ledger/console-rows';
import type { LedgerEntry } from '@shared/ledger-contract';

/**
 * How the console draws the ledger tail (HIVE-113).
 *
 * Worth asserting directly rather than through a store action: this is column
 * arithmetic, and the failure mode — one row's column starting three cells
 * right of its neighbour's — is invisible to a test that only checks the text
 * is present somewhere.
 */

const NOW = new Date(2026, 7, 29, 12, 0, 0).getTime();

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: '20260829-115800-0001',
  ts: NOW - 120_000,
  from: 'sess-a',
  to: 'overmind',
  kind: 'ask',
  body: 'which branch should the demo use?',
  ...over,
});

describe('ageLabel', () => {
  it.each([
    [0, '0s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [59 * 60_000, '59m'],
    [60 * 60_000, '1h'],
    [23 * 60 * 60_000, '23h'],
    [24 * 60 * 60_000, '1d'],
  ])('renders %ims as %s', (delta, expected) => {
    expect(ageLabel(delta)).toBe(expected);
  });

  it('never reports a negative age', () => {
    // A clock that moved backwards is not worth a `-3s` in a column.
    expect(ageLabel(-5_000)).toBe('0s');
  });
});

describe('isDeliveryReceipt', () => {
  it('is true only when meta.delivered names an entry', () => {
    expect(isDeliveryReceipt(entry({ kind: 'event', meta: { delivered: 'x' } }))).toBe(true);
    // HIVE-120's expiry events share the kind and must not be folded away.
    expect(isDeliveryReceipt(entry({ kind: 'event', meta: { expired: 'x' } }))).toBe(false);
    expect(isDeliveryReceipt(entry())).toBe(false);
  });
});

describe('ledgerRows', () => {
  it('colours each row by kind', () => {
    const rows = ledgerRows(
      [
        entry({ id: 'a', kind: 'ask', ref: 'a12' }),
        entry({ id: 'b', kind: 'answer' }),
        entry({ id: 'c', kind: 'post' }),
        entry({ id: 'd', kind: 'failed' }),
      ],
      { now: NOW, showEvents: false, limit: 20 },
    );

    expect(rows.map((row) => row.color)).toEqual(['amber', 'green', 'dim', 'red']);
  });

  it('aligns every column to the same width', () => {
    const rows = ledgerRows(
      [
        entry({ id: 'a', ref: 'a12', from: 'sess-a' }),
        entry({ id: 'b', ref: 'a3', from: 'a-much-longer-session-id' }),
      ],
      { now: NOW, showEvents: false, limit: 20 },
    );

    expect(rows[0].text.indexOf('ask')).toBe(rows[1].text.indexOf('ask'));
  });

  it('prints a dot for an entry with no ref', () => {
    const [row] = ledgerRows([entry({ kind: 'post' })], {
      now: NOW,
      showEvents: false,
      limit: 20,
    });

    expect(row.text.startsWith('  ·')).toBe(true);
  });

  it('renders an absent recipient as a broadcast', () => {
    const [row] = ledgerRows([entry({ to: undefined, kind: 'post' })], {
      now: NOW,
      showEvents: false,
      limit: 20,
    });

    expect(row.text).toContain('→ all');
  });

  it('truncates a long body and keeps a gap before the age', () => {
    const [row] = ledgerRows([entry({ body: 'x'.repeat(200) })], {
      now: NOW,
      showEvents: false,
      limit: 20,
    });

    expect(row.text).toContain('…');
    expect(row.text).toMatch(/… +2m$/u);
  });

  it('keeps a gap even when a value exactly fills its column', () => {
    // 17 characters — exactly the `from` column's width.
    const [row] = ledgerRows([entry({ from: 'x'.repeat(17), ref: 'a1' })], {
      now: NOW,
      showEvents: false,
      limit: 20,
    });

    expect(row.text).not.toContain('xask');
  });

  it('shows only the first line of a multi-line body', () => {
    const [row] = ledgerRows([entry({ body: 'first line\nsecond line' })], {
      now: NOW,
      showEvents: false,
      limit: 20,
    });

    expect(row.text).toContain('first line');
    expect(row.text).not.toContain('second line');
  });

  it('hides delivery receipts and says how many', () => {
    const rows = ledgerRows(
      [
        entry({ id: '1', kind: 'ask', ref: 'a1' }),
        entry({ id: '2', kind: 'event', meta: { delivered: '1' } }),
        entry({ id: '3', kind: 'answer' }),
      ],
      { now: NOW, showEvents: false, limit: 20 },
    );

    expect(rows).toHaveLength(3);
    expect(rows[2].text).toContain('1 delivery event hidden');
    expect(rows[2].text).toContain('ledger --events');
  });

  it('shows receipts and no footer when asked', () => {
    const rows = ledgerRows(
      [
        entry({ id: '1', kind: 'ask', ref: 'a1' }),
        entry({ id: '2', kind: 'event', meta: { delivered: '1' } }),
      ],
      { now: NOW, showEvents: true, limit: 20 },
    );

    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.text.includes('hidden'))).toBe(false);
  });

  it('spends the limit on real entries rather than on bookkeeping', () => {
    /*
      Receipts are filtered before the limit, so `-n 2` shows two entries a
      person wrote — not two slots partly spent on delivery events.
    */
    const rows = ledgerRows(
      [
        entry({ id: '1', body: 'oldest' }),
        entry({ id: '2', kind: 'event', meta: { delivered: '1' } }),
        entry({ id: '3', body: 'newest' }),
      ],
      { now: NOW, showEvents: false, limit: 2 },
    );

    expect(rows[0].text).toContain('oldest');
    expect(rows[1].text).toContain('newest');
  });

  it('keeps the newest entries when over the limit', () => {
    const rows = ledgerRows(
      [
        entry({ id: '1', body: 'oldest' }),
        entry({ id: '2', body: 'middle' }),
        entry({ id: '3', body: 'newest' }),
      ],
      { now: NOW, showEvents: false, limit: 2 },
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].text).toContain('middle');
    expect(rows[1].text).toContain('newest');
  });

  it('counts only the receipts inside the window it showed', () => {
    /*
      Ids sort in write order, so the footer's number is about what is on
      screen rather than about the whole log — a tail of five should not
      report four hundred hidden events from last week.
    */
    const rows = ledgerRows(
      [
        entry({ id: '1', kind: 'event', meta: { delivered: 'x' } }),
        entry({ id: '2', body: 'older' }),
        entry({ id: '3', kind: 'event', meta: { delivered: 'y' } }),
        entry({ id: '4', body: 'newer' }),
      ],
      { now: NOW, showEvents: false, limit: 2 },
    );

    // Receipt `3` sits inside the shown window and is counted; receipt `1`
    // predates the oldest row on screen and is not.
    expect(rows[0].text).toContain('older');
    expect(rows[1].text).toContain('newer');
    expect(rows[2].text).toContain('1 delivery event hidden');
  });

  it('reports nothing hidden when every receipt predates the window', () => {
    const rows = ledgerRows(
      [
        entry({ id: '1', kind: 'event', meta: { delivered: 'x' } }),
        entry({ id: '2', body: 'older' }),
        entry({ id: '3', body: 'newer' }),
      ],
      { now: NOW, showEvents: false, limit: 1 },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain('newer');
  });

  it('says so when there is nothing to print', () => {
    expect(ledgerRows([], { now: NOW, showEvents: false, limit: 20 })).toEqual([
      { text: '  no entries', color: 'dim' },
    ]);
  });
});
