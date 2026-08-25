import type { TermLine } from '@/types/terminal';

import type { IdleDetail } from '@shared/hook-contract';
import type { SessionEffort, SessionModel } from '@shared/session-contract';

/**
 * Session lifecycle. Agents are always `online` and are tracked separately.
 *
 * **Two endings, and they answer different questions** (story 108, HIVE-93).
 *
 * `done` is a session that finished **on purpose**: `/clear` ended the
 * conversation, `/done` ended the session, or the app was quit around it. What
 * they share is a person deciding, which is why they share a word.
 *
 * `terminated` is an **observation**: the pty went away and nobody said it was
 * finished. `/exit`, `Ctrl-D`, a kill. It is the one status forwarded even for a
 * hook-driven session, because `SessionEnd` races the exit and loses.
 *
 * Collapsing *these two*, which is what shipped before story 108, made a session
 * that had merely quit indistinguishable from one that had delivered.
 *
 * ## Why there is no longer a third
 *
 * `closed` used to be here for a row that was live when the app last quit. It
 * was carrying two jobs at once, and neither needed a status of its own:
 *
 * - *"you can click this to resume it"* — an **affordance**, now a real `resume`
 *   control driven by {@link Session.resumable}. A status word should not be how
 *   the user discovers what a row can do.
 * - *"this may be pruned, unlike `terminated`"* — a **retention rule**, and the
 *   load-bearing half. It survives the fold because `done` is cappable too; the
 *   guarantee that matters is that a `terminated` row is never dropped, and that
 *   is untouched. Folding into `terminated` instead would have been the
 *   catastrophe the old comment warned about: twenty launches of five sessions
 *   is a hundred permanent tombstones.
 *
 * What is left — *how* a session ended — is {@link Session.endedBy}, a field,
 * where it can be read without also deciding what the row may do.
 */
export type SessionStatus =
  | 'working'
  | 'waiting'
  | 'idle'
  | 'done'
  | 'terminated';

/**
 * Aliases, not declarations (story 109).
 *
 * These used to be their own unions here, which was right while they were
 * decoration — a chip on a meta bar. They are now **wire values**: the picker's
 * choice becomes `--model opus --effort high` on the command line main writes
 * into a session's shell, and the IPC guard validates it against a closed list.
 * Two independent copies of that list is how a picker comes to offer a model
 * the guard rejects, which presents as a session that silently fails to start.
 *
 * So `electron/shared/session-contract.ts` owns them, because it is the one
 * module both processes read, and this file points at it. Type-only, as the
 * fence requires.
 */
export type Model = SessionModel;
export type Effort = SessionEffort;

/** One agentic terminal session, bound to a project and a branch. */
export interface Session {
  kind: 'session';
  id: string; // 'hero-refresh'
  /**
   * What the *agent* calls itself (HIVE-61).
   *
   * Optional, and absent is the normal state for a fixture and for any session
   * whose agent has not reported one. Every surface renders `name ?? id`, which
   * is what lets this be additive: nothing that reads a session had to learn a
   * new required field.
   *
   * Deliberately **not** the `id`. The id is the entities-map key, it is in
   * `branch`, and it is what every feed line and orchestrator row already
   * spells — rekeying the map on a rename would turn a cosmetic event into a
   * graph rewrite. A name is a label; an id is an identity, and Claude renames
   * only the former.
   */
  name?: string;
  /**
   * The app's own name for this session outranks the agent's (HIVE-78).
   *
   * Set when the Hive named the session for a reason of its own — today, that
   * it is being worked for a ticket. While it is set, `renameSession` ignores
   * names read off the terminal title.
   *
   * ## Why a flag and not just "last write wins"
   *
   * Claude re-emits its title constantly — every activity change rewrites
   * `✳ <name>` — so a name assigned in the store and not defended survives
   * for about a second. A session the user told to "work on ABC-123" would
   * flick to `ABC-123` and straight back to `sess-03`, which is worse than not
   * renaming it at all.
   *
   * ## Why not write `/rename` into the terminal instead
   *
   * That was the alternative, and it would make both sides genuinely agree.
   * It was rejected because it types into a live input box at a moment the app
   * chose: mid-turn, possibly while the user is typing, on a TUI whose paste
   * detection `bootstrap.ts` already had to work around. The app asserting its
   * own label is a smaller claim than the app driving the agent's keyboard.
   *
   * Sessions named at *spawn* from a ticket card do not need this — they carry
   * the key as `--name`, so the agent reports it back and the two already
   * agree. This exists for the mid-session case, where there is no command line
   * left to put it on.
   */
  namePinned?: boolean;
  /**
   * The terminal this session runs in — a pty, not a row.
   *
   * Absent means "my own id", which is every session that has never been
   * cleared. It is only set when `/clear` retires a row and opens a successor
   * on the *same* pty, so one terminal comes to host a sequence of sessions.
   *
   * **Load-bearing, not bookkeeping.** `center-stage.tsx` keys its xterm
   * instance on this. Keying on `id` would remount the terminal the moment a
   * successor is minted — wiping and replaying the user's scrollback at exactly
   * the instant they typed `/clear`, which is the most visible regression this
   * feature could have. The row's identity changes; the terminal's must not.
   *
   * `lib/terminal/` resolves transports through it for the same reason: the
   * channel belongs to the pty, and the successor has to inherit the live one
   * rather than spawn a second process in the same directory.
   */
  terminalId?: string;
  project: string; // 'nova-web'
  /**
   * The Jira issue this session was started for, if it was started from one.
   *
   * **The link lives here, on the session, and not as a `sessions` array on the
   * ticket.** Tickets are re-read from Jira every time the WORK panel opens, so
   * a list held on the ticket would be overwritten by its own refresh — the
   * link would survive exactly until the user looked at it. A session outlives
   * any number of those reads, so hanging the key here makes `hydrateTickets`
   * a non-event and leaves one source of truth for the association.
   *
   * The reverse direction — "which sessions is this ticket being worked by" —
   * is a selector over the entities map, never stored.
   */
  ticket?: string; // 'HIVE-73'
  /**
   * The branch checked out where this session's agent is working (HIVE-78).
   *
   * **Optional, and that is the fix.** This field used to be assigned
   * `` `feat/${id}` `` at spawn — a branch nothing created, displayed with total
   * confidence next to a session sitting on `main`, and still displayed after
   * the agent moved into a worktree. `docs/branch-sync-note.md` has the full
   * diagnosis; the short version is that it was not stale, it was never true.
   *
   * Now it is only ever what main *observed*: `git rev-parse` in the directory
   * a hook payload named. Absent means nobody has looked yet, or there is
   * nothing to see — a session on a plain directory, a detached HEAD, a machine
   * with no `git`. Every surface renders an em dash for it, which is a smaller
   * claim than a name and an honest one.
   */
  branch?: string;
  /**
   * Where that branch was read — the agent's working directory (HIVE-78).
   *
   * Absent until observed, and equal to the project path for most sessions. It
   * differs precisely when the agent has moved into a worktree, which is the
   * case the explorer needs it for: a tree rooted at the mapped project while
   * the session works somewhere else shows files nobody is editing.
   */
  cwd?: string;
  /**
   * This row came back from the ledger rather than from a session this run
   * started (HIVE-87).
   *
   * **Provenance, not lifecycle**, and it has to be both because they are
   * genuinely different facts. `closed` says *how* a session ended — the app
   * was closed while it ran — and it earns its place by being cappable where
   * `terminated` is not. This says *where the row came from*, and it is what
   * the PREVIOUS RUN group partitions on.
   *
   * Grouping on `closed` alone was wrong, and wrong in the direction that
   * defeats the group: `settleExit` is the only writer of an ended status, so a
   * session that quits normally is recorded `terminated` and restores as
   * `terminated`. Every such row landed in ENDED — the group whose whole job is
   * answering "what did I just finish?" about *this* run — so the first launch
   * after a busy day buried today's two endings under yesterday's twenty.
   */
  restored?: boolean;
  status: SessionStatus;
  /**
   * How a `done` session came to be done (HIVE-93).
   *
   * `done` is one word for three deliberate endings, and almost everything is
   * happy with that — the fleet table, the counts, the dot. Two things are not,
   * and both are about the **terminal** rather than the row:
   *
   * ```
   * cleared      pty alive, belongs to the successor    transcript not shown
   * finished     pty gone, /done wrote the /exit        transcript worth reading
   * app-closed   pty gone with the app that owned it    nothing left to read
   * ```
   *
   * `isTerminated` asks the first column and `endedReason` asks for a sentence
   * per row — neither is answerable from `status` once the three share a word.
   * That is the whole reason this field exists rather than a fourth status: the
   * user-facing vocabulary stays at two endings while the code keeps the
   * distinctions it actually needs.
   *
   * Absent on a live session, and on an ending old enough to predate the field.
   * Every reader treats absent as "not `cleared`", which is the safe default: it
   * protects a transcript that may not need protecting, rather than discarding
   * one that did.
   */
  endedBy?: 'cleared' | 'finished' | 'app-closed';
  /**
   * This row's conversation can be reopened (HIVE-93).
   *
   * Set from the ledger at hydrate — main answers whether it still holds a
   * `--session-id` for this row — and by `finishSession`, because a `/done`
   * keeps its uuid where a `/clear` drops it.
   *
   * **Deliberately not derived from `status` or `endedBy`.** Resumability is a
   * fact about a transcript on disk, and the three endings do not agree with it:
   * a `cleared` row is not resumable, a `finished` one is, and an `app-closed`
   * one is only resumable if its record carried a uuid — which records written
   * before uuids existed do not. Inferring it would offer Resume on rows that
   * cannot resume, which fails at the worst possible moment: after the click.
   */
  resumable?: boolean;
  /**
   * What is still running while the main agent is not (HIVE-83).
   *
   * Only ever set alongside `idle` — see `SessionStatusEvent`, whose field this
   * mirrors. Absent for every other status, including a plain `idle` with
   * nothing behind it: the dot renders hollow only when this is present.
   */
  idleDetail?: IdleDetail;
  /**
   * The shell is still booting and Claude is not on screen yet (HIVE-101).
   *
   * Set the moment a spawn or a resume is asked for, cleared when the session
   * reports `SessionStart` — or when the boot times out, or when the user types
   * into it, whichever comes first. Absent for every session started before
   * this field existed and for every restored row, which are not booting at
   * all.
   *
   * **Not a `SessionStatus`.** A booting session is `working` by every measure
   * a pty can take — output is pouring out of it — and that is exactly the
   * reading that made the first seconds of every session look like work. This
   * is a fact about what is *on screen*, not about what the agent is doing, so
   * it is a field beside the status rather than a value inside it.
   */
  booting?: boolean;
  task: string; // one-line description
  cost: string; // '$2.41'
  model?: Model;
  effort?: Effort;
  lines: TermLine[]; // terminal transcript
}

/** A long-lived background worker, not tied to a branch. */
export interface Agent {
  kind: 'agent';
  id: string; // 'slack-agent'
  icon: string; // phosphor icon name, e.g. 'ph-slack-logo'
  sub: string; // '#eng-alerts · #deploys · #ask-eng'
  task: string;
  status: 'online';
  lines: TermLine[];
}

/** Anything that owns a terminal tab. */
export type Entity = Session | Agent;

export interface Project {
  id: string;
  icon: string;
}

/**
 * A row in the rail's project list (story 101).
 *
 * The config file is the only source. This used to be a *merged* row type,
 * carrying `source: 'config' | 'demo'` to tell a user-mapped project apart from
 * a seeded one kept in the list because it still owned live seeded sessions.
 * Both the seed and the merge are gone; `source` went with them rather than
 * lingering as a discriminant with one inhabitant and no readers.
 *
 * Still a **separate type** rather than one more field on {@link Project} — but
 * the reason has narrowed, and the old one is worth retiring rather than
 * repeating. It used to read "`Project` is the shape the rail needs to *draw*
 * one": the rail's row took a `Project` and drew `project.id`. That was the
 * HIVE-104 bug, and the row takes this type now.
 *
 * So `Project` has no standalone consumer left in `src/` or `electron/` — it is
 * the identity half of this shape, and nothing but `DemoFleet` names it alone.
 * What the split still buys is direction: a value typed `Project` cannot be
 * mistaken for something displayable, which is what keeps a display name out of
 * the places that key on `entity.project`. It no longer describes a component.
 */
export interface ProjectRow extends Project {
  /** Display name, as the config declares it. */
  name: string;
  /**
   * The 2–4 letter alias the config declares or generated (HIVE-94).
   *
   * Carried on the row rather than looked up per consumer because the picker
   * both *searches* it and *shows* it, and a second read of the config snapshot
   * to answer the same question is how two surfaces come to disagree about
   * which projects exist.
   */
  key: string;
}

/**
 * Whether a session has ended, however it ended (story 108).
 *
 * The distinction between `done` and `terminated` matters to the *user* — one
 * finished, the other quit — and to almost nothing else. Every list that
 * partitions the fleet into "still going" and "over" wants both, and the four
 * selectors that used to spell `status === 'done'` are exactly the places a
 * fifth state would have been silently forgotten. One predicate is what stops
 * `terminated` sessions quietly reappearing in the active list.
 */
export const isEnded = (status: SessionStatus): boolean =>
  status === 'done' || status === 'terminated';

/**
 * Whether this session's process is gone and cannot be typed into.
 *
 * Narrower than {@link isEnded}: every ended row closes its tab to new visits,
 * so `openEntity` gates on that one, while this asks the sharper question
 * `center-stage.tsx` needs for the "this terminal has died" notice and for
 * disabling stdin.
 *
 * **Not a status test** (HIVE-93). It was, while `terminated` was the only
 * ending whose process had gone. Now `/done` produces a `done` row whose pty is
 * equally gone, and an app-quit restores one, so the question is answered by
 * {@link Session.endedBy} instead. Only a *cleared* session's pty survives its
 * row — it belongs to the successor — and showing "this terminal has died" over
 * it would be false.
 *
 * Absent `endedBy` on a `done` row reads as "the process is gone", which is the
 * safe direction: it disables typing into a terminal that might be alive, where
 * the reverse leaves a live caret over a dead pty silently eating keystrokes.
 */
export const isTerminated = (entity: Entity | undefined): boolean => {
  if (entity === undefined || entity.kind !== 'session') return false;
  if (entity.status === 'terminated') return true;
  return entity.status === 'done' && entity.endedBy !== 'cleared';
};

/** Narrowing helpers — cheaper to read than repeating the discriminant. */
export const isSession = (entity: Entity): entity is Session =>
  entity.kind === 'session';

export const isAgent = (entity: Entity): entity is Agent =>
  entity.kind === 'agent';

/**
 * Which terminal a session runs in.
 *
 * One accessor rather than `session.terminalId ?? session.id` spelled at four
 * call sites: the fallback *is* the contract for every session that has never
 * been cleared, and a single place to read it is what stops one of those sites
 * forgetting the `??` and quietly spawning a second pty.
 */
export const terminalOf = (session: Session): string =>
  session.terminalId ?? session.id;

/**
 * What the three branch surfaces show when nobody has observed one (HIVE-78).
 *
 * An em dash, not "unknown", not "—" spelled differently in three files. It is
 * the typographic convention for "no value" and it reads as one glance rather
 * than a word the eye has to parse in a 100px column.
 */
export const NO_BRANCH = '—';

/**
 * What to print in a session's branch slot (HIVE-78).
 *
 * One function rather than `session.branch ?? '—'` at three call sites, for the
 * reason {@link entityLabel} gives for the same shape: the fallback *is* the
 * contract. This one is stricter about why — the whole point of HIVE-78 is that
 * these surfaces must never again print a branch nobody created, and three
 * hand-written `??`s are three chances for the next one to substitute something
 * plausible instead of admitting it does not know.
 *
 * Lives here, next to `entityLabel`, because its three callers sit in three
 * different lint zones — `components/layout`, `features/orchestrator` and
 * `features/projects` — and `src/types/` is the one place all three may import.
 */
export const branchLabel = (session: Session): string =>
  session.branch === undefined || session.branch === ''
    ? NO_BRANCH
    : session.branch;

/**
 * What to call an entity on screen (HIVE-61).
 *
 * One function rather than `entity.name ?? entity.id` at each site, because the
 * fallback is the whole contract: a session whose agent has never reported a
 * name — every fixture, every session in its first second, every session whose
 * agent is not Claude — must read exactly as it always did. Spelling that at
 * five call sites is five chances for one of them to render `undefined`.
 *
 * Agents have no `name` field and fall through to their id, which is what they
 * have always shown.
 */
export const entityLabel = (entity: Entity): string => {
  const name = isSession(entity) ? entity.name : undefined;
  /**
   * An **empty** name falls back too, which `??` alone does not do.
   *
   * The parser already drops empty titles and the store already ignores an
   * unchanged value, so this should be unreachable — but the failure it guards
   * is a session row rendering nothing at all, and "should be unreachable" is a
   * weaker guarantee than one line here.
   */
  return name === undefined || name === '' ? entity.id : name;
};

/**
 * Why an ended session cannot be visited or typed into — one sentence, named
 * once (HIVE-93).
 *
 * The three endings are **not** interchangeable and the sentence has to say
 * which: a terminated session's process is gone, a cleared one's is very much
 * alive and simply is not its own any more, and an app-closed one belonged to an
 * app that is no longer running. See {@link isTerminated} for the same
 * distinction from the other direction.
 *
 * It lives here rather than in the session table because there are now three
 * consumers and one of them is the store, which may not import from
 * `features/`. Two copies of this sentence is how the console came to report a
 * *cleared* row as "has terminated — its process is gone", which is the one
 * reading that is false in both halves.
 *
 * ## Two switches, because one word covers three endings (HIVE-93)
 *
 * `status` no longer identifies the ending — `done` is `/clear`, `/done` and an
 * app quit — so the sentence comes from {@link Session.endedBy} and the outer
 * switch only separates "deliberate" from "observed".
 *
 * **Neither switch has a `default`**, which is what makes the claim above true
 * rather than merely intended. An earlier version had one, with a comment
 * promising that a new ending would be a compile error — it would not have
 * been; it would have fallen into "was cleared", quietly, which is the exact
 * failure this shape exists to prevent. The `never` assignments are the part
 * that actually fails the build.
 */
export const endedReason = (session: Session): string => {
  const label = entityLabel(session);

  switch (session.status) {
    case 'terminated':
      return `${label} has terminated — its process is gone`;
    case 'done': {
      switch (session.endedBy) {
        case 'finished':
          return `${label} finished with /done — resume to pick it up`;
        case 'app-closed':
          return `${label} was open when The Hive last closed — resume to pick it back up`;
        /*
          `cleared` and absent share a sentence, and absent is the older
          ending: every `done` row predating `endedBy` was a cleared one,
          because `/clear` was the only thing that produced the status.
        */
        case 'cleared':
        case undefined:
          return `${label} was cleared — its terminal continues as a new session`;
        default: {
          const exhaustive: never = session.endedBy;
          return exhaustive;
        }
      }
    }
    case 'working':
    case 'waiting':
    case 'idle': {
      /*
        Not an ending, and no caller should be here — every call site gates on
        `isEnded` first. Answering with the cleared sentence would be a lie, so
        this says only what is certainly true.
      */
      return `${label} is still running`;
    }
    default: {
      /*
        Unreachable, and the assignment is the point: a new `SessionStatus` has
        no case above, so `status` is no longer `never` here and the build
        fails.
      */
      const exhaustive: never = session.status;
      return exhaustive;
    }
  }
};

/**
 * The outcome of looking an entity up by what the user typed.
 *
 * Three cases rather than `string | undefined`, because "two sessions answer to
 * that" is a different thing to tell the user than "nothing does", and a
 * resolver that collapsed them would have to pick one silently.
 */
export type EntityRefMatch =
  | { kind: 'found'; id: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; labels: string[] };

/**
 * Find an entity by the identifier a user can actually see (HIVE-92).
 *
 * The orchestrator console used to index `entities` directly, which means it
 * accepted **only the entity id** — `sess-02`. Every other surface in the app
 * renders {@link entityLabel}, and for a session spawned from a ticket card that
 * is the Jira key. So the fleet showed `INCORP-455` in the rails, the session
 * table, the meta bar and the WORK card, and the one place you can type at it
 * answered `no such session: INCORP-455`.
 *
 * ## Why an exact id match wins outright
 *
 * Ids are the `entities` map keys, so an exact hit is unique by construction and
 * cannot be argued with. Checking it first is also what keeps `send sess-02`
 * byte-identical to its old behaviour, including the case where some *other*
 * session has been renamed to `sess-02` by its agent — the id's owner wins, and
 * deterministically, rather than the answer depending on map order.
 *
 * ## Why the name match is case-insensitive
 *
 * A Jira key is upper-case and a shell prompt is where people type lower-case.
 * `send incorp-455` is unambiguously about `INCORP-455`, and refusing it teaches
 * nothing. Ids come along for free: `entityLabel` falls back to the id, so
 * `SESS-02` resolves too.
 *
 * ## Why ambiguity is reported rather than resolved
 *
 * `ticketSessionName` already prevents two sessions sharing a name, so this
 * should be rare — but it is reachable, because an agent can rename itself over
 * the title stream to whatever it likes, case included. Routing a message to a
 * coin-flip between two agents is the one outcome worse than refusing it.
 */
export const resolveEntityRef = (
  ref: string,
  entities: Record<string, Entity>,
): EntityRefMatch => {
  if (entities[ref] !== undefined) return { kind: 'found', id: ref };

  const needle = ref.toLowerCase();
  const hits = Object.values(entities).filter(
    (entity) => entityLabel(entity).toLowerCase() === needle,
  );

  if (hits.length === 0) return { kind: 'none' };
  if (hits.length === 1) return { kind: 'found', id: hits[0]!.id };
  return { kind: 'ambiguous', labels: hits.map(entityLabel) };
};
