import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type LedgerEntry } from '@shared/ledger-contract';
import { nextRef } from '@shared/ledger-derive';

/**
 * The one writer (HIVE-111).
 *
 * Append-only, and synchronous on purpose. `sessions/history.ts` debounces
 * because it rewrites a whole document and the last write wins; this file
 * *adds a line*, and a debounce here would mean an entry that a caller has
 * already been told the id of is not yet on disk. A ledger whose reader and
 * writer can disagree about what happened is not a ledger.
 */

export interface LedgerStoreOptions {
  dir: string;
  /** Overridable for tests. */
  now?: () => number;
}

export interface LedgerStore {
  all(): LedgerEntry[];
  append(entry: Omit<LedgerEntry, 'id' | 'ts' | 'ref'>): LedgerEntry;
  onChange(listener: (entry: LedgerEntry) => void): () => void;
  malformed(): readonly string[];
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `2026-08-28` — the file's name, in local time so "today" is the user's. */
const dayOf = (ms: number): string => {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};

/** `20260828-141530` — the id's leading two segments. */
const secondOf = (ms: number): string => {
  const at = new Date(ms);
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
};

/**
 * The previous calendar day, by date-component arithmetic rather than a fixed
 * 24h subtraction — a DST spring-forward day is only 23 real hours, so
 * subtracting exact milliseconds can land one calendar day too early and
 * silently drop yesterday's entries (still-open asks included) from load.
 */
const yesterdayOf = (ms: number): string => {
  const at = new Date(ms);
  const prev = new Date(at.getFullYear(), at.getMonth(), at.getDate() - 1);
  return dayOf(prev.getTime());
};

export function createLedgerStore(options: LedgerStoreOptions): LedgerStore {
  const { dir } = options;
  const now = options.now ?? Date.now;

  const entries: LedgerEntry[] = [];
  const bad: string[] = [];
  const listeners = new Set<(entry: LedgerEntry) => void>();

  /**
   * The per-second sequence.
   *
   * Two appends inside one second would otherwise produce the same id, and the
   * whole ordering guarantee — `since`, the sort, the "read forward" rule —
   * rests on ids being distinct and increasing.
   */
  let second = '';
  let seq = 0;

  const fileFor = (ms: number): string => join(dir, `${dayOf(ms)}.jsonl`);

  const load = (day: string): void => {
    let raw: string;
    try {
      raw = readFileSync(join(dir, `${day}.jsonl`), 'utf8');
    } catch {
      // No file for that day is the normal case, not an error.
      return;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        entries.push(JSON.parse(line) as LedgerEntry);
      } catch {
        /*
          Kept, not thrown. A half-written final line — the app was killed
          mid-append — must not cost the user every entry before it.
        */
        bad.push(line);
      }
    }
  };

  const at = now();
  load(yesterdayOf(at));
  load(dayOf(at));
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  /*
    Seed the sequence from what was already on disk. Without this, a process
    that appends at second S, exits, and restarts within that same
    wall-clock second would start counting from 0001 again and collide with
    what it just wrote.
  */
  const currentStamp = secondOf(at);
  const newest = entries[entries.length - 1];
  if (newest && newest.id.startsWith(`${currentStamp}-`)) {
    second = currentStamp;
    seq = Number(newest.id.slice(currentStamp.length + 1));
  }

  return {
    all: () => [...entries],

    append(input) {
      const ms = now();
      const stamp = secondOf(ms);
      if (stamp !== second) {
        second = stamp;
        seq = 0;
      }
      seq += 1;

      const stored: LedgerEntry = {
        ...input,
        id: `${stamp}-${pad(seq, 4)}`,
        ts: ms,
        ...(input.kind === 'ask' ? { ref: nextRef(entries) } : {}),
      };

      mkdirSync(dir, { recursive: true });
      appendFileSync(fileFor(ms), `${JSON.stringify(stored)}\n`, 'utf8');
      entries.push(stored);

      for (const listener of listeners) listener(stored);
      return stored;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    malformed: () => bad,
  };
}
