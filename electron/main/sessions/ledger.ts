import { readFileSync, writeFileSync } from 'node:fs';

import {
  HISTORY_CAP,
  type SessionRecord,
} from '@shared/session-history-contract';

/**
 * What the fleet looked like last time (HIVE-87).
 *
 * Main authors this, not the renderer, because main already owns spawn and exit
 * and is the only side that knows two of the fields worth keeping: the
 * `sessionUuid` it pins as `claude --session-id`, and the branch and cwd that
 * `publishBranch` reads with `git rev-parse`. It also outlives a renderer
 * crash. The store's own note says the same thing from the other end — its
 * actions "mirror what the future orchestrator daemon will do, so panels stay
 * pure views".
 *
 * ## Why this is lenient, and deliberately not durable
 *
 * The write is a plain `writeFileSync` in a `try`, and the read swallows every
 * corruption case. That follows `window-state.ts` rather than
 * `config/write.ts`, which has the real temp-file/`fsync`/rename discipline —
 * and the choice is not an oversight.
 *
 * A config write that half-lands costs the user settings they typed. A ledger
 * write that half-lands costs them the last few seconds of a history that is,
 * by construction, a record of things that are already over. Set against that,
 * the failure mode of the durable path is that a ledger can refuse, throw, or
 * block on `fsync` at exactly the two moments this module runs: app start and
 * app quit. A history feature that can stop the app opening is a far worse bug
 * than one that can lose a page.
 *
 * ## Why nothing here ever writes `closed`
 *
 * Because nothing here can observe it. `runShutdown()` invokes every hook body
 * synchronously and then awaits them together, so a flush registered there
 * *races* the pty teardown rather than following it — and a crash, a SIGKILL or
 * a power loss writes nothing at all. So the ledger stores the last status it
 * was told about, and the renderer infers `closed` at hydrate: a record
 * claiming to be `working` plainly is not. That inference cannot be raced,
 * cannot be interrupted, and needs no quit-time write to be correct.
 */

/**
 * How long to coalesce writes.
 *
 * The same 400ms `window.ts` uses for geometry, and for the same reason: a
 * session that is working emits status, branch and title updates in bursts, and
 * one file write per event would be a write per keystroke-ish. `flush()` is the
 * synchronous escape hatch for shutdown.
 */
const PERSIST_DEBOUNCE_MS = 400;

/** A patch is any part of a record except the identity, which is the key. */
export type SessionPatch = Partial<Omit<SessionRecord, 'id'>>;

export interface SessionLedger {
  /**
   * Merge a fragment into this session's record, creating it if new.
   *
   * Every call site knows a different part of the story — spawn has the uuid
   * and the project, `publishBranch` has the branch, `settleExit` has the
   * ending — so this merges rather than replaces. A field the caller does not
   * mention is left alone.
   */
  record(id: string, patch: SessionPatch): void;
  /** Everything held, ready to answer `session:history`. */
  all(): SessionRecord[];
  /** Write now, synchronously. Safe to call when nothing is pending. */
  flush(): void;
  /**
   * Drop a pending write without performing it.
   *
   * Test-only in practice, and it has to exist rather than being implied by
   * dropping the reference: `schedule()`'s timer closes over `write()`
   * directly, so a ledger nobody holds any more still fires one last
   * `writeFileSync` at whatever path it was built with. In a suite that stubs
   * `app.getPath`, that is a file left behind — or the next test's ledger
   * clobbered at the same path.
   */
  dispose(): void;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * One record, revalidated on the way in.
 *
 * Field by field rather than all-or-nothing, in both directions: a row missing
 * a *required* field is dropped whole, because a record with no id cannot be
 * merged and one with no `createdAt` cannot be sorted for retention. But a
 * *optional* field of the wrong type only costs that field. The file may have
 * been written by an older build, and throwing away nineteen good rows because
 * the twentieth grew a number where a string belongs is the failure this shape
 * exists to avoid.
 */
function reviveRecord(raw: unknown): SessionRecord | undefined {
  if (!isObject(raw)) return undefined;

  const id = text(raw.id);
  const project = text(raw.project);
  const task = text(raw.task);
  const status = text(raw.status);
  const createdAt = finite(raw.createdAt);
  if (
    id === undefined ||
    project === undefined ||
    task === undefined ||
    status === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }

  const optional = {
    name: text(raw.name),
    ticket: text(raw.ticket),
    branch: text(raw.branch),
    cwd: text(raw.cwd),
    sessionUuid: text(raw.sessionUuid),
    endedAt: finite(raw.endedAt),
    /*
      `model` and `effort` are closed lists on the renderer side, and this does
      not re-check them against those lists: an unknown value is dropped by the
      store's own hydrate guard, and duplicating the list here would be a second
      copy to keep in step with `session-contract.ts`.
    */
    model: text(raw.model) as SessionRecord['model'],
    effort: text(raw.effort) as SessionRecord['effort'],
  };

  return {
    id,
    project,
    task,
    status,
    createdAt,
    // Spread only what is present: an explicit `undefined` key survives
    // `JSON.stringify` as an absent one anyway, but it changes object identity
    // in tests and reads as "known to be nothing" rather than "never set".
    ...Object.fromEntries(
      Object.entries(optional).filter(([, value]) => value !== undefined),
    ),
  } as SessionRecord;
}

/**
 * Read the ledger, or an empty one.
 *
 * Never throws, and never reports. A missing file is the normal first-launch
 * state; an unreadable one is indistinguishable from it as far as the caller is
 * concerned, and there is nothing the app could usefully do about either.
 */
export function readLedger(path: string): SessionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const records: SessionRecord[] = [];
  for (const raw of parsed) {
    const record = reviveRecord(raw);
    if (record !== undefined) records.push(record);
  }
  return records;
}

/** The statuses that mean a session is still going. */
const LIVE_STATUSES = new Set(['working', 'waiting', 'idle']);

/** Whether this record describes something that is over. */
const hasEnded = (record: SessionRecord): boolean =>
  record.endedAt !== undefined ||
  record.status === 'done' ||
  record.status === 'terminated';

/**
 * Drop the oldest endings past the cap.
 *
 * Live records are exempt and are not counted against it. A fleet of thirteen
 * is thirteen records however full the history is, because capping a live
 * session would mean forgetting a process that still exists — a different and
 * much worse bug than forgetting one that does not.
 *
 * Oldest by `endedAt`, falling back to `createdAt` for a record that ended
 * without a timestamp. Sorting on a missing field would put every such record
 * at one extreme, which is how a cap comes to delete the wrong twenty.
 */
function prune(records: SessionRecord[]): SessionRecord[] {
  const live = records.filter((record) => !hasEnded(record));
  const ended = records
    .filter(hasEnded)
    .sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt));

  return [...live, ...ended.slice(Math.max(0, ended.length - HISTORY_CAP))];
}

export function createSessionLedger(
  path: string,
  /** Injected for the same reason `newSessionUuid` is: a real clock makes the file unassertable. */
  now: () => number = Date.now,
): SessionLedger {
  /**
   * Seeded from the file, **not empty**.
   *
   * This is the whole point of the ledger surviving a launch, and leaving it out
   * is not a missing feature so much as an actively destructive one: an empty
   * ledger answers `session:history` with nothing *and* then writes that nothing
   * back over the file at the next debounce, so the second launch after any
   * session silently erases the first launch's history.
   *
   * That is exactly what shipped in the first draft of this module, and no unit
   * test noticed — each one built a fresh ledger over a fresh temp file, which
   * is the one arrangement in which the bug is invisible. `session-history.spec.ts`
   * caught it by quitting a real app and starting it again.
   *
   * ## Everything loaded is over, and is stamped so
   *
   * A record read from disk cannot describe a running process: the process died
   * with the app that wrote it. Most arrive already ended, because `settleExit`
   * saw them go — but a session that was live at the quit, or one lost to a
   * crash, is still on file as `working` with no `endedAt`.
   *
   * Left alone, `hasEnded` reads those as live and **exempts them from the cap
   * forever**, so every crashy launch adds records nothing is allowed to
   * remove. That is the unbounded growth this whole feature was shaped to
   * avoid, reappearing in the file instead of the table.
   *
   * `createdAt` is used as the ending timestamp rather than "now": retention
   * already sorts on `endedAt ?? createdAt`, so it changes no ordering, and it
   * does not relabel an old record as freshly ended on every launch. The
   * *status* is untouched — the renderer still needs to see `working` to infer
   * `closed`.
   */
  const records = new Map(
    readLedger(path).map((record) => {
      const stamped: SessionRecord =
        record.endedAt === undefined
          ? { ...record, endedAt: record.createdAt }
          : record;
      return [record.id, stamped] as const;
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;

  const write = (): void => {
    const kept = prune([...records.values()]);
    // Rebuild the map from what survived, so a pruned record does not come back
    // on the next write and so `all()` and the file cannot disagree.
    records.clear();
    for (const record of kept) records.set(record.id, record);

    try {
      writeFileSync(path, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
    } catch (cause) {
      // Logged, never thrown. See the module comment: this must not be able to
      // stop the app quitting.
      console.error('[hive] could not save session history:', cause);
    }
  };

  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      write();
    }, PERSIST_DEBOUNCE_MS);
    // Never hold the process open for a history write.
    timer.unref?.();
  };

  return {
    record(id, patch) {
      const existing = records.get(id);
      if (existing === undefined) {
        records.set(id, {
          id,
          project: '',
          task: '',
          status: 'working',
          createdAt: now(),
          ...patch,
        });
      } else {
        const merged: SessionRecord = {
          ...existing,
          ...patch,
          // `createdAt` is deliberately not overwritable: it is the first thing
          // anyone knew about this session, and retention sorts on it.
          createdAt: existing.createdAt,
        };
        /**
         * A patch that brings a session back to life clears its ending.
         *
         * `restartOnce` kills the pty, waits for the exit — which records
         * `terminated` **with** an `endedAt` — and then spawns the same entity
         * id again. Without this, the merged record reads `working` while still
         * carrying the previous generation's `endedAt`, and `hasEnded` keys off
         * that timestamp: a session that is genuinely running is filed as ended,
         * counted against the cap it is supposed to be exempt from, and can be
         * pruned out from under itself. The next patch for it — a title, say —
         * then creates a *fresh* record with no project, no task and no uuid.
         */
        if (
          patch.status !== undefined &&
          LIVE_STATUSES.has(patch.status) &&
          patch.endedAt === undefined
        ) {
          delete merged.endedAt;
        }
        records.set(id, merged);
      }
      schedule();
    },

    all: () => prune([...records.values()]),

    flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      write();
    },

    dispose() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
