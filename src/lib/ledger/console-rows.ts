import type { TermColor, TermLine } from '@/types/terminal';

import type { LedgerEntry, LedgerKind } from '@shared/ledger-contract';

/**
 * How the console draws the ledger tail (HIVE-113).
 *
 * A module of its own rather than three more helpers in `hive-store.ts`, which
 * is already close to five thousand lines: none of this needs the store, all of
 * it is pure, and column arithmetic is exactly the kind of thing worth
 * asserting directly rather than through a store action.
 */

/*
  Column widths in monospace cells. The transcript is rendered by xterm with a
  fixed advance, so `padEnd` is genuine alignment here rather than an
  approximation — the same reason `status` pads to 16 and 18.
*/
const REF_W = 5;
const FROM_W = 17;
const TO_W = 12;
const KIND_W = 6;
const BODY_W = 38;

/**
 * One colour per row, because {@link TermLine} carries exactly one.
 *
 * `failed` is red on this design's own judgement — the ticket names only ask,
 * answer and post, and a failure rendered in the same green as a success would
 * be actively misleading. Everything unlisted is dim: `claim`, `release`,
 * `handoff` and `event` are bookkeeping, and a tail where everything is
 * coloured is a tail where nothing stands out.
 */
const COLOR_BY_KIND: Partial<Record<LedgerKind, TermColor>> = {
  ask: 'amber',
  answer: 'green',
  done: 'green',
  failed: 'red',
};

/**
 * A receipt written by `deliver.ts` recording that a nudge reached a terminal.
 *
 * Keyed on `meta.delivered` rather than on `kind === 'event'` deliberately:
 * HIVE-120 appends expiry events with the same kind, and a filter keyed on the
 * kind would fold those away too, silently, the day it lands.
 */
export function isDeliveryReceipt(entry: LedgerEntry): boolean {
  return entry.meta?.delivered !== undefined;
}

/** Coarse relative age. One unit, never two — this is a column, not a sentence. */
export function ageLabel(deltaMs: number): string {
  const seconds = Math.max(0, Math.floor(deltaMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Pad to `width`, truncating with an ellipsis.
 *
 * Content is capped one cell short of the column so there is always a gap: a
 * value that exactly filled its column would run into the next one, and the
 * table would read as a single word.
 */
function fit(text: string, width: number): string {
  /*
    Counted in code points, not UTF-16 units. `'📒'.length` is 2 and `'é'` can
    be 2 as well, so `String.length` and `padEnd` disagree about the same string
    — and a single emoji in a body or a party id would shift that row's columns
    out of line with every other row, which is the one thing this module exists
    to prevent. Not grapheme clusters: that needs `Intl.Segmenter` and a real
    east-asian-width table to be worth anything, and xterm's own advance is what
    ultimately decides. Code points fix the common case honestly.
  */
  const chars = [...text];
  const max = width - 1;
  const clipped = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
  return clipped.padEnd(width + (clipped.length - [...clipped].length));
}

function firstLine(body: string): string {
  return body.split('\n')[0] ?? '';
}

function row(entry: LedgerEntry, now: number): TermLine {
  return {
    text:
      '  ' +
      fit(entry.ref ?? '·', REF_W) +
      fit(entry.from, FROM_W) +
      fit(entry.to === undefined ? '→ all' : `→ ${entry.to}`, TO_W) +
      fit(entry.kind, KIND_W) +
      fit(firstLine(entry.body), BODY_W) +
      ageLabel(now - entry.ts),
    color: COLOR_BY_KIND[entry.kind] ?? 'dim',
  };
}

/**
 * The tail, as transcript lines.
 *
 * Receipts are filtered out *before* the limit is applied, so `-n 5` always
 * shows five real entries rather than five slots partly spent on bookkeeping.
 * The hidden count is then taken over the same window that was shown — ids sort
 * in write order, so "newer than the oldest row on screen" is a string
 * comparison — which keeps the footer's number about what the user is looking
 * at rather than about the whole log.
 */
export function ledgerRows(
  entries: readonly LedgerEntry[],
  opts: { now: number; showEvents: boolean; limit: number },
): TermLine[] {
  const visible = opts.showEvents ? [...entries] : entries.filter((e) => !isDeliveryReceipt(e));
  const tail = visible.slice(Math.max(0, visible.length - opts.limit));

  const rows = tail.map((entry) => row(entry, opts.now));
  if (rows.length === 0) return [{ text: '  no entries', color: 'dim' }];

  const oldestShown = tail[0]?.id;
  const hidden =
    opts.showEvents || oldestShown === undefined
      ? 0
      : entries.filter((e) => isDeliveryReceipt(e) && e.id >= oldestShown).length;

  if (hidden > 0) {
    rows.push({
      text: `  ${hidden} delivery event${hidden === 1 ? '' : 's'} hidden — ledger --events to show`,
      color: 'dim',
    });
  }

  return rows;
}
