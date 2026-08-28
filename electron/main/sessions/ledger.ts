import { readFileSync, writeFileSync } from 'node:fs';

import { hiveNameFromTitle } from '@shared/session-contract';
import {
  HISTORY_CAP,
  type SessionRecord,
} from '@shared/session-history-contract';

import { nameFromTitle } from './title';

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
 * ## Why nothing here ever records an app close
 *
 * Because nothing here can observe it. `runShutdown()` invokes every hook body
 * synchronously and then awaits them together, so a flush registered there
 * *races* the pty teardown rather than following it — and a crash, a SIGKILL or
 * a power loss writes nothing at all. So the ledger stores the last status it
 * was told about, and the renderer infers the ending at hydrate: a record
 * claiming to be `working` plainly is not, and becomes `done` with
 * `endedBy: 'app-closed'`. That inference cannot be raced, cannot be
 * interrupted, and needs no quit-time write to be correct.
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

export interface BeginOptions {
  /**
   * This `begin` continues a previous run's conversation under its own id
   * (HIVE-88), so the record is kept the way a restart keeps it — ticket,
   * branch, cwd, `createdAt` — rather than started over. Only honoured when
   * {@link SessionLedger.resumable} would have answered for the id: a record
   * this run began is a restart whether or not the flag is set, and one with
   * nothing to resume is a new session whatever the caller believed.
   */
  resume?: boolean;
}

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
  /**
   * Start a session's record over, discarding anything held under that id.
   *
   * Entity ids are **reused across a restart**, so the ledger's `sess-01` and a
   * freshly spawned `sess-01` are different sessions wearing the same name. The
   * renderer already knows this — `hydrateSessions` refuses to let a restored
   * row overwrite a live one — and this is main acting on the same fact.
   *
   * Merging instead was silent corruption rather than a lost field: the new
   * session inherited the old one's `branch`, `cwd`, `ticket` and `name`,
   * because a spawn patch does not mention them, and kept the old `createdAt`,
   * which is what retention sorts on. A launch later, that row restored
   * advertising a branch and a ticket belonging to a session it never was.
   */
  begin(id: string, patch: SessionPatch, options?: BeginOptions): void;
  /**
   * The conversation a previous run left under this id, if it can be picked
   * up again (HIVE-88).
   *
   * A uuid, or nothing. Nothing for an id this run has already started — that
   * record is this run's, and resuming it would hand a fresh session last
   * run's conversation — and nothing for a record written before uuids were
   * kept, which names no transcript to resume.
   */
  resumable(id: string): string | undefined;
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
 * A stored name, re-cleaned with **today's** rule rather than the one that was
 * in force when it was written.
 *
 * The ledger holds whatever `title.ts` reported, and `title.ts` has been wrong
 * twice about which glyphs Claude puts in front of a name — most recently the
 * `◐`/`◑` spinner, which fixing the reader alone does not remove from the rows
 * already on disk. Those are exactly the rows PREVIOUS RUN shows at launch, so
 * without this the reported defect stays on screen until they age out of a
 * 40-record history.
 *
 * Idempotent by construction: it is the same function the reader applies, so a
 * name written by a fixed build passes through untouched. An entry that cleans
 * away to nothing — a legacy `Claude Code`, which is the *absence* of a name
 * spelled out — becomes `undefined`, the same thing `reviveRecord` stores for a
 * record that never had one.
 */
const cleanName = (value: unknown): string | undefined => {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const name = nameFromTitle(raw);
  return name === '' ? undefined : name;
};

/**
 * A remembered pull request, revalidated on the way in.
 *
 * All three fields or nothing, unlike the flat optionals beside it: `number`
 * without a `url` renders a `#123` that links nowhere, and a `url` without a
 * `number` has nothing to render at all. There is no partially-useful version
 * of this field, so a malformed one is dropped whole — the same field-by-field
 * leniency {@link reviveRecord} applies, at the granularity where it means
 * something.
 *
 * The `url` is **not** scheme-checked here. It was when it crossed the bridge
 * (`parseSessionPrRequest`), and this file's posture is that a value on disk is
 * re-typed rather than re-authorised — the renderer resolves it against its own
 * CSP before it becomes an `href`.
 */
const prRecord = (value: unknown): SessionRecord['pr'] => {
  if (!isObject(value)) return undefined;
  const number = finite(value.number);
  const repo = text(value.repo);
  const url = text(value.url);
  if (number === undefined || repo === undefined || url === undefined) {
    return undefined;
  }
  return { number, repo, url };
};

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
    name: cleanName(raw.name),
    /*
      `true` or nothing, never `false` (HIVE-107). The flag is only ever read as
      "is this name the app's own", so a stored `false` would be a second
      spelling of absent — and the record's own optionals are spread on
      presence, which would make the two objects differ for no reason a reader
      could see.
    */
    namePinned: raw.namePinned === true ? (true as const) : undefined,
    ticket: text(raw.ticket),
    branch: text(raw.branch),
    cwd: text(raw.cwd),
    sessionUuid: text(raw.sessionUuid),
    pr: prRecord(raw.pr),
    ...(raw.endedBy === 'finished' ? { endedBy: 'finished' as const } : {}),
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
   * The timestamp is **now**, not `createdAt`, and the difference decides which
   * record the cap eats first.
   *
   * `createdAt` looks safer — retention already falls back to it — but that only
   * held while these records were outside the ended bucket entirely. Once they
   * are in it, `endedAt` has to mean *when did this stop*, and a session's spawn
   * time is the wrong answer in the worst possible direction: a session opened
   * at 09:00 and worked in all day sorts below twenty throwaways that ended at
   * lunchtime, so it is evicted first and the one row the user actually wants to
   * see is the one PREVIOUS RUN loses. Stamping at load ranks it as the most
   * recent ending, which is what it is.
   *
   * Nothing is relabelled on a later launch: the stamp only lands where
   * `endedAt` is absent, so a record takes one exactly once. The *status* is
   * untouched either way — the renderer still needs to see `working` to infer
   * `closed`.
   */
  const records = new Map(
    readLedger(path).map((record) => {
      const stamped: SessionRecord =
        record.endedAt === undefined ? { ...record, endedAt: now() } : record;
      return [record.id, stamped] as const;
    }),
  );
  /**
   * Ids this process has started, as opposed to read off disk.
   *
   * The one fact a `SessionRecord` cannot carry: which run wrote it. `begin`
   * needs it to tell a restart (keep what the row has learned) from a spawn that
   * reused a previous run's id (keep none of it).
   */
  const startedThisRun = new Set<string>();
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

  const resumableUuid = (id: string): string | undefined => {
    const record = records.get(id);
    if (record === undefined) return undefined;
    /**
     * A session this run started is only unresumable **while it is running**
     * (HIVE-93).
     *
     * The bar was `startedThisRun` alone, and the reasoning was right: resuming
     * a conversation that is currently open means a second `claude` against one
     * transcript. But that reasoning is about the process, not about the run —
     * and `/done` produces a session that started this run and is now over. Its
     * transcript is closed, its uuid still names it, and offering to reopen it
     * is the whole point of the feature.
     *
     * So the test is "started this run **and** has not ended", which is the
     * condition the original was standing in for while every ending arrived
     * after a restart.
     */
    if (startedThisRun.has(id) && !hasEnded(record)) return undefined;
    return record.sessionUuid;
  };

  return {
    resumable: resumableUuid,
    begin(id, patch, { resume = false } = {}) {
      /**
       * A restart is not a new session, and a reused id is not the old one.
       *
       * Both arrive here — `restartOnce` spawns through the same path as a
       * first open — and they want opposite things. A restart keeps the row's
       * accumulated truth: same session, same ticket, same branch, new process.
       * A spawn that happens to take an id the *previous run* used must keep
       * none of it, or the new session advertises a branch and a ticket it
       * never had.
       *
       * `startedThisRun` is what separates them, and it is the only thing that
       * can: a record's own fields cannot say which run wrote them.
       */
      const previous =
        startedThisRun.has(id) || (resume && resumableUuid(id) !== undefined)
          ? records.get(id)
          : undefined;
      const base: SessionRecord = previous ?? {
        id,
        project: '',
        task: '',
        status: 'working',
        createdAt: now(),
      };

      const next: SessionRecord = {
        ...base,
        ...patch,
        id,
        // Kept across a restart, minted for a genuinely new session.
        createdAt: base.createdAt,
        status: patch.status ?? 'working',
      };
      /*
        A session that is starting has not ended. The previous generation's
        `settleExit` left an `endedAt` here, and leaving it would file a running
        session as ended — exempt from nothing, prunable, and replaceable by an
        empty record on its next patch.
      */
      delete next.endedAt;

      startedThisRun.add(id);
      records.set(id, next);
      schedule();
    },

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
        /**
         * A patch adds to what is known; it does not decide whether a session
         * is alive.
         *
         * An earlier draft cleared `endedAt` here whenever a patch carried a
         * live status, to catch the restart case. `begin` owns that now, and the
         * branch is deliberately gone rather than kept as redundancy: it had
         * become unreachable, and worse, its polarity had flipped. Records read
         * from disk are stamped with an `endedAt` at load *so the cap can reach
         * them*; a live status routed through here would have stripped that
         * stamp back off and restored the "exempt forever" growth the stamp
         * exists to prevent. One verb decides liveness, and it is not this one.
         */
        /**
         * A title from the agent is normalised here exactly as the store
         * normalises it (HIVE-107, reshaped by HIVE-108).
         *
         * `readTitle` records every title it reads, raw — that is the right
         * thing for it to do, because the pin it would need to apply lives on
         * the record rather than in the pty. So the rule is applied here, where
         * `existing` is in hand, and it has to be *the same* rule the store
         * runs: this file is what the next launch reads, and a row that came
         * back named differently from how it was left would be the HIVE-107 bug
         * again, one layer down.
         *
         * Pinned means the ticket key stays in front, not that the title is
         * refused — see `renameSession` for why that relaxed, and for why the
         * prefix is `ticket` and never `name`. A pin with no ticket behind it
         * still refuses, matching the store's own fallback.
         *
         * A patch that carries `namePinned` is the app repinning and is obeyed
         * verbatim — that is the note, and it is the only writer allowed to
         * replace one.
         *
         * ## What is deliberately *not* mirrored
         *
         * `renameSession` applies two further refusals that have no meaning
         * here, and copying them would be worse than the divergence:
         *
         * - the **stale-title guard**, which exists to stop a `/clear`
         *   successor inheriting the retired conversation's name. It is keyed on
         *   a terminal and on which row is current, neither of which this file
         *   models — records are per entity id, and a retired row keeps its own.
         * - the **live-name uniqueness** check. "Live" is a property of this
         *   run; the ledger is mostly history, where duplicate names are normal
         *   and correct — two finished sessions may well have done the same
         *   kind of work. Enforcing uniqueness across history would refuse names
         *   that are not in conflict with anything.
         *
         * So two live sessions that converge on one title leave the store with a
         * single named row and this file with two identically named records, and
         * `hydrateSessions` restores both. That is a cosmetic duplicate in the
         * ENDED list rather than a broken invariant: the "one name, one session"
         * rule is a rule about *renaming a live row*, which is where it is
         * enforced, and ids — not names — identify a session everywhere.
         */
        /*
          Narrowed to a `string | undefined` rather than tested with a boolean
          and cast at the call, so the compiler is the thing proving there is a
          title here and not a comment claiming it.
        */
        const title = patch.namePinned === undefined ? patch.name : undefined;
        const pinned = existing.namePinned === true;
        const renamed =
          title === undefined || (pinned && existing.ticket === undefined)
            ? undefined
            : hiveNameFromTitle(title, pinned ? existing.ticket : undefined);

        const merged: SessionRecord = {
          ...existing,
          ...patch,
          /*
            `?? existing.name` covers both refusals — a pin the ticket cannot
            complete, and a title that normalised to nothing — with the value
            that was already true. Neither is a reason to forget the name.
          */
          ...(title === undefined ? {} : { name: renamed ?? existing.name }),
          // `createdAt` is deliberately not overwritable: it is the first thing
          // anyone knew about this session, and retention sorts on it.
          createdAt: existing.createdAt,
        };
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
