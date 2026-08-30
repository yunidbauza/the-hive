import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LEDGER_KINDS, type LedgerEntry } from '@shared/ledger-contract';
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

/**
 * Is this parsed line actually an entry?
 *
 * `JSON.parse` succeeding proves the line is JSON, not that it is a ledger
 * entry: `null`, `123` and `"x"` all parse cleanly. Accepting one is not a
 * cosmetic wrong — the sequence reseed below reads `newest.id`, so a bare
 * number sorting last throws inside `createLedgerStore`, which is called from
 * `createLedger` inside `registerIpcHandlers()`, which is called unguarded at
 * startup. One hand-edited line in a file the user is *invited* to open would
 * boot the app with no IPC handlers at all; a `null` line survives
 * construction and throws later, in `openAsks`, on `entry.kind`.
 *
 * The five required fields are checked, and so are the three optional string
 * riders — absent or a string, never anything else. `ref` is the one that
 * bites: `nextRef` calls `entry.ref.startsWith(...)` on every loaded entry
 * each time an `ask` is appended, so a hand-edited `"ref": 3` reaches it and
 * throws. Since a write failure is now a refusal rather than a crash, the
 * symptom would be *every* ask coming back `500` until the user found and
 * fixed the line by hand — the same failure as a bad `id`, one field over, in
 * the same file the loader's own comment invites them to edit.
 *
 * `meta` is deliberately left unchecked. It is a free-form rider that every
 * consumer reads defensively (`taskOf` type-checks what it pulls out), so
 * rejecting a line for an odd `meta` would throw away correspondence this
 * loader exists to keep, and buy nothing.
 */
const isEntry = (value: unknown): value is LedgerEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const optionalString = (field: unknown): boolean =>
    field === undefined || typeof field === 'string';
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.ts === 'number' &&
    typeof candidate.from === 'string' &&
    typeof candidate.body === 'string' &&
    typeof candidate.kind === 'string' &&
    (LEDGER_KINDS as readonly string[]).includes(candidate.kind) &&
    optionalString(candidate.to) &&
    optionalString(candidate.ref) &&
    optionalString(candidate.thread)
  );
};

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
    const path = join(dir, `${day}.jsonl`);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (cause) {
      /*
        A missing file is the normal case and stays silent: most days have no
        yesterday file, and the first launch of a day has no today file.

        Anything else — EACCES, EIO, ENOTDIR — is a real failure, and treating
        it as "the day was empty" is the dangerous reading: the sequence
        reseed below would leave `seq` at 0 while the file on disk already
        holds ids for this second, so the next appends would mint ids that
        already exist. That is exactly the collision the reseed exists to
        prevent, so it is said out loud rather than swallowed. `append` cannot
        repair it, but it no longer throws either: a write that fails for the
        same reason comes back as a refusal (see `Ledger.append`).
      */
      const code = (cause as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT') {
        console.warn(
          `[hive] ledger: could not read ${path} (${code ?? 'unknown error'});` +
            ' its entries are not loaded and ids written this second may collide' +
            ' with what is already in that file',
        );
      }
      return;
    }
    let skipped = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        /*
          Kept, not thrown. A half-written final line — the app was killed
          mid-append — must not cost the user every entry before it.
        */
        bad.push(line);
        skipped += 1;
        continue;
      }
      // Parsing is not validating; see `isEntry`.
      if (!isEntry(parsed)) {
        bad.push(line);
        skipped += 1;
        continue;
      }
      entries.push(parsed);
    }
    /*
      Said out loud, once per file. `malformed()` is the programmatic record,
      but nothing in the app reads it: a log the user can open and `grep` is
      also one they can corrupt by hand, and silently dropping their line
      would leave them with a ledger that disagrees with the file and no clue
      why. The line itself is deliberately not logged — a ledger body is
      correspondence.
    */
    if (skipped > 0) {
      console.warn(
        `[hive] ledger: skipped ${skipped} unusable line(s) in ${path};` +
          ' the entries around them loaded normally',
      );
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
    /*
      Validated, because `isEntry` proves `id` is a string and nothing more.
      A hand-edited or foreign-format tail (`…-141530-x`) yields `NaN` here,
      and `pad(NaN, 4)` mints `20260828-141530-0NaN` — an id that is neither
      unique nor sortable, which breaks `since`, `resolveRef` and `thread` at
      once. Falling back to 0 risks one duplicate id in the worst case; NaN
      guarantees permanently broken ones.
    */
    const parsed = Number(newest.id.slice(currentStamp.length + 1));
    second = currentStamp;
    seq = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
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
