import { useMemo, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import type { ParsedCommand } from '@/types/command';
import { USAGE } from '@/types/command';
import type {
  Effort,
  Entity,
  Model,
  ProjectRow,
  Session,
  SessionStatus,
} from '@/types/entity';
import {
  branchLabel,
  endedReason,
  entityLabel,
  isAgent,
  isEnded,
  isSession,
  recencyOf,
  resolveEntityRef,
  terminalOf,
} from '@/types/entity';
import type { HiveNotification } from '@/types/notification';
import type { Pr, SessionPr, TicketPr } from '@/types/pull-request';
import type { TermLine } from '@/types/terminal';
import type { Ticket } from '@/types/ticket';

import { isDesktop } from '@config/runtime';
import { describeNextRun, describeWake } from '@lib/agents';
import { reset as resetClock } from '@lib/fake-clock';
import { readPullRequests, searchPullRequests } from '@lib/github';
import { readJiraStatus, searchJiraIssues } from '@lib/jira';
import { ledgerRows } from '@lib/ledger/console-rows';
import {
  projectConfigSnapshot,
  resolveProjectRef,
  subscribeProjectConfig,
} from '@lib/project-config';
import { noteSessionPr, noteSessionTicket } from '@lib/session-history';
import { pickPhrase } from '@lib/swarm/phrases';
import { reopenChannel, requestSpawn } from '@lib/terminal/pty-transport';
import { sendToSession } from '@lib/terminal/session-input';
import {
  formatRunCost,
  type AgentLinesPush,
  type AgentStatus,
  type AgentStatusPush,
  type AgentSummary,
  type RunSummary,
} from '@shared/agent-contract';
import type { PrRecord } from '@shared/github-contract';
import type { IdleDetail } from '@shared/hook-contract';
import type { SessionNameReport } from '@shared/ipc-contract';
import type { JiraIssue } from '@shared/jira-contract';
import {
  LEDGER_MEMORY_CAP,
  type LedgerEntry,
  type LedgerReadQuery,
  type OpenAsk,
} from '@shared/ledger-contract';
import { matches, openAsks, thread } from '@shared/ledger-derive';
import type { SessionMetrics } from '@shared/metrics-contract';
import { NOTIFICATION_CAP } from '@shared/notification-contract';
import {
  hiveNameFromTitle,
  SESSION_EFFORTS,
  SESSION_MODELS,
} from '@shared/session-contract';
import type {
  SessionHistoryEntry,
  SessionPrRequest,
} from '@shared/session-history-contract';
import { useUiStore } from '@stores/ui-store';

/**
 * Domain state — what the system knows, as opposed to what the user is looking
 * at (which lives in `ui-store.ts`).
 *
 * The actions mirror what the future orchestrator daemon will do, so panels
 * stay pure views and swapping in a real backend later replaces this store's
 * internals rather than the component tree. That seam is the point; see
 * the HIVE project in Jira → Decision record.
 */

/**
 * Delay before a messaged session acknowledges, in ms.
 *
 * One constant for both paths. Story 041 sketches ~2.2s for a console `send`
 * and story 043 ~1.8s for a message typed into a session; the difference is
 * cosmetic and two constants would only invite them to drift.
 */
export const ACK_DELAY_MS = 2000;

/**
 * What a session says when it picks a message up.
 *
 * Stories 041 and 043 word this differently ("resuming with your input" vs
 * "working on it"). One line, used by both: the acknowledgement means the same
 * thing however the message arrived, and the transcript should not imply
 * otherwise.
 */
const ACK_LINE = '● Acknowledged — working on it';

/** Where a message came from. The transcript records who spoke. */
export type MessageOrigin = 'orchestrator' | 'session';

/**
 * What happened to a message (story 097).
 *
 * The action has to *report*, not merely act: the console prints the refusal,
 * and only its caller knows where that line goes. Story 097 says the signature
 * is unchanged — it cannot be, and the deviation is recorded in the design
 * spec beside the reason.
 *
 * `demo` still carries the timer handle so the simulation (story 061) and the
 * tests keep cancelling deterministically rather than racing a real wait.
 */
export type SendOutcome =
  | { kind: 'routed' }
  | { kind: 'refused'; reason: string }
  | { kind: 'demo'; timer: ReturnType<typeof setTimeout> };

/**
 * Where the WORK tab's tickets came from, and how much to trust them (HIVE-69).
 *
 * A discriminated union rather than a pair of booleans, because the five cases
 * want five different things on screen and only one of them is an error.
 */
export type TicketSource =
  /**
   * A read is in flight and there is nothing yet.
   *
   * The boot state, and the state every refresh returns to. It replaced a
   * `fixtures` variant that meant "these eight are sample data" — which is what
   * made real issues arrive *behind* fake ones for a frame. There is nothing to
   * show before the answer comes back, and saying so is the whole fix.
   */
  | { kind: 'loading' }
  /** Desktop with nothing configured. The panel explains rather than sits empty. */
  | { kind: 'unconfigured' }
  /** Desktop, at least one successful read. */
  | { kind: 'live'; stale: boolean; capped: boolean }
  /** Desktop, and the first read failed. There is nothing to keep. */
  | { kind: 'failed'; message: string };

/**
 * Where the PRs panel's list came from, and how much to trust it.
 *
 * Deliberately the same four shapes as {@link TicketSource}, because the two
 * panels have the same four things to say and a user who has learned one rail
 * should not have to learn the other. It is a *separate type* rather than a
 * shared one because the variants carry different payloads — `capped` is a JQL
 * concern with no GitHub counterpart, and `repos` is a GitHub concern with no
 * Jira one. Unifying them would mean a union with fields that are meaningless
 * on one side, which is how a shared type becomes a lie.
 */
/**
 * The PRs panel's search, as the store holds it.
 *
 * `term` is carried alongside the results so a stale answer can be dropped: a
 * search is debounced and asynchronous, and two in flight can settle out of
 * order. Comparing what came back against what the store last asked for is what
 * stops the slower of the two from painting over the newer.
 */
export interface PrSearchState {
  /** What produced `results`. `''` when nothing has been searched. */
  term: string;
  /**
   * `null` until the first answer lands, and again once the search is cleared.
   *
   * **Kept across a re-search**, deliberately: a user narrowing or widening an
   * existing search keeps the previous rows on screen while the new ones are in
   * flight, rather than watching the panel blink to empty and back. `searching`
   * is the flag that says an answer is on its way.
   */
  results: PrRecord[] | null;
  searching: boolean;
  error: string | null;
}

export type PrSource =
  /** A read is in flight and there is nothing yet. The boot state. */
  | { kind: 'loading' }
  /**
   * Nothing to read from, and it is not an error.
   *
   * Three ways to get here and the panel says which: no `gh` on this machine,
   * a `gh` that is not logged in, or no configured project that is a GitHub
   * repository. The browser demo lands here too.
   */
  | { kind: 'unconfigured'; message: string }
  /** At least one successful read. `repos` is how many were swept. */
  | { kind: 'live'; stale: boolean; repos: number }
  /** The first read failed, and there is nothing to keep. */
  | { kind: 'failed'; message: string };

/**
 * How sure the caller is that this session belongs to this ticket.
 *
 * There is one association and two ways of arriving at it, and the difference
 * between them is worth exactly one field. The user *saying* "work on ABC-123"
 * is a decision, and renaming the row to match is the app acknowledging it.
 * Reading `ABC-123` out of a branch name is a good inference about a decision
 * made somewhere else, possibly days ago — right often enough to file the
 * session on the correct card, not right enough to rewrite what the row is
 * called while the user is looking at it.
 */
export interface SetSessionTicketOptions {
  /**
   * How the key was learned. Defaults to `'prompt'`, the spoken-intent
   * behaviour HIVE-78 shipped.
   *
   * One field rather than two, because everything that differs between the two
   * callers follows from it and must not be settable independently:
   *
   * - `'prompt'` pins the session's name to the key, and may **replace** a
   *   ticket that was merely inferred.
   * - `'branch'` associates and nothing else — the name, pinned or not, is left
   *   exactly as it was, an agent-chosen title (HIVE-108) goes on being the
   *   agent's to change, and it never displaces an existing ticket of either
   *   kind.
   */
  source?: 'prompt' | 'branch';
}

interface HiveState {
  entities: Record<string, Entity>;
  order: string[];
  agentOrder: string[];
  /*
   * No `projects` slice. It held the five seeded projects and was what
   * `useProjects()` fell back to; both the seed and the fallback are gone, and
   * a slice nothing reads is a slice that drifts. The project list is the
   * config file's, read through `projectConfigSnapshot()`. Sessions still name
   * a project through `entity.project` — that string needs no table here.
   */
  tickets: Ticket[];
  /** Where {@link HiveState.tickets} came from (HIVE-69). */
  ticketSource: TicketSource;
  /**
   * The PRs GitHub reported, exactly as they crossed IPC.
   *
   * `PrRecord`, not `Pr`: the renderer's type carries an owning session, which
   * is a *match* against the fleet rather than a fact about the PR. Storing the
   * resolved shape would freeze that match at read time and leave it wrong the
   * moment a session started or ended — so it is computed in `usePrs()` and
   * `resolveTicketPrs()`, and never kept.
   */
  prs: PrRecord[];
  /** Where {@link HiveState.prs} came from. */
  prSource: PrSource;
  notifs: HiveNotification[];
  /**
   * The ledger's tail (HIVE-111).
   *
   * A mirror, not the source — main owns the log and this holds the newest
   * {@link LEDGER_MEMORY_CAP} entries so the console and the inbox can render
   * without a round trip. Older entries are still there; they are asked for.
   */
  ledger: LedgerEntry[];
  orchLines: TermLine[];

  /**
   * What each session last reported about its own usage (HIVE-79).
   *
   * **Its own slice rather than a field on the entity**, and the reason is the
   * one the four-store split exists for. These arrive from Claude Code's status
   * line on every assistant message plus a 30-second timer, per live session —
   * easily the busiest write in the store. Putting them on `Entity` would give
   * every session row in the left rail a new object identity on each tick, and
   * a fleet of thirteen would repaint continuously to move a number that only
   * the header's chip renders.
   *
   * Keyed by entity id, and **not pruned when a session ends**. That is a
   * deliberate non-decision rather than an oversight: the map is bounded by the
   * number of sessions this app run has created, each entry is eight scalars,
   * and a retired session's last reported usage is the honest answer for a row
   * the user can still select. `reset()` clears it with everything else.
   */
  metrics: Record<string, SessionMetrics>;

  /** Replace the ticket list with real issues (HIVE-69). */
  hydrateTickets: (issues: JiraIssue[], capped: boolean) => void;
  /** A read failed. Keeps the tickets it has and marks them stale (HIVE-69). */
  reportTicketFailure: (message: string) => void;
  /** Desktop, but no Jira credential is configured (HIVE-69). */
  reportTicketsUnconfigured: () => void;
  /** Replace one ticket after a transition moved it (HIVE-70). */
  updateTicket: (issue: JiraIssue) => void;
  /** Read the configured query and install the answer (HIVE-69). */
  refreshTickets: () => Promise<void>;

  /** Replace the PR list with what GitHub reported. */
  hydratePrs: (prs: PrRecord[], repos: number) => void;
  /** A sweep failed. Keeps the PRs it has and marks them stale. */
  reportPrFailure: (message: string) => void;
  /** There is nothing to read from, and that is not a failure. */
  reportPrsUnconfigured: (message: string) => void;
  /** Sweep GitHub and install the answer. Never throws. */
  refreshPrs: () => Promise<void>;

  /**
   * What the PRs panel's search box found, or `null` when nothing is searched.
   *
   * A **separate list from {@link HiveState.prs}**, and that is the whole
   * design. The sweep is a standing answer to "what of mine is open" that the
   * poller keeps current and the WORK tab resolves against; a search is a
   * question asked once, about anyone's work. Installing results into `prs`
   * would let a search for someone else's pull request quietly change what a
   * ticket card says is attached to it.
   */
  prSearch: PrSearchState;
  /**
   * Run a search. `projectId` narrows to one mapped project; omitting it means
   * all of them.
   *
   * Debounced by the caller, not here — the store has no business owning a
   * timer, and the panel is the thing that knows a keystroke happened.
   */
  searchPrs: (term: string, projectId?: string) => Promise<void>;
  /** Drop the results. The panel goes back to showing the sweep. */
  clearPrSearch: () => void;

  spawnSession: (
    /**
     * A project **id**, already resolved — never a key or a display name.
     *
     * It lands on the entity as `entity.project`, which is how every other
     * surface finds this session's project, so an alias stored here would point
     * at nothing the moment it was edited. `resolveProjectRef` is what callers
     * put in front of user input (HIVE-94).
     */
    projectId: string,
    task?: string,
    model?: Model,
    effort?: Effort,
    /** The Jira issue this session is being started for (HIVE-73). */
    ticket?: string,
  ) => string;
  sendToEntity: (
    id: string,
    msg: string,
    origin?: MessageOrigin,
  ) => SendOutcome | null;
  openEntity: (id: string) => boolean;
  runOrchCommand: (command: ParsedCommand) => void;
  markAllRead: () => void;
  /** Mark one notification read, by id (HIVE-75). */
  markRead: (id: string) => void;
  /**
   * Remove a notification the user has acted on (HIVE-93).
   *
   * Not the same gesture as {@link markRead}: read means "seen", dismissed means
   * "dealt with". A card whose click navigated the user somewhere has spent its
   * whole purpose, and leaving it in the list turns the inbox into a log to prune
   * by hand instead of a queue that drains.
   *
   * Writes through to the hub, because `notifications.list()` is what a mounting
   * renderer hydrates from — a local-only removal comes straight back.
   */
  dismissNotif: (id: string) => void;
  /**
   * Empty the inbox in one gesture — the panel's **Clear all**.
   *
   * The bulk counterpart to {@link HiveState.dismissNotif}, and it clears
   * rather than marks read on purpose: a user who asks for this is saying they
   * are done with all of it, and leaving fifty read rows behind answers a
   * question nobody asked.
   *
   * **No undo.** The decision on HIVE's rail was instant-and-final, which is
   * only defensible because a notification is a *pointer* — the session, the
   * PR and the ticket it named all still exist, and every one of them is
   * reachable from a surface that is not the inbox. Nothing is destroyed here
   * except the reminder.
   */
  clearNotifs: () => void;
  pushNotif: (notif: HiveNotification) => void;
  /**
   * Merge main's buffer into what is already here, newest first (HIVE-75).
   *
   * A union rather than a replacement, because the stream subscribes before it
   * hydrates — anything that landed while `list()` was in flight is newer than
   * what main answered with, and replacing would drop it.
   */
  hydrateNotifs: (notifs: HiveNotification[]) => void;
  /**
   * Merge a fresh snapshot into the ledger's tail by `id` (HIVE-111).
   *
   * A union rather than a replacement, for the reason `hydrateNotifs` above
   * gives — and see the note at the implementation for why a dropped entry
   * here would never come back.
   */
  hydrateLedger: (entries: LedgerEntry[]) => void;
  /** One entry landed — append it to the tail. */
  ledgerAppend: (entry: LedgerEntry) => void;
  /**
   * Put last run's fleet back on the table (HIVE-87).
   *
   * The first time this store receives data at boot, which reverses the
   * position `emptySeeds()` argues — see the note there. The reversal is
   * narrow: the seeds are still empty, and this arrives by action, after the
   * first paint, carrying only rows that are already over.
   *
   * A **merge**, never a replacement. A restart reuses entity ids, so a
   * restored `sess-01` colliding with one this run has already spawned is the
   * ordinary case rather than a corner, and the live row always wins.
   */
  hydrateSessions: (records: SessionHistoryEntry[]) => void;
  /**
   * Mirror `~/.hive/agents` into the fleet (HIVE-114).
   *
   * A **replacement**, which is the opposite of what {@link hydrateSessions}
   * and {@link hydrateLedger} do, and deliberately so. Those two merge because
   * a restarted session reuses its id and the ledger only ever grows. A
   * definitions folder is a *set*: a folder deleted in Finder has to leave the
   * list, and a merge cannot express a removal.
   *
   * A transcript survives the replacement even so — lines are run output, not
   * definition, and re-reading the file is no reason to forget what the agent
   * said.
   */
  hydrateAgents: (summaries: AgentSummary[]) => void;
  /**
   * A run started, ended, or otherwise changed what an agent's row shows
   * (HIVE-115).
   *
   * Shares `hydrateAgents`' never-write-over-a-session guard: an agent name
   * is a legal session id, and a push for a name that currently names a
   * session must be dropped rather than clobber it.
   */
  setAgentStatus: (push: AgentStatusPush) => void;
  /**
   * A batch of run-log lines, in the order the process wrote them
   * (HIVE-115).
   *
   * Capped at {@link AGENT_LINE_CAP} the way `capLines` bounds the console
   * transcript, and guarded the same way `setAgentStatus` is.
   */
  appendAgentLines: (push: AgentLinesPush) => void;
  /**
   * Apply read-state the hub decided, without writing it back (HIVE-75).
   *
   * Separate from {@link markRead} precisely because it must **not** write
   * through: this is the echo of a decision main already made — most often the
   * user clicking a desktop toast, which the renderer cannot observe any other
   * way.
   *
   * `unread` carries the direction (HIVE-81): read-state now moves both ways,
   * since the foreground gate raises a row already-read and later promotes it
   * back once the user looks away.
   *
   * **The two arguments are one tuple, not two independent values.** Widening
   * `unread` to a boolean made `applyRead(null, true)` writable, and it would
   * mark *every* row in the inbox unread — a mass un-read the hub has no verb
   * for and no caller wants. Nothing produces it today; the union is what keeps
   * it from being one careless call away. `null` is "all of them", and the only
   * thing worth doing to all of them is marking them read.
   */
  applyRead: (
    ...args: [id: string, unread: boolean] | [id: null, unread: false]
  ) => void;
  /**
   * Remove a row main has already dropped (HIVE-81).
   *
   * Separate from {@link HiveState.dismissNotif}, which is the *user's* gesture
   * and writes through to main. This is the echo of a dismissal main decided on
   * its own — a clicked desktop toast — so writing back would send main a
   * message about the thing it just told us.
   *
   * `null` means the whole buffer went, mirroring {@link HiveState.applyRead}.
   * The renderer's own Clear all has already emptied the list by the time the
   * echo arrives, so this is only load-bearing for a *second* window, or for a
   * clear main decided on by itself.
   */
  applyDismiss: (id: string | null) => void;
  appendEntityLines: (
    id: string,
    lines: TermLine[],
    status?: SessionStatus,
  ) => void;
  setSessionStatus: (
    id: string,
    status: SessionStatus,
    idleDetail?: IdleDetail,
  ) => void;
  /** The agent reported a new display name (HIVE-61). */
  renameSession: (id: string, name: string) => void;
  /**
   * Main observed this session's real branch and working directory (HIVE-78).
   *
   * `branch` is `null` when there is none to report — not a work tree, a
   * detached HEAD, no `git` — and lands on the entity as an absent field.
   */
  setSessionBranch: (id: string, branch: string | null, cwd: string) => void;
  /** A session reported its context and rate-limit usage (HIVE-79). */
  setSessionMetrics: (id: string, metrics: SessionMetrics) => void;
  /**
   * The ticket this session is for, however it was learned (HIVE-78).
   *
   * Associates the session, and by default pins its name to the key. The key
   * must already have been confirmed against Jira; this action does not check.
   *
   * Pass `{ rename: false }` when the key was **inferred** rather than spoken —
   * see {@link SetSessionTicketOptions}.
   */
  setSessionTicket: (
    id: string,
    ticket: string,
    options?: SetSessionTicketOptions,
  ) => void;
  /**
   * `/clear` ended this session's conversation; its terminal kept running.
   *
   * Retires the row as `done` and opens a successor on the same terminal.
   * Answers the successor's id, or `null` if there was nothing to retire.
   */
  clearSession: (id: string) => string | null;
  /**
   * `/done` ended this session and its terminal with it (HIVE-93).
   *
   * The mirror of {@link HiveState.clearSession}, and the differences are the
   * point: no successor is minted, the row keeps its conversation so Resume can
   * offer it, and the centre stage falls back to the orchestrator if this was
   * the tab in front of the user — its terminal is gone, so there is nothing
   * left to look at.
   */
  finishSession: (id: string, resumable: boolean) => void;
  /**
   * Claude is up; stop covering this session's terminal (HIVE-101).
   *
   * Idempotent, and safe for an id that has since ended or vanished — see the
   * implementation for why all three of those are ordinary rather than
   * exceptional.
   */
  markSessionReady: (id: string) => void;
  /**
   * Pick an ended session's conversation back up (HIVE-93).
   *
   * The affordance `closed` used to carry as a status, now a verb. Puts the row
   * back in a live state and opens its tab; the transport that mounts reads
   * {@link Session.resumable} and asks main to `--resume` rather than begin.
   */
  resumeSession: (id: string) => void;
  reset: () => void;
}

/**
 * Inbox cap, matching the hub's (HIVE-75).
 *
 * Eight was an honest bet for a seeded list that never grew. With real
 * producers it is too few: a busy afternoon would push an approval request off
 * the end before the user got back to their desk, which is the one outcome this
 * surface exists to prevent. The renderer's cap and `NOTIFICATION_CAP` in the
 * hub are the same number by intent — a shorter list here would silently
 * discard rows a hydration would then bring straight back.
 */
const NOTIF_CAP = NOTIFICATION_CAP;

/**
 * Console transcript cap (story 041). Oldest lines drop first.
 *
 * Unlike the inbox, this one has a second job: the transcript is replayed into
 * an xterm on every subscribe, so an unbounded array would make opening the
 * orchestrator slower the longer the session had been running.
 */
const ORCH_LINE_CAP = 200;

/**
 * Run-log cap, per agent (HIVE-115).
 *
 * `ORCH_LINE_CAP`'s neighbour, and module-private the same way — except this
 * one is exported. The test that pins it (`tests/stores/hive-store.test.ts`)
 * has to name the real number to prove the cap actually held; hard-coding
 * `2000` there would let the test and the implementation drift apart
 * silently, which a shared constant cannot.
 */
export const AGENT_LINE_CAP = 2_000;

/**
 * The answer for an agent with no run log yet.
 *
 * A module-level frozen constant rather than a literal `[]` in the selector
 * below — a fresh array is a new reference on every call, and a Zustand
 * selector that returns one re-renders its subscriber on every store change
 * whether or not this agent's lines actually changed.
 */
const EMPTY_LINES = Object.freeze([]) as unknown as TermLine[];

/**
 * How many cleared sessions the ENDED group keeps (per fleet, not per terminal).
 *
 * A terminal cleared every twenty minutes for a working day is twenty rows of
 * history in a table whose job is showing what is *running*. Twenty is the same
 * bet `NOTIF_CAP` makes: enough to answer "what did I just finish?", few enough
 * that the live rows stay above the fold.
 *
 * Only `done` rows are capped. A `terminated` row is a process that died and is
 * the only record that it existed; dropping those would lose information the
 * user cannot recover, while a cleared session's successor is right there.
 */
const DONE_CAP = 20;

/**
 * The row a terminal's events belong to **now**.
 *
 * Every hook a session sends carries `HIVE_SESSION_ID`, and that value is baked
 * into the pty's environment at spawn — it never changes, because the pty never
 * restarts. So after a `/clear`, main is still naming the row that has just been
 * retired, and it cannot do better: it does not know the successor exists.
 *
 * Without this, `/clear` looked like it did nothing. The sequence is
 * `SessionEnd{clear}` then `SessionStart{source:'clear'}`, and the second one
 * maps to `idle` — so the row was marked `done` and then immediately un-marked,
 * while every later status went on landing on the retired row and the successor
 * never showed a status at all.
 *
 * Resolving here rather than adding a renderer→main verb keeps main speaking the
 * only id it has and the renderer owning the ids it allocates. The fast path is
 * the overwhelmingly common one: a terminal that has never been cleared answers
 * its own id without a scan.
 */
/**
 * The title a `/clear` leaves behind, per terminal.
 *
 * Claude names a session by writing it into the **terminal title**, and it
 * repaints that title continuously — the activity glyph animates, so the same
 * name arrives many times a second. `/clear` starts a new conversation with no
 * name, but it does *not* reset the title: Claude goes on emitting the old one
 * until the user renames again.
 *
 * That was invisible before, because the row already had the name and
 * `renameSession` drops an unchanged value. A successor has no name, so the
 * stale title landed on it as a rename and the new session inherited the
 * finished one's identity.
 *
 * Held here rather than as a field on `Session` because it is not a property of
 * the session — it is a fact about one terminal's title stream, and it stops
 * being true the moment a different name arrives. Module-level for the same
 * reason `spawnCounter` is, and cleared by `reset()` alongside it.
 */
const staleTitles = new Map<string, string>();

/**
 * The GitHub sweep in flight, or `null`.
 *
 * Module scope rather than store state: it is not something a component renders,
 * and putting it in the store would re-render every subscriber twice per poll
 * to say "a request started" and "a request finished".
 */
let inFlightPrSweep: Promise<void> | null = null;

/**
 * A monotonic ticket for PR searches, so a slow answer cannot overwrite a fast
 * one that came after it.
 *
 * Module scope for the same reason `inFlightPrSweep` is: nothing renders it, and
 * putting a counter in the store would re-render every subscriber to say a
 * request had been numbered.
 */
let prSearchTicket = 0;

/**
 * The Jira sweep in flight, or `null`.
 *
 * Module scope for the reason {@link inFlightPrSweep} is, and it exists for the
 * same reason too — tickets became polled in HIVE-81 and inherited the race the
 * PR side had already solved. See `refreshTickets` for the specific harm.
 */
let inFlightTicketSweep: Promise<void> | null = null;

function currentSessionIn(state: HiveState, terminalId: string): string {
  const direct = state.entities[terminalId];
  if (direct !== undefined && isSession(direct) && !isEnded(direct.status)) {
    return terminalId;
  }

  for (const id of state.order) {
    const entity = state.entities[id];
    if (
      entity !== undefined &&
      isSession(entity) &&
      terminalOf(entity) === terminalId &&
      !isEnded(entity.status)
    ) {
      return id;
    }
  }

  /**
   * No live row — an id nothing has cleared, or a terminal whose last session
   * really did end. Answering the original keeps every existing behaviour
   * (a pty exit still marks the row it names) instead of silently dropping it.
   */
  return terminalId;
}

const capLines = (lines: TermLine[]) =>
  lines.length > ORCH_LINE_CAP ? lines.slice(lines.length - ORCH_LINE_CAP) : lines;

const capAgentLines = (lines: TermLine[]) =>
  lines.length > AGENT_LINE_CAP ? lines.slice(lines.length - AGENT_LINE_CAP) : lines;

/**
 * Why the ledger verbs cannot run in the browser preview (HIVE-113).
 *
 * Store-local rather than a reuse of `SESSIONS_REQUIRE_DESKTOP`: that constant
 * lives in `src/features/sessions/`, and `src/stores/**` may not import
 * `src/features/**`. Worded to match the browser refusals this file already
 * prints for pull requests and search.
 */
const LEDGER_REQUIRES_DESKTOP =
  'the ledger needs the desktop app — this is the browser preview';

/** The `help` output — one row per command in the grammar. */
const HELP_LINES = [
  '  help                       show this list',
  '  status                     one line per session',
  '  ledger [--open] [-n 20]    print the ledger tail',
  '  open <session>             open a session in the center stage',
  '  send <session> <message>   route a message to a session',
  '  ask <session> <message>    ask a session a question',
  '  answer <id> <text>         answer an open ask',
  '  spawn <project> <task>     start a new session on a project',
  '  clear                      empty this transcript',
  /*
    One trailing line rather than a fourth column, because it is a footnote and
    not a verb (HIVE-94). It is the only place the console says out loud that a
    project answers to three different things, and `help` is where a user goes
    to find that out.
  */
  '  <project> is a key, an id or a name — hive, the-hive, "The Hive"',
];

/**
 * How `status` spells and colours each state.
 *
 * Deliberately a second, terminal-side mapping rather than a reuse of
 * `STATUS_LABEL`/`STATUS_TEXT` from `components/ui/status-dot.tsx`: those are
 * CSS classes for DOM, and `stores/` may not import `components/`. The words
 * match; the colours are `TermColor` names, resolved by the ANSI colorizer.
 */
const STATUS_WORD: Record<SessionStatus, string> = {
  working: 'working',
  waiting: 'needs input',
  idle: 'idle',
  done: 'done',
  terminated: 'terminated',
};

/**
 * The terminal-side word, including what is still running (HIVE-83).
 *
 * Deliberately a second mapping rather than a reuse of `statusLabel`:
 * `stores/` may not import `components/`. **The words must match**, and the
 * duplication is the whole risk — `statusLabel` was renamed to say
 * `working (agents)` and this was not, so for one commit the fleet table, the
 * rails and the meta bar all read `working (agents)` while typing `status` into
 * the maestro console printed `idle (agents)` for the same row.
 *
 * `tests/stores/hive-store.test.ts` now asserts the two functions agree across
 * every status and detail, which is the only thing that can keep two mappings
 * in step once a comment has already failed to.
 */
const DETAIL_WORD: Record<IdleDetail, string> = {
  agents: 'agents',
  script: 'scripts',
};

export function statusWord(status: SessionStatus, detail?: IdleDetail): string {
  if (status === 'idle' && detail !== undefined) {
    return `working (${DETAIL_WORD[detail]})`;
  }
  return STATUS_WORD[status];
}

const STATUS_COLOR: Record<SessionStatus, TermLine['color']> = {
  working: 'green',
  waiting: 'amber',
  idle: 'dim',
  done: 'blue',
  /**
   * Dim, like `idle`, and unlike `done`'s blue. Blue is this palette's "there is
   * something here" colour and a terminated row is the one thing on the list
   * with nothing behind it — the word carries the distinction, the colour
   * carries the priority.
   */
  terminated: 'dim',
};

/**
 * The colour that goes with {@link statusWord}, including the detail.
 *
 * The fourth surface, and the one that was left behind. `statusText()` in
 * `status-dot.tsx` closes exactly this gap for the fleet table, the projects
 * rail and the meta bar: a row that now *says* `working` must not be painted in
 * idle's grey. The console prints the same word, from a different mapping,
 * and got the word without the colour — so `status` listed
 * `working (agents)` dimmed while every React surface showed it in green.
 *
 * A second mapping for the same reason `statusWord` is one: `stores/` may not
 * import `components/`, and these are terminal-line colours rather than
 * Tailwind classes anyway.
 */
function statusColor(
  status: SessionStatus,
  detail?: IdleDetail,
): TermLine['color'] {
  if (status === 'idle' && detail !== undefined) return STATUS_COLOR.working;
  return STATUS_COLOR[status];
}

let spawnCounter = 0;

/**
 * Deterministic-enough id for a prototype: `sess-01`, `sess-02`, …
 *
 * **The counter alone is not enough, and the fleet is consulted for a reason.**
 * `spawnCounter` is module state and the entities are store state, so the two
 * can fall out of step: a module re-evaluation (dev HMR does exactly this) puts
 * the counter back to `0` while the rows it already handed ids to are still on
 * screen. The next id minted is then one that is already taken.
 *
 * That is not a cosmetic clash. `entities` is keyed by id, so a `/clear` whose
 * successor collides with the session it just retired writes both under one
 * key — the retired row is overwritten by its own replacement, and `order`
 * carries the same id twice. What the user sees is two rows wearing one name,
 * which is precisely the report this guard answers.
 *
 * Ended rows count as taken. They are still in `entities`, still rendered under
 * ENDED, and reusing the id of a session the user can still see is the bug in
 * its most confusing form: two rows, one name, different statuses.
 */
/**
 * What a stored status becomes on the way back in (HIVE-87).
 *
 * Three answers, and the middle one is the feature:
 *
 * - An ending that was **recorded** — `done`, `terminated` — comes back exactly
 *   as it was. `terminated` especially: it is never capped, on the grounds that
 *   it is the only record a process existed, and rewriting it here would forfeit
 *   that.
 * - Anything **live** becomes `done` with `endedBy: 'app-closed'`. A record
 *   claiming to be `working` is describing a process that died with the app that
 *   owned it, a launch ago. The user quit; that is a deliberate ending.
 * - Anything **unrecognised** is `undefined`, and its record is dropped. The
 *   file may have been written by a build that knew a status this one does not,
 *   and a row the table cannot render is worse than a row missing from it.
 */
/**
 * The closed lists, checked rather than assumed (HIVE-87).
 *
 * `session-history-contract.ts` types `model` and `effort` as the unions but the
 * file they come from is not typed at all, and `history.ts` deliberately does not
 * re-check them — it points here instead. These are what make that pointer
 * true.
 */
const isKnownModel = (value: string | undefined): value is Model =>
  value !== undefined && (SESSION_MODELS as readonly string[]).includes(value);

const isKnownEffort = (value: string | undefined): value is Effort =>
  value !== undefined && (SESSION_EFFORTS as readonly string[]).includes(value);

/**
 * How a stored record reads once the app it described is gone (HIVE-93).
 *
 * Returns the ending **and how it was arrived at**, because the two are no
 * longer the same question. A record that says `working` is not working — the
 * process died with the app that owned it — and that inference used to be
 * spelled by mapping it to a `closed` status. With `closed` folded into `done`,
 * the status alone can no longer distinguish an *inferred* ending from a
 * *recorded* one, and hydrate genuinely needs to: `live` is exactly "main says
 * there is a process behind an id whose record claims one".
 *
 * `undefined` means a status this build does not know — a record written by a
 * newer one. The caller drops such a row rather than guessing at it.
 */
function restoredStatus(
  stored: string,
  recorded?: string,
): { status: SessionStatus; endedBy?: Session['endedBy'] } | undefined {
  /*
    Recorded endings keep whatever they were. `done` here is a `/clear` or a
    `/done` that main wrote down; which one it was is not recoverable from the
    file, and `endedReason` treats an absent `endedBy` as the older of the two.
  */
  if (stored === 'done') {
    /*
      The record's own answer where it has one (HIVE-93). Without it every
      restored `/done` row is described as "was cleared", which is the one
      sentence that is false for all of them — and shown beside a Resume button,
      so the tooltip and the control contradict each other.
    */
    return recorded === 'finished'
      ? { status: 'done', endedBy: 'finished' }
      : { status: 'done' };
  }
  if (stored === 'terminated') return { status: 'terminated' };
  /*
    An inferred ending. The record claims to be live and plainly is not, so it
    ended when the app did — which is a deliberate ending in the user's terms
    (they quit) and therefore `done`, with `endedBy` carrying the how.
  */
  if (stored === 'working' || stored === 'waiting' || stored === 'idle') {
    return { status: 'done', endedBy: 'app-closed' };
  }
  return undefined;
}

/**
 * A restored row that has come back to life stops being restored (HIVE-88).
 *
 * `restored` records where a row came from, which is durable; whether the row
 * is live depends on what it is doing *now*, which is not. Reopening a restored
 * row spawns a process under its own id, and the first live status that process
 * reports is the moment the row is this run's fleet.
 *
 * Left in place, the flag put one entity in two groups: while the fleet table
 * drew a PREVIOUS RUN divider, `useActiveSessions` keyed on the status and the
 * restored list keyed on the flag, and a `working` row with `restored: true`
 * satisfied both — two rows, one agent. That divider is gone, so the
 * double-draw is no longer reachable that way, but clearing the flag is still
 * right for the reason it always was: the row is not a previous run's any more,
 * and `endedReason` would go on describing it as one.
 *
 * Only a **live** status revives. A spawn that fails settles `terminated`
 * without the row ever having run, and that is still last run's row.
 *
 * Mutates and returns `updated`, which every caller has just spread into a
 * fresh object — the same shape as the `idleDetail` delete beside it.
 */
function reviveIfLive(updated: Session): Session {
  if (updated.restored === true && !isEnded(updated.status)) {
    delete updated.restored;
  }
  return stampLifecycle(updated);
}

/**
 * Keep `endedAt` agreeing with the status it describes.
 *
 * Stamped **once**, by whichever write first puts a row in an ended status, and
 * removed again if the row comes back to life. Both halves matter: without the
 * stamp the fleet table has nothing to sort ended rows by, and without the
 * clear a resumed session would carry the time it stopped while running.
 *
 * Idempotent on purpose, because an ending is reached by more paths than it
 * looks like — `/done` and the pty exit that follows it both arrive, and
 * `settleExit` can be reached twice (`ptyExit` and `ptyLost`). Re-stamping would
 * make a row's ending drift later every time something re-observed it, which is
 * exactly the value the table would then sort on.
 *
 * Mutates and returns the session, which every caller has just spread into a
 * fresh object — the same shape as {@link reviveIfLive} beside it, and it is
 * called *from* there so the two can never be applied separately.
 */
function stampLifecycle(session: Session): Session {
  if (isEnded(session.status)) {
    if (session.endedAt === undefined) session.endedAt = Date.now();
  } else if (session.endedAt !== undefined) {
    delete session.endedAt;
  }
  return session;
}


/**
 * Newest first, and **stable** for everything that ties.
 *
 * `Array.prototype.sort` is stable, and the ids arrive in `order` — so rows
 * that cannot be told apart by time keep the sequence they were inserted in
 * rather than an arbitrary one. That is the whole handling of the untimestamped
 * case, and it is deliberately a *no-op* rather than a guess: a fixture, or a
 * record from a build before `createdAt` existed, carries no claim about when
 * it happened, and inventing one from its position would be making the same
 * mistake `Session.branch` was fixed for. Every row the app itself creates or
 * restores has a timestamp, so ties do not arise outside of tests.
 *
 * Takes the entities map rather than a list of sessions because every caller
 * has already filtered `order` down to ids and would otherwise have to look
 * each one up twice.
 */
function byRecency(
  ids: readonly string[],
  entities: Record<string, Entity>,
): string[] {
  return [...ids].sort((a, b) => {
    const left = entities[a];
    const right = entities[b];
    if (!left || !isSession(left) || !right || !isSession(right)) return 0;
    return recencyOf(right) - recencyOf(left);
  });
}

/**
 * Keep the spawn counter ahead of an id that already exists (HIVE-87).
 *
 * `nextSessionId`'s `while (id in taken)` guard already prevents a *collision*,
 * but only by skipping: with the counter at zero and `sess-05` restored, the
 * next four spawns take `sess-01`…`sess-04` and the fifth silently jumps the
 * gap. That is a fleet whose ids no longer say anything about order, and it is
 * the kind of thing that reads as a bug in the session history long after the
 * session history has stopped being involved.
 *
 * Parsed base 36 because that is what `nextSessionId` formats with. An id that
 * does not match the pattern — a fixture, a hand-edited file — is ignored
 * rather than rejected: it cannot collide with a generated one anyway.
 */
function rememberSpawnId(id: string): void {
  const match = /^sess-([0-9a-z]+)$/.exec(id);
  if (match?.[1] === undefined) return;
  const seen = Number.parseInt(match[1], 36);
  if (Number.isFinite(seen) && seen > spawnCounter) spawnCounter = seen;
}

function nextSessionId(taken: Readonly<Record<string, Entity>>): string {
  let id: string;
  do {
    spawnCounter += 1;
    id = `sess-${spawnCounter.toString(36).padStart(2, '0')}`;
  } while (id in taken);
  return id;
}

/**
 * What to call a session started for a ticket (HIVE-78).
 *
 * `HIVE-73`, then `HIVE-73-2`, `HIVE-73-3` — the key itself for the first one,
 * because a suffix on a session that has no sibling is noise.
 *
 * ## Why the whole fleet is searched, ended rows included
 *
 * A `done` session keeps its name and keeps its row: `DONE_CAP` leaves it in the
 * rails, and the WORK card lists it under its ticket. Two rows reading `HIVE-73`
 * — one finished this morning, one open now — is exactly the ambiguity the
 * suffix exists to remove, and skipping ended rows would reintroduce it in the
 * common case of picking a ticket back up.
 *
 * ## Why it is a name and not the id
 *
 * The id is the entities-map key, it is what `order` holds, and it is what every
 * console line spells. Renaming *that* would turn a label into a graph rewrite
 * — the argument `Session.name` already makes for HIVE-61, unchanged here.
 *
 * The result always satisfies `SESSION_NAME_PATTERN`: a Jira key is uppercase,
 * digits and one hyphen, and the suffix adds a hyphen and digits. So it survives
 * the IPC guard and reaches `claude --name`.
 */
function ticketSessionName(
  ticketKey: string,
  entities: Record<string, Entity>,
): string {
  const taken = new Set(
    Object.values(entities)
      .filter(isSession)
      .map((session) => session.name)
      .filter((name): name is string => name !== undefined),
  );

  if (!taken.has(ticketKey)) return ticketKey;

  /**
   * Starts at 2, so the second session for a ticket is `-2`. Bounded only by
   * the loop finding a gap, which it always does: `taken` is finite.
   */
  let suffix = 2;
  while (taken.has(`${ticketKey}-${suffix}`)) suffix += 1;
  return `${ticketKey}-${suffix}`;
}

const line = (text: string, color: TermLine['color'] = 'ink'): TermLine => ({
  text,
  color,
});

/**
 * The six slices that boot empty, because each now has a real producer.
 *
 * Sessions and agents arrive from PTYs the user starts, projects from the
 * config file, tickets from Jira, and the console transcript from what the
 * orchestrator actually does. Seeding any of them meant the app opened already
 * claiming a fleet that was not running — the header counted ten sessions on a
 * machine with none, and the WORK tab painted eight sample tickets that a real
 * Jira read then replaced a frame later.
 *
 * Spelled out here rather than left to `createInitialState()` so the empty state
 * is a deliberate, typed object instead of an absence: adding a slice to
 * {@link HiveState} without deciding where it comes from will fail to compile.
 *
 * A factory, for the same reason `createInitialState()` is one — a shared
 * constant would hand every store and every `reset()` the *same* arrays, so one
 * test appending a session would leak into the next.
 *
 * ## What HIVE-87 changed here, and what it deliberately did not
 *
 * `entities` and `order` are no longer empty for the whole of a launch:
 * {@link HiveActions.hydrateSessions} puts last run's sessions back shortly
 * after the first paint. That reads like a reversal of everything above, so the
 * difference is worth stating — **the seeds are still empty, and the rows still
 * arrive from a real producer.** The producer is main's session history rather
 * than a pty, and every row it supplies is one that has already ended.
 *
 * The failure this comment is about is untouched. A seeded fleet claimed
 * sessions were *running* that were not, and a real read replaced them a frame
 * later; a restored fleet claims only that some sessions once ran, arrives
 * after the paint rather than before it, and nothing overwrites it.
 */
const emptySeeds = (): Pick<
  HiveState,
  'entities' | 'order' | 'agentOrder' | 'tickets' | 'prs' | 'orchLines'
> => ({
  entities: {},
  order: [],
  agentOrder: [],
  tickets: [],
  /*
    `prs` moved here from the fixtures the day GitHub started feeding it. The
    panel boots empty and says so, rather than painting four sample rows for a
    frame and swapping them — which is the same flash story HIVE-69 fixed for
    tickets.
  */
  prs: [],
  orchLines: [],
});

/**
 * Whether a sweep found anything the panel would draw differently.
 *
 * Every field of `PrRecord` is compared, because every field of `PrRecord` is
 * one a surface renders or resolves against — that is the contract the type
 * states, and a comparison narrower than the type would go quietly wrong the
 * day a field was added. Order counts too: `collectPrs` sorts live work above
 * what landed, so a reordering is a real change even when the set is the same.
 *
 * Deliberately not `JSON.stringify` equality, which is the same work with a
 * silent dependency on key order and an allocation the size of the whole list,
 * once a minute, forever.
 */
function samePrs(next: readonly PrRecord[], previous: readonly PrRecord[]): boolean {
  if (next.length !== previous.length) return false;

  return next.every((pr, index) => {
    const before = previous[index];
    return (
      pr.number === before.number &&
      pr.title === before.title &&
      pr.url === before.url &&
      pr.repo === before.repo &&
      pr.owner === before.owner &&
      pr.branch === before.branch &&
      pr.state === before.state &&
      pr.findings === before.findings &&
      pr.checks === before.checks &&
      pr.updatedAt === before.updatedAt
    );
  });
}

/**
 * Whether a sweep found anything the WORK panel would draw differently.
 *
 * Every field of the stored ticket is compared, for the reason {@link samePrs}
 * gives: a comparison narrower than the shape goes quietly wrong the day a
 * field is added. Order counts — the JQL sorts by `updated`, so a reordering is
 * a real change even when the set is identical.
 */
function sameTickets(
  next: readonly Ticket[],
  previous: readonly Ticket[],
): boolean {
  if (next.length !== previous.length) return false;

  return next.every((ticket, index) => {
    const before = previous[index];
    return (
      ticket.key === before.key &&
      ticket.status === before.status &&
      ticket.statusCategory === before.statusCategory &&
      ticket.title === before.title &&
      ticket.url === before.url
    );
  });
}

export const useHiveStore = create<HiveState>()((set, get) => ({
  ...emptySeeds(),
  notifs: [],
  ledger: [],
  metrics: {},
  /**
   * Loading until the first read answers.
   *
   * Not `unconfigured`, which is a *conclusion* — it would flash "no Jira
   * connection" at every launch on a perfectly configured machine before the
   * status read came back. The browser target reaches `unconfigured` a tick
   * later, from {@link HiveState.refreshTickets}, because a browser genuinely
   * has no bridge to Jira.
   */
  ticketSource: { kind: 'loading' } as TicketSource,

  /** Loading until the first sweep answers, for the same reason as above. */
  prSource: { kind: 'loading' } as PrSource,
  prSearch: { term: '', results: null, searching: false, error: null } as PrSearchState,

  /**
   * Create a session and open its tab.
   *
   * Actions that span both stores call the other store's action explicitly —
   * no store subscribes to the other. That keeps the dependency one-way and
   * makes the cross-store effect visible at the call site.
   */
  spawnSession: (projectId, task, model, effort, ticket) => {
    const id = nextSessionId(get().entities);
    // Resolved once: the seed transcript quotes them back, so a default applied
    // in two places could print one model and record another.
    const resolvedModel = model ?? 'opus';
    const resolvedEffort = effort ?? 'high';

    /**
     * A session started from a ticket card is called after its issue (HIVE-78).
     *
     * Resolved here rather than in the picker because collision-avoidance needs
     * to see the whole fleet, and the store is what holds it.
     *
     * **It no longer goes onto the command line** (HIVE-108). Sending it as
     * `--name` made the row and the agent agree from the first frame, at the
     * cost of every name after it: the flag suppresses Claude's own titling, so
     * a ticket session stayed `HIVE-73` for its whole life and never said what
     * it was *for*. The key is kept in front by pinning it instead, which is
     * what turns `HIVE-73` into `HIVE-73-back-key-interception` once the agent
     * has a topic — and pinning is now the *only* thing defending it, which is
     * why it is set here rather than only by `setSessionTicket`.
     */
    const name = ticket
      ? ticketSessionName(ticket, get().entities)
      : undefined;

    const session: Session = {
      kind: 'session',
      id,
      project: projectId,
      /**
       * Only present when the picker was opened from a ticket card, which is
       * why it is spread conditionally rather than assigned `undefined`: an
       * explicit `ticket: undefined` key is a different object shape from an
       * absent one, and the store's snapshots are compared in tests.
       */
      ...(ticket ? { ticket } : {}),
      /**
       * Named up front only when a ticket said what to call it, and **pinned**
       * with it (HIVE-108). Spread for the same reason `ticket` is: an explicit
       * `name: undefined` is a different object shape from an absent key, and
       * these snapshots are compared.
       *
       * The pin used to be the mid-session path's alone, on the reasoning that a
       * ticket-card spawn had a command line to put the name on and did not need
       * one. It no longer has a command line, so without the pin the agent's
       * first title would simply replace `HIVE-73` and the ticket would fall off
       * the row that was opened from its card.
       */
      ...(name === undefined ? {} : { name, namePinned: true as const }),
      /**
       * **No `branch` here, and that is the fix** (HIVE-78).
       *
       * This line used to read ``branch: `feat/${id}` ``, naming a branch
       * nothing had created. Main now reports the real one — read with
       * `git rev-parse` in the directory the agent is actually working in — and
       * until that arrives the field is absent and every surface shows an em
       * dash. A moment of "not known yet" is a much smaller lie than
       * `feat/sess-01`, which was never true at any moment.
       */
      status: task ? 'working' : 'idle',
      /**
       * Empty, not a placeholder string. Story 044 suggests seeding the *task
       * field* with "Ready for instructions", but story 043 wants that prompt in
       * the **transcript** (`· Ready — type below…`) — which is where the user
       * is actually looking. Putting a fake task on the entity would also make
       * the meta bar and the rails claim a task that nobody set.
       */
      task: task ?? '',
      /**
       * Covered until Claude is on screen (HIVE-101).
       *
       * Set here rather than when the pty reports anything, because the wait
       * this hides *starts* here: the shell is already loading `direnv` before
       * main has finished answering the spawn. Desktop only — the browser demo
       * has no process to boot and no `SessionStart` will ever arrive to
       * uncover it.
       */
      ...(isDesktop() ? { booting: true } : {}),
      /*
        What the fleet table sorts a live row by. Stamped here rather than
        derived from the id, because ids are reused across a restart and a
        `/clear` successor is minted out of sequence — neither says when.
      */
      createdAt: Date.now(),
      cost: '$0.02',
      model: resolvedModel,
      effort: resolvedEffort,
      lines: [
        line(
          `❯ claude --model ${resolvedModel} --effort ${resolvedEffort} — new session on ${projectId}`,
          'green',
        ),
        line('● Reading CLAUDE.md, mapping repo…', 'blue'),
        task
          ? line(`✱ ${pickPhrase('working.session')} ${task}`, 'amber')
          : line('· Ready — type below to give this session its task', 'dim'),
      ],
    };

    set((state) => ({
      entities: { ...state.entities, [id]: session },
      order: [...state.order, id],
    }));

    /**
     * No `spawned sess-0x on <project>` line here (HIVE-91).
     *
     * At this moment the session has nothing but its id — its name arrives
     * later, from the status-line title or a rename — so the only thing the
     * console could print is the one label the user never sees anywhere else.
     * The session lists already show what launched; the console keeps only
     * what they cannot show, which is the refusal below.
     */

    /**
     * Ask for the process **here**, not when a surface mounts (story 097).
     *
     * The lazy path works — `PtyTransport` requests a spawn on subscribe — but
     * its refusal reaches only the terminal, asynchronously, and only if a
     * surface mounted at all. The console has to print main's exact message,
     * so the request is made where the transcript is — whoever asked for the
     * spawn: the `spawn` command, the picker (044), or a future daemon event.
     * Logging here rather than at each call site is what makes sure the picker
     * gets the refusal too.
     *
     * Safe in either order: `requestSpawn` and the transport share one channel,
     * so whoever asks first is the only one who asks, and main's `open()` is
     * attach-never-respawn regardless.
     */
    if (isDesktop()) {
      /**
       * The **resolved** model and effort, not the arguments (story 109).
       *
       * `resolvedModel`/`resolvedEffort` are what the entity records and what
       * the meta bar chip renders, so sending them is what makes the chip true:
       * a console `spawn` that named neither now starts explicitly as opus/high
       * because that is what the row it just created claims. Sending the raw
       * arguments would leave those two disagreeing for exactly the sessions
       * nobody chose for.
       */
      void requestSpawn(id, projectId, {
        ...(task === undefined ? {} : { task }),
        model: resolvedModel,
        effort: resolvedEffort,
        /*
          No `name` (HIVE-108). It used to be sent here whenever a ticket named
          the row, which is precisely the case that most wants an inferred name
          — and `--name` is what stops Claude producing one. The row keeps its
          key by being pinned, not by telling the agent about it.
        */
        /**
         * The app's own theme, so `claude` dresses its UI to match the terminal
         * it is drawing into.
         *
         * **Read, not subscribed.** `appearance-store` is another store and
         * this is a one-shot read inside an action, which is the shape the
         * architecture allows — what it forbids is a store *subscribing* to
         * another, and a subscription here would re-spawn nothing and mean
         * nothing: the value is consumed at this instant and written into a
         * file the session reads once, at startup. Toggling the theme repaints
         * the app and every terminal palette; agents already running keep the
         * chrome they were started with until they are restarted.
         */
      }).then((outcome) => {
        /*
          The ticket link, so it survives a quit (HIVE-87) — and **after** the
          spawn resolves, not before it.

          This used to run above, beside the `requestSpawn` call. Both are
          `invoke` on one pipe and arrive in order, so main handled the note
          first, found no record for this entity yet, and dropped it by the
          guard that stops a note inventing a row for a session that never
          existed. Deterministic rather than a narrow race: the ticket-card
          spawn — the reason the field exists — never persisted its ticket, and
          only the mid-session intent path ever did.

          `SpawnRequest` still does not carry it. A ticket is not a property of
          *starting* a process, and the other path that establishes the link
          happens long after any spawn; one verb for both keeps a single answer
          to "how does main learn a session's ticket".
        */
        /*
          The name rides along with it (HIVE-108), which it did not have to
          before: main used to learn this row's name from the `--name` on its
          own command line, and there is no longer one. A note carrying a name
          is what sets `namePinned` in the session history, so without it the file would
          take the agent's first title unpinned — and the next launch would
          restore `back-key-interception` for a row the app is showing as
          `HIVE-73-back-key-interception`.
        */
        if (outcome.ok && ticket !== undefined) {
          noteSessionTicket({ entityId: id, ticket, ...(name === undefined ? {} : { name }) });
        }
        if (outcome.ok) return;
        set((state) => ({
          orchLines: capLines([
            ...state.orchLines,
            line(`  ${outcome.reason}`, 'red'),
          ]),
        }));
      });
    }

    useUiStore.getState().openTab(id);

    return id;
  },

  /**
   * Route a message to an entity.
   *
   * **The one branch point in the coordination layer** (story 097). A real
   * session takes the pty path; everything else keeps the prototype's
   * round-trip, and the returned {@link SendOutcome} says which happened.
   */
  sendToEntity: (id, msg, origin = 'orchestrator') => {
    const entity = get().entities[id];
    if (!entity) return null;

    /**
     * Agents are the interesting half of "everything else".
     *
     * They have no project and no process this epic (story 096's scope note),
     * so a pty path would refuse every message where the demo answers one. The
     * browser target lands here too, for a different reason — there is no
     * bridge to ask. One predicate covers both, which is what keeps a surface
     * from becoming typable while its transport stays a recording.
     */
    if (isDesktop() && isSession(entity)) {
      /**
       * Addressed to the **terminal**, because that is what owns the channel.
       *
       * `pty-transport` keys its channels by the id `createPtyTransport` was
       * given, and that is `terminalOf(session)`. A successor minted by
       * `/clear` has a row id its terminal does not answer to, so sending on
       * the row id refused every message — `sess-02 has no live session` — for
       * a pty that was running and typable.
       *
       * The *messages* still name the row, because that is what the user typed
       * and what they see in the rails.
       */
      const result = sendToSession(terminalOf(entity), msg);

      /**
       * No echo, and no acknowledgement timer.
       *
       * The pty echoes what it receives, so appending the sent text here too
       * would double-print every message. And the status now comes from the
       * process itself (story 096) rather than from a timer narrating one —
       * which is the whole point of this story: session status stops being
       * told by the UI and starts being observed.
       */
      return result.ok
        ? { kind: 'routed' }
        : { kind: 'refused', reason: result.reason };
    }

    /**
     * The echo differs by where the message came from, because the transcript
     * is a record of who said what. A line routed by the console is marked as
     * such; one typed into the session's own input row is the user speaking
     * directly, and gets a blank line above it so it reads as a new turn.
     */
    const echo =
      origin === 'orchestrator'
        ? [line(`❯ [overmind] ${msg}`, 'cyan')]
        : [line(''), line(`❯ ${msg}`, 'cyan')];

    get().appendEntityLines(id, echo);
    /**
     * One timer per message, deliberately: two rapid sends produce two
     * independent acknowledgements rather than one that cancels the other.
     * This mimics the future daemon's round-trip, so the UI is already
     * event-shaped.
     *
     * `appendEntityLines` only applies a status to sessions, so agents stay
     * `online` without a branch here.
     */
    return {
      kind: 'demo',
      timer: setTimeout(() => {
        get().appendEntityLines(
          id,
          [line(ACK_LINE, 'blue'), line(`✱ ${pickPhrase('working.session')}`, 'amber')],
          'working',
        );
      }, ACK_DELAY_MS),
    };
  },

  /**
   * Open an entity's tab — unless its process is gone (story 108).
   *
   * **The single gate every "show me this session" path goes through.** Six
   * components used to call `ui-store`'s `openTab` directly, which is fine while
   * every entity is openable and becomes six independent bugs the moment one is
   * not. Whether a session can be entered is a fact about the *domain*, so the
   * domain store is where it is decided, and the view store keeps its one job:
   * recording what is on screen.
   *
   * A terminated session is refused rather than opened-and-empty. Its pty is
   * gone; entering it shows a dead rectangle that swallows keystrokes and offers
   * no way back except the mouse — which is precisely the trap this replaces.
   * The user is sent to the orchestrator instead, where the row still exists,
   * still readable, still explaining itself.
   *
   * Refusing is **not** the same as hiding. A session that ends while the user
   * is watching it stays on screen: the exit notice is the most useful thing in
   * the transcript, and yanking the view out from under someone the instant
   * their agent quits would make the ending impossible to read. This gate is
   * about coming *back*.
   *
   * Returns whether the tab was opened, so a caller with a transcript to write —
   * the console's `open` — can say what happened.
   */
  openEntity: (id) => {
    /**
     * An id this store has never heard of is **passed through**, not refused.
     *
     * The gate exists to stop one specific thing — entering a session whose
     * process is gone — and widening it into a general existence check would
     * change behaviour nobody asked to change: `resolve-view` already sends an
     * unknown `activeTab` to the orchestrator, deliberately, so that a session
     * removed while its tab is open leaves the user somewhere rather than on a
     * blank stage. Duplicating that decision here would put two answers to one
     * question in two files.
     */
    /**
     * Ended, however it ended — the gate widened with `/clear` (was
     * `isTerminated`).
     *
     * A `done` session's pty is alive, which is exactly why it must be refused:
     * that terminal belongs to the successor now. Opening the retired row would
     * put the *new* session's output on screen under the *old* session's name,
     * and let the user type into work they think they finished.
     */
    /**
     * **No ending opens any more** (HIVE-93).
     *
     * A restored row used to be the exception: refusing it made resuming
     * unreachable, because clicking the row *was* the resume. That is no longer
     * true — Resume is its own control on rows that carry
     * {@link Session.resumable}, so the affordance has somewhere to live that is
     * not "the status happens to permit a click".
     *
     * Which leaves this gate saying one thing: an ended row is not a terminal
     * you can walk into. Opening one would show a pty that is gone, or one that
     * belongs to a successor.
     */
    const entity = get().entities[id];
    if (
      !(
        entity !== undefined &&
        isSession(entity) &&
        isEnded(entity.status)
      )
    ) {
      useUiStore.getState().openTab(id);
      return true;
    }

    useUiStore.getState().backToOrch();
    return false;
  },

  /**
   * Execute an already-parsed orchestrator console command (story 041).
   *
   * Takes a `ParsedCommand`, not a string. Parsing is pure and lives in
   * `features/orchestrator/utils/parse-command.ts`; the store may not import
   * `features/`, and more importantly the two jobs fail differently — the
   * parser catches shape errors ("send with no message"), this catches
   * existence errors ("no such session"). Keeping them apart is what makes both
   * exhaustively testable.
   */
  runOrchCommand: (command) => {
    // A blank line is a no-op, not an error: the user pressed Enter on nothing.
    if (command.kind === 'empty') return;

    const pushOrch = (text: string, color: TermLine['color'] = 'ink') =>
      set((state) => ({
        orchLines: capLines([...state.orchLines, line(text, color)]),
      }));

    /**
     * Turn what the user typed into an entity, or print why it could not be
     * (HIVE-92).
     *
     * Shared by `open` and `send` because they failed identically and must go on
     * doing so — two copies of a three-branch refusal is how one of them ends up
     * accepting a name the other rejects. Returns `null` once the refusal has
     * been printed, so each caller's happy path stays a single `if`.
     *
     * The label comes back alongside the id because every line the console
     * prints afterwards should name the session the way the fleet does, not the
     * way it was typed. See {@link resolveEntityRef} for why an exact id wins and
     * why ambiguity is reported rather than resolved.
     *
     * `ended` rides along for the same reason (HIVE-93): both verbs have to
     * refuse a finished session, and both have to say *which* ending it was. It
     * is the finished sentence rather than a boolean so neither caller can
     * reconstruct it — reconstructing it at two call sites is how `open` came to
     * report a cleared session as terminated. `null` means the target is live.
     */
    const resolve = (
      ref: string,
    ): { id: string; label: string; ended: string | null } | null => {
      const match = resolveEntityRef(ref, get().entities);

      if (match.kind === 'none') {
        pushOrch(`  no such session: ${ref}`, 'red');
        return null;
      }

      if (match.kind === 'ambiguous') {
        pushOrch(
          `  ${ref} matches ${match.labels.join(', ')} — use a session id`,
          'red',
        );
        return null;
      }

      const entity = get().entities[match.id];
      return {
        id: match.id,
        // Non-null in practice: `resolveEntityRef` only reports ids it found in
        // this same map. Narrowed rather than asserted so a future refactor that
        // breaks that cannot render `undefined` into the transcript.
        label: entity === undefined ? match.id : entityLabel(entity),
        /**
         * Agents are never "ended" — they have no lifecycle and no pty, so the
         * gate does not apply to them and they answer `null` like a live session.
         */
        ended:
          entity !== undefined && isSession(entity) && isEnded(entity.status)
            ? endedReason(entity)
            : null,
      };
    };

    /**
     * Echoed **one `TermLine` per line**, not one line carrying newlines.
     *
     * `ORCH_LINE_CAP` bounds the replay by counting entries, and the surface
     * renders with `convertEol: true` — so a single entry holding sixty
     * newlines is one row to the cap and sixty rows on screen. The console has
     * been a textarea since `Shift+Enter` landed, which is what made that
     * reachable: one pasted block could push the transcript far past the bound
     * that exists so opening the orchestrator does not get slower all session.
     *
     * The prompt glyph marks the first line only; the rest are indented to sit
     * under it, which is also how a multi-line command reads back.
     */
    command.raw.split('\n').forEach((line, index) => {
      pushOrch(index === 0 ? `❯ ${line}` : `  ${line}`, 'green');
    });

    switch (command.kind) {
      case 'help': {
        for (const entry of HELP_LINES) pushOrch(entry, 'dim');
        return;
      }

      case 'status': {
        const state = get();
        for (const id of state.order) {
          const entity = state.entities[id];
          if (!entity || !isSession(entity)) continue;
          /**
           * One colour per line, not per column: `TermLine` carries a single
           * colour and the transcript is rendered through it. Colouring the
           * whole row by status keeps the signal — a wall of amber is still
           * "these need you" at a glance.
           */
          pushOrch(
            /**
             * `branchLabel`, not `entity.branch` — this is the **fourth**
             * branch surface (HIVE-78) and the easiest to forget, because it
             * builds a string instead of rendering a component. Interpolating
             * the optional field raw printed the literal `undefined` for every
             * session whose branch had not been observed yet.
             */
            /**
             * `entityLabel`, not `entity.id` (HIVE-92).
             *
             * This column is what tells the user what to type at `send` and
             * `open`, so printing the id while every other surface printed the
             * name made the console disagree with the app *and* with itself —
             * `status` named `sess-04`, the rails named `INCORP-455`, and only
             * one of the two was accepted. Now the column and the argument are
             * the same string.
             */
            /*
              18, not 13. The status column here is padded to the widest word it
              can hold, and `working (scripts)` is 17 characters — the same
              rename that widened the fleet table's `STATUS` column overruns this
              one, and a `padEnd` that is short does not truncate, it simply
              stops aligning: one row's project would start three columns right
              of its neighbours'.
            */
            `  ${entityLabel(entity).padEnd(16)}${statusWord(entity.status, entity.idleDetail).padEnd(18)}${entity.project} · ${branchLabel(entity)}`,
            statusColor(entity.status, entity.idleDetail),
          );
        }
        return;
      }

      case 'ledger': {
        if (!isDesktop()) {
          pushOrch(`  ${LEDGER_REQUIRES_DESKTOP}`, 'red');
          return;
        }
        /*
          Read from the store's own mirror, not over IPC (HIVE-113).

          `runOrchCommand` is synchronous, and `use-ledger-sync.ts` already
          keeps this slice hydrated and pushed — an `invoke` here would make the
          whole verb async to fetch what is already sitting in memory. Filtering
          goes through the same `matches`/`openAsks` main uses, so the console
          and the log cannot drift apart about what "open" means.
        */
        const now = Date.now();
        const query: LedgerReadQuery = {
          ...(command.from === undefined ? {} : { from: command.from }),
          ...(command.to === undefined ? {} : { to: command.to }),
        };
        /**
         * Open-ness is derived from the **whole log**, then filtered — never
         * the other way round.
         *
         * `openAsks` decides "answered" by scanning the array it is handed, and
         * an answer is always addressed back to the asker rather than to the
         * ask's recipient. So any `--from`/`--to` filter applied first removes
         * the answers while keeping the asks, and `ledger --open --to <party>`
         * would report every already-answered question as still open. Main
         * states the same rule on `Ledger.read` for the same reason; this is
         * the console keeping its side of it.
         */
        const entries = command.open
          ? openAsks(get().ledger, now).filter((entry) => matches(entry, query))
          : get().ledger.filter((entry) => matches(entry, query));

        for (const row of ledgerRows(entries, {
          now,
          showEvents: command.events,
          limit: command.limit,
        })) {
          pushOrch(row.text, row.color);
        }
        return;
      }

      case 'clear': {
        set({ orchLines: [line('console cleared — help for commands', 'dim')] });
        return;
      }

      case 'open': {
        const match = resolve(command.target);
        if (match === null) return;
        /**
         * The refusal is printed, not swallowed (story 108). A console that
         * answered `opened sess-02` and then did not open it would be worse
         * than one that said nothing at all.
         *
         * **And it now says which ending it was** (HIVE-93). This branch used to
         * print the terminated sentence for both, so a *cleared* session — whose
         * process is alive and busy on someone else's behalf — was reported as
         * "its process is gone". `endedReason` owns the distinction.
         */
        if (!get().openEntity(match.id)) {
          pushOrch(`  ${match.ended ?? `${match.label} cannot be opened`}`, 'red');
          return;
        }
        pushOrch(`  opened ${match.label}`, 'dim');
        return;
      }

      case 'send': {
        const match = resolve(command.target);
        if (match === null) return;

        /**
         * An ended session is refused **before** `sendToEntity`, and this is a
         * correctness gate rather than a nicety (HIVE-93).
         *
         * `sendToEntity` routes by `terminalOf(entity)`, and a cleared row's
         * terminal is inherited by its successor — see `endedReason` and
         * `isTerminated`. So `send <cleared-row> <message>` did not merely poke a
         * finished session: it typed the user's message into **a different,
         * live agent's** prompt, under a row that says `done`. The terminated
         * case was only wasteful by comparison; this one crosses sessions.
         *
         * Refused after resolution rather than before, so the message still
         * names the row the way every other surface does (HIVE-92) instead of
         * echoing back whatever was typed.
         */
        if (match.ended !== null) {
          pushOrch(`  not sent — ${match.ended}`, 'red');
          return;
        }

        const outcome = get().sendToEntity(match.id, command.message);
        if (outcome?.kind === 'refused') {
          /**
           * Verbatim. The console prints failures; it does not translate or
           * soften them. The reason names what the user has to do about it —
           * open the session, or restart it — and a generic "could not send"
           * would be honest and useless.
           */
          pushOrch(`  ${outcome.reason}`, 'red');
          return;
        }
        /**
         * The **resolved** label, not what was typed. A user who typed
         * `incorp-455` is told it went to `INCORP-455`, which is the row they
         * can see — echoing their own casing back would leave them unsure
         * whether it matched at all.
         */
        pushOrch(`  routed → ${match.label}`, 'dim');
        return;
      }

      case 'ask': {
        if (!isDesktop()) {
          pushOrch(`  ${LEDGER_REQUIRES_DESKTOP}`, 'red');
          return;
        }
        const match = resolve(command.target);
        if (match === null) return;

        /**
         * Addressed by **terminal**, not by row id.
         *
         * Main's party space is the one its registry is keyed by, and that is
         * `terminalOf(session)` — the same id `sendToEntity` routes on, and the
         * same one `knowsParty` checks. The two agree for every session that
         * has never been cleared, and diverge exactly where it matters: a
         * cleared row's successor carries a fresh `id` with the *predecessor's*
         * `terminalId`. Posting the row id there addresses a party main has
         * never heard of, and the ask is silently never delivered — while
         * posting the *cleared* row's id names a terminal whose live pty now
         * belongs to the successor, writing the nudge into a different agent's
         * prompt. `send` has a documented guard against precisely that
         * crossing; this is the same hazard reached through the log.
         */
        const entity = get().entities[match.id];
        const party =
          entity !== undefined && isSession(entity) ? terminalOf(entity) : match.id;

        /**
         * Deliberately **not** gated on `match.ended`, unlike `send`.
         *
         * `send` must refuse a finished session because it writes *now*, into
         * whatever pty holds that terminal at this instant. An ask is written
         * down and delivered later: `deliver.ts` holds it and flushes it when
         * the party comes back, and it re-checks liveness at that moment rather
         * than trusting this one. Refusing here would throw away the one case
         * the hold-and-flush rule exists for.
         */
        const held = match.ended !== null;

        void window.hive?.ledger
          .post({ to: party, kind: 'ask', body: command.message })
          .then((outcome) => {
            if (!outcome.ok) {
              // Verbatim, the way `send` prints a refusal: the reason names
              // what the user has to do about it.
              pushOrch(`  ${outcome.reason}`, 'red');
              return;
            }
            const handle = outcome.ref ?? outcome.id;
            pushOrch(
              held
                ? `  asked ${match.label} (${handle}) — held until it resumes`
                : `  asked ${match.label} (${handle})`,
              'dim',
            );
          });
        return;
      }

      case 'answer': {
        if (!isDesktop()) {
          pushOrch(`  ${LEDGER_REQUIRES_DESKTOP}`, 'red');
          return;
        }
        /*
          The thread argument is passed through untouched. `ledger.answer` in
          main accepts a short ref or a canonical id and resolves it there, so
          the console does not need a second copy of that rule — and could not
          have one, since a ref only resolves against the whole log.
        */
        void window.hive?.ledger
          .answer({ thread: command.thread, body: command.message })
          .then((outcome) => {
            if (!outcome.ok) {
              pushOrch(`  ${outcome.reason}`, 'red');
              return;
            }
            pushOrch(`  answered ${command.thread}`, 'dim');
          });
        return;
      }

      case 'spawn': {
        /**
         * The config decides what exists, exactly as the rail and picker do.
         *
         * This read `state.projects` — the store's own slice — which worked
         * only because that slice was seeded with five demo projects at boot.
         * Emptying the seed left it always empty, so every `spawn` answered
         * "unknown project" for projects sitting right there in the Projects
         * panel. One source for "which projects exist", and it is the config.
         *
         * **On desktop, no snapshot means permissive, not empty.** `main.tsx`
         * fires `loadProjectConfig()` without awaiting, and `project-config.ts`
         * leaves the snapshot `null` when that read throws — deliberately, so a
         * broken IPC hop degrades rather than locks the app. Treating `null` as
         * "no projects" would make this verb refuse every project during the first
         * frames of launch, and refuse them *permanently* after a failed read.
         * `can.spawnSessionIn` already answers `true` with no snapshot; this
         * agrees with it, and lets main — which has the file in front of it —
         * give the refusal if there is one.
         *
         * **In a browser it means empty, and the distinction is load-bearing.**
         * There is no bridge, so the snapshot is `null` *forever* rather than
         * briefly, and nothing downstream can ever refuse: `spawnSession` skips
         * `requestSpawn` off-desktop, so no main-side refusal arrives and the
         * row stays. Being permissive there would let `spawn anything` mint a
         * session with a fabricated transcript that the header counts and the
         * rails list — a phantom fleet, which is the exact lie this branch
         * exists to delete.
         */
        const snapshot = projectConfigSnapshot();
        /**
         * A key, an id or a name — resolved once, in `lib/` (HIVE-94).
         *
         * The store used to compare `project.id === command.repo` inline, which
         * made the console the only surface with an opinion about what names a
         * project. The picker now shares this resolver, so a project reachable
         * from one is reachable from the other by exactly the same spellings.
         */
        const resolved =
          snapshot === null
            ? ({ kind: 'none' } as const)
            : resolveProjectRef(command.project, snapshot.projects);

        /*
          Ambiguity is its own answer, not a miss (HIVE-94). Display names are
          never uniqueness-checked — two folders both called `api` is ordinary —
          and picking whichever sat first in the file would start an agent in the
          wrong repository, which is the exact failure the exactness rule exists
          to prevent. Naming the ids is what makes the advice actionable: the key
          is the way to say which one.
        */
        if (resolved.kind === 'ambiguous') {
          const ids = resolved.projects.map((project) => project.id).join(', ');
          pushOrch(
            `  ${command.project} names ${resolved.projects.length} projects (${ids}) — use a key`,
            'red',
          );
          return;
        }

        if (resolved.kind === 'none' && !(snapshot === null && isDesktop())) {
          /*
            The keys, in config order, because they are the shortest thing that
            works and the row in Settings shows them. Listing ids instead would
            answer "what could I have typed?" with the very strings this story
            exists to stop people typing.
          */
          const keys = snapshot?.projects.map((project) => project.key) ?? [];
          const suffix =
            keys.length === 0
              ? ' — add one in Settings › Projects'
              : ` — try a key from Settings › Projects (${keys.join(', ')})`;
          pushOrch(`  unknown project: ${command.project}${suffix}`, 'red');
          return;
        }

        /*
          The **resolved id**, never what was typed. `spawnSession` stores it on
          the entity as `entity.project`, and a session recorded under a key or
          a display name would be a session pointing at nothing the moment that
          alias was edited. With no snapshot there is nothing to resolve
          against, so the input is passed through and main — which has the file
          — gives the refusal if there is one.
        */
        const target =
          resolved.kind === 'match' ? resolved.project.id : command.project;
        // No confirmation line here: `spawnSession` writes it, so both this
        // command and the picker log exactly once.
        get().spawnSession(target, command.task);
        return;
      }

      case 'usage': {
        pushOrch(`  ${USAGE[command.command]}`, 'red');
        return;
      }

      case 'unknown': {
        pushOrch(
          `  command not found: ${command.command} — try \`help\``,
          'red',
        );
      }
    }
  },

  markAllRead: () => {
    set((state) => ({
      notifs: state.notifs.map((notif) => ({ ...notif, unread: false })),
    }));
    void window.hive?.notifications.markRead(null);
  },

  /**
   * By id, not by index (HIVE-75).
   *
   * The index version was correct only while nothing prepended between render
   * and click — true of a fixture, false the moment a producer exists. A
   * session finishing at the wrong instant used to shift every row down one and
   * turn the user's click into a dismissal of the row above their target.
   */
  markRead: (id) => {
    set((state) => ({
      notifs: state.notifs.map((notif) =>
        notif.id === id ? { ...notif, unread: false } : notif,
      ),
    }));
    // Through to the hub, which owns read-state. Fire-and-forget: the local
    // update has already happened, and a failed write costs a badge that is
    // right until the next hydration rather than a click that did nothing.
    void window.hive?.notifications.markRead(id);
  },

  /**
   * Dropped locally *and* in the hub (HIVE-93).
   *
   * Local first so the list reflows immediately — the card has already played
   * its exit animation by the time this runs, and waiting on IPC would leave a
   * gap where the row used to be. The hub call is fire-and-forget for the same
   * reason `markRead`'s is: the visible state is already correct, and the cost of
   * a failed write is one row that returns on the next reload rather than a
   * wedged UI.
   */
  dismissNotif: (id) => {
    set((state) => ({
      notifs: state.notifs.filter((notif) => notif.id !== id),
    }));
    void window.hive?.notifications.dismiss(id);
  },

  /**
   * Local first, then the hub — the same order and the same fire-and-forget as
   * {@link HiveState.dismissNotif}, one scale up.
   *
   * `notifications.clear()` rather than a loop of `dismiss(id)`: N invokes for
   * one gesture, each of which broadcasts its own event to every window, and a
   * buffer trimmed by the cap between render and click would leave the loop
   * dismissing ids the hub no longer holds.
   */
  clearNotifs: () => {
    set({ notifs: [] });
    void window.hive?.notifications.clear();
  },

  /**
   * Dedups by id, because the stream subscribes before it hydrates.
   *
   * That order is deliberate — see `use-notification-stream.ts` — and it can
   * only ever produce a duplicate, never a gap. Absorbing it here is what makes
   * the trade free.
   */
  pushNotif: (notif) =>
    set((state) =>
      state.notifs.some((existing) => existing.id === notif.id)
        ? state
        : { notifs: [notif, ...state.notifs].slice(0, NOTIF_CAP) },
    ),

  applyRead: (id, unread) =>
    set((state) => ({
      notifs:
        id === null
          ? state.notifs.map((notif) => ({ ...notif, unread }))
          : state.notifs.map((notif) =>
              notif.id === id ? { ...notif, unread } : notif,
            ),
    })),

  applyDismiss: (id) =>
    set((state) => ({
      notifs:
        id === null
          ? []
          : state.notifs.filter((notif) => notif.id !== id),
    })),

  hydrateNotifs: (notifs) =>
    set((state) => {
      /**
       * Union, not replacement, and newest first.
       *
       * Anything that arrived on the subscription while `list()` was in flight
       * is already here and is *newer* than what main answered with. Replacing
       * would drop it.
       */
      const seen = new Set(state.notifs.map((notif) => notif.id));
      const merged = [
        ...state.notifs,
        ...notifs.filter((notif) => !seen.has(notif.id)),
      ].sort((a, b) => b.createdAt - a.createdAt);

      return { notifs: merged.slice(0, NOTIF_CAP) };
    }),

  hydrateAgents: (summaries) =>
    set((state) => {
      const entities = { ...state.entities };

      // Clear the previous set first: this is a replacement, and an agent
      // whose folder is gone has to go with it. Only ids this store already
      // believes are agents are dropped, so a session can never be caught by
      // a name collision.
      for (const id of state.agentOrder) {
        const previous = entities[id];

        if (previous !== undefined && isAgent(previous)) delete entities[id];
      }

      for (const summary of summaries) {
        const previous = state.entities[summary.name];

        /*
          Never write over a session.

          `entities` is one map for both kinds, and an agent name is a legal
          session id — so a definition called `sess-01` used to replace a live
          session's entity and orphan it from `order`. The clear loop above
          already guarded this; the write did not.
        */
        if (previous !== undefined && !isAgent(previous)) continue;

        const kept = previous === undefined ? [] : previous.lines;

        entities[summary.name] = {
          kind: 'agent',
          id: summary.name,
          icon: summary.icon,
          sub: summary.description,
          status: summary.status,
          wake: summary.wake,
          ...(summary.lastRunAt === undefined
            ? {}
            : { lastRunAt: summary.lastRunAt }),
          ...(summary.nextRunAt === undefined
            ? {}
            : { nextRunAt: summary.nextRunAt }),
          ...(summary.invalid === undefined ? {} : { invalid: summary.invalid }),
          // Run state, not definition, and carried for the same reason
          // `lastRunAt` is: `agents:list` reads it back out of `agents.json`,
          // so a folder change must not blank the cost the live push put in
          // this row until whenever the agent happens to run again.
          ...(summary.cost === undefined ? {} : { cost: summary.cost }),
          /*
            Run state, like `cost` above (HIVE-116). `runsSinceRotate` is
            optional on the wire — a summary the registry built for an agent
            with no entry in `agents.json` omits it — and zero is the honest
            reading of "nothing has run yet".
          */
          runsSinceRotate: summary.runsSinceRotate ?? 0,
          rotateAfter: summary.rotateAfter,
          runs: summary.runs,
          ...(summary.sessionUuid === undefined
            ? {}
            : { sessionUuid: summary.sessionUuid }),
          task: summary.description,
          // Run output, not definition — re-reading the file is no reason to
          // forget what the agent said.
          lines: kept,
        };
      }

      return {
        entities,
        agentOrder: summaries
          .map((summary) => summary.name)
          .sort((a, b) => a.localeCompare(b)),
      };
    }),

  setAgentStatus: (push) =>
    set((state) => {
      const previous = state.entities[push.name];

      // Never write over a session — see the guard in `hydrateAgents`: an
      // agent name is a legal session id, and this map holds both kinds.
      if (previous === undefined || !isAgent(previous)) return state;

      return {
        entities: {
          ...state.entities,
          [push.name]: {
            ...previous,
            status: push.status,
            ...(push.lastRunAt === undefined ? {} : { lastRunAt: push.lastRunAt }),
            ...(push.nextRunAt === undefined ? {} : { nextRunAt: push.nextRunAt }),
            ...(push.cost === undefined ? {} : { cost: push.cost }),
            /*
              Assigned, not spread-guarded: both are required on the push, and
              a run that closes with an empty history is a real state the tile
              must show as `0 runs` rather than as last render's number.
            */
            runs: push.runs,
            runsSinceRotate: push.runsSinceRotate,
          },
        },
      };
    }),

  appendAgentLines: (push) =>
    set((state) => {
      const previous = state.entities[push.name];

      // Same guard as `setAgentStatus` and `hydrateAgents`.
      if (previous === undefined || !isAgent(previous)) return state;

      return {
        entities: {
          ...state.entities,
          [push.name]: {
            ...previous,
            lines: capAgentLines([...previous.lines, ...push.lines]),
          },
        },
      };
    }),

  hydrateLedger: (entries) =>
    set((state) => {
      /**
       * Union, not replacement — `hydrateNotifs`' reason, with one difference
       * that makes it sharper.
       *
       * `useLedgerSync` arms the push channel while `list()` is still in
       * flight, so an entry appended after main took its snapshot lands here
       * first and is absent from the snapshot that follows. A replace would
       * discard it *permanently*: that hook mounts once at the composition
       * root and never remounts, so there is no second hydrate to recover it.
       *
       * Ordered by `id` rather than by `ts`, because ids are fixed-width and
       * sort as strings in write order — which is the same comparison
       * `since` and the store's own load-time sort already rely on.
       */
      const seen = new Set(state.ledger.map((entry) => entry.id));
      const merged = [
        ...state.ledger,
        ...entries.filter((entry) => !seen.has(entry.id)),
      ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      return { ledger: merged.slice(-LEDGER_MEMORY_CAP) };
    }),

  ledgerAppend: (entry) =>
    set((state) => ({ ledger: [...state.ledger, entry].slice(-LEDGER_MEMORY_CAP) })),

  hydrateSessions: (records) =>
    set((state) => {
      const entities = { ...state.entities };
      const order = [...state.order];
      let restored = 0;

      for (const item of records) {
        /**
         * Seeded **before** the collision check, not after it.
         *
         * The counter has to learn about an id whether or not the row is kept.
         * A spawn that lands in the window between boot and this unawaited
         * hydrate takes `sess-01`; the session history's own `sess-01` is then skipped
         * below as a collision, and if the counter never heard of it the next
         * spawn is handed `sess-02` — the id of another record still waiting to
         * be restored, which then vanishes the same way. Once past the skip,
         * this ran only for rows that survived it.
         */
        rememberSpawnId(item.id);

        /*
          A live row always wins. Not a conflict to resolve so much as the
          ordinary case: entity ids are reused across a restart, so the
          session history's `sess-01` and this run's `sess-01` are different
          sessions wearing the same name, and only one of them has a process
          behind it.

          This is also the whole of restore's deduplication (HIVE-88), and the
          id is the right key for it. It is the one identity that survives a
          restart: a restored row reopened spawns under its own id, the
          session history is keyed by it, and `rememberSpawnId` above keeps
          this run's counter from minting it a second time. Claude's own `sessionUuid`
          never reaches the renderer, and `cwd` or `ticket` would collapse two
          genuinely different sessions on one issue into one row.
        */
        if (item.id in entities) continue;

        /*
          `live` is main saying a pty is running under this id right now
          (HIVE-88). Such a row is this run's fleet, whatever the file says
          about when it started: it keeps the status it was last seen in
          rather than being written down to an ending, and it is not `restored`
          — that flag is for rows the app outlived, and this one it did not.
          Only a record in a live status is promoted: main never writes an
          ended status for a pty it still holds, so a live record claiming
          one is a file this build did not write, and the status it claims
          wins over the mark.

          Keyed on `endedBy === 'app-closed'` rather than on the status, because
          the status can no longer tell the two apart (HIVE-93): an inferred
          ending and a recorded `/clear` are both `done`, and promoting the
          latter would resurrect a retired row as live.
        */
        const stored = restoredStatus(item.status, item.endedBy);
        /*
          A status this build does not know is a record written by one that did.
          Dropped rather than guessed at — an unrenderable row in the fleet
          table is worse than a row missing from it, and the session history is
          a convenience, not a source of truth about anything.
        */
        if (stored === undefined) continue;

        const live = item.live === true && stored.endedBy === 'app-closed';
        const status = live ? (item.status as SessionStatus) : stored.status;

        entities[item.id] = stampLifecycle({
          kind: 'session',
          id: item.id,
          project: item.project,
          status,
          task: item.task,
          /*
            How it ended, and whether it can come back (HIVE-93). A live row is
            not ended at all, so it carries neither — and `resumable` is main's
            answer rather than an inference from the record: it holds the uuid
            and knows whether this run already opened that conversation.
          */
          ...(live || stored.endedBy === undefined
            ? {}
            : { endedBy: stored.endedBy }),
          ...(!live && item.resumable === true ? { resumable: true } : {}),
          /*
            The three required fields the record deliberately does not carry.
            `lines: []` is the honest one: a restored row has no transcript
            here — Claude Code owns it — and inventing a line or two of
            plausible scrollback would be a fiction the user cannot tell from a
            recording.
          */
          lines: [],
              cost: '$0.00',
          /*
            Where this row came from — provenance, which `endedReason` needs and
            which nothing else can supply. It cannot be derived from the status:
            a session that quit normally last run is restored as `terminated`,
            which is indistinguishable from one that quit ten seconds ago in
            this one.

            Cleared again by `reviveIfLive` the moment the row is reopened and
            its new process reports a live status (HIVE-88) — and never set on
            a row main still runs, which was never a previous run at all.
          */
          ...(live ? {} : { restored: true }),
          ...(item.name === undefined ? {} : { name: item.name }),
          /*
            And whether that name is the app's own (HIVE-107). Restored because
            a restored row can be *reopened*: resume starts a real `claude`,
            which repaints the only name it knows — the id — several times a
            second, so an unpinned row loses the mid-session `HIVE-104` it was
            carrying. `renameSession` reads this flag; without it the pin
            survived the quit and was lost to the recovery.
          */
          ...(item.namePinned === true ? { namePinned: true } : {}),
          ...(item.ticket === undefined ? {} : { ticket: item.ticket }),
          ...(item.branch === undefined ? {} : { branch: item.branch }),
          ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
          /*
            The times the row really had, not the moment it was restored.
            `createdAt` is required on a record so it always lands; `endedAt` is
            not, and a record without one has already been stamped at load by
            `history.ts` — a row that claims to be live in a file main is reading
            back plainly is not. A live row promoted below keeps `createdAt` and
            has its `endedAt` removed by `stampLifecycle`, so a session the app
            outlived and then found still running does not sort as though it had
            finished.
          */
          createdAt: item.createdAt,
          ...(item.endedAt === undefined ? {} : { endedAt: item.endedAt }),
          /*
            The pull request this session was last seen to own. Written down by
            a sweep in some previous run — the live list cannot answer for it any
            more, which is the entire reason it is on the record.
          */
          ...(item.pr === undefined ? {} : { lastPr: item.pr }),
          /*
            Checked against the closed lists rather than trusted (HIVE-87).
            `history.ts` casts these on the way in and says the store validates
            them — which was not true until now, so a hand-edited file or one
            from an older build could put an arbitrary string into a field typed
            as a union. An unknown value drops the field and keeps the row: the
            model a finished session ran under is a nice-to-have, and losing the
            row over it would not be.
          */
          ...(isKnownModel(item.model) ? { model: item.model } : {}),
          ...(isKnownEffort(item.effort) ? { effort: item.effort } : {}),
        });
        order.push(item.id);
        restored += 1;
      }

      return restored === 0 ? {} : { entities, order };
    }),

  appendEntityLines: (id, lines, status) =>
    set((state) => {
      const entity = state.entities[id];
      if (!entity) return state;

      const updated: Entity = isSession(entity)
        ? {
            ...entity,
            lines: [...entity.lines, ...lines],
            status: status ?? entity.status,
          }
        : { ...entity, lines: [...entity.lines, ...lines] };

      /**
       * This function has no `idleDetail` parameter, so an explicit status
       * change through here can never legitimately carry one forward —
       * `idleDetail` is only ever set alongside `idle` by `setSessionStatus`.
       * Without this, a session on `idle (script)` demo-acked to `working`
       * would keep the stale detail and draw a hollow ring on a status that
       * must only ever be solid (HIVE-83).
       */
      if (status !== undefined && isSession(updated) && 'idleDetail' in updated) {
        delete updated.idleDetail;
      }
      if (status !== undefined && isSession(updated)) reviveIfLive(updated);

      return { entities: { ...state.entities, [id]: updated } };
    }),

  /**
   * A real session's status, derived from its pty in the main process
   * (story 096).
   *
   * Separate from `appendEntityLines` because it carries no transcript: with a
   * real PTY the transcript goes straight to xterm through the transport and
   * never touches this store. Only the *status* comes back, which is what the
   * rails and the inbox render.
   *
   * Agents are ignored rather than rejected. They have no `status` field of this
   * shape and no pty this epic, and a status event for one means main and the
   * fixture set disagree — worth not crashing over, not worth acting on.
   *
   * `idleDetail` rides along (HIVE-83) and is compared too, not just `status`:
   * `idle` with nothing running and `idle (agents)` are the same `status` and a
   * different dot.
   */
  setSessionStatus: (id, status, idleDetail) =>
    set((state) => {
      /**
       * Main names the *terminal*; this is the row that owns it now.
       *
       * A cleared session must not be un-retired by the `SessionStart` its own
       * `/clear` produces, and the successor must receive the statuses that
       * follow. See {@link currentSessionIn}.
       */
      const target = currentSessionIn(state, id);
      const entity = state.entities[target];
      if (!entity || !isSession(entity)) return state;

      /**
       * **`working` is the only status worth covering** (HIVE-103).
       *
       * The boot cover hides output in flight. Any other status says there is
       * no more output coming — or that something is being asked — and both are
       * things the user must be allowed to see.
       *
       * This is the escape that was missing. A session opened in a folder
       * Claude Code has not been trusted with never starts: it draws a trust
       * prompt on the shell's own screen and waits. No `SessionStart` fires,
       * because Claude never gets that far, so the only way out was the
       * sixty-second timeout or a keystroke — and the user's first symptom was
       * a hydralisk that would not go away, with the question hidden behind it.
       *
       * Nothing new observes this. Main's activity tracker already derives
       * `idle` from two seconds of pty silence, and a boot that has stopped
       * producing output is exactly what that means. Measured against a real
       * `claude`, the gap between the two readings is wide: a normal boot's
       * quiet gaps before Claude paints are all under 0.6s, while a trust
       * prompt goes silent at ~2.5s and stays silent indefinitely.
       *
       * The trust prompt itself is deliberately **not** pattern-matched. Its
       * text does not exist in the byte stream — the TUI positions each word
       * with cursor moves, so `Is this a project you created…` is never
       * contiguous — and matching it would need a screen emulator and would
       * break on the next release's wording. Silence is the observable.
       */
      const uncover = entity.booting === true && status !== 'working';

      /*
        Checked *after* `uncover`, not before. An unchanged status is normally a
        write to drop — Claude repaints continuously — but a repeat that also
        has to lift a cover is not a no-op, and returning early on it would be a
        cover that never lifts, which is the whole class of bug above.
      */
      if (
        entity.status === status &&
        entity.idleDetail === idleDetail &&
        !uncover
      ) {
        return state;
      }

      /**
       * Spread-to-absent, then an explicit delete: the two are not the same
       * guard. The spread alone stops a missing `idleDetail` from *overwriting*
       * a value with `undefined`, but `entity`'s own key is still on the object
       * afterwards — an `idle (agents) → working` transition would spread over
       * it and keep the stale detail, because the snapshot compares keys, not
       * values, and an explicit `undefined` is not the same as absent.
       */
      const updated: Session = {
        ...entity,
        status,
        ...(idleDetail === undefined ? {} : { idleDetail }),
      };
      if (idleDetail === undefined) delete updated.idleDetail;
      // Absent, not `false` — `markSessionReady` deletes the key for the same
      // reason, and the two must leave a session in the same shape.
      if (uncover) delete updated.booting;
      reviveIfLive(updated);

      return {
        entities: { ...state.entities, [target]: updated },
      };
    }),

  /**
   * The agent reported a new display name (HIVE-61, reshaped by HIVE-108).
   *
   * The same shape and the same guards as `setSessionStatus`, and for the same
   * reasons: agents are ignored rather than rejected, and an unchanged value is
   * dropped so a session repeating its title — which Claude does on every
   * repaint — cannot produce a store write, and a re-render, per repaint.
   *
   * The title is no longer taken verbatim. It is rewritten by
   * {@link hiveNameFromTitle} into the register the rail spells names in, which
   * is what makes `Mutex explanation` land as `mutex-explanation` and `back key
   * interception hive-53` as `HIVE-53-back-key-interception`. That function is a
   * fixed point on its own output, which is the property this action depends on
   * most: Claude repaints several times a second, and a normaliser that grew its
   * input would rename the session on every frame.
   */
  renameSession: (id, name) =>
    set((state) => {
      // The terminal's current row, for the reason `setSessionStatus` gives:
      // a rename after a `/clear` describes the new conversation, not the
      // finished one whose name is now history.
      const target = currentSessionIn(state, id);
      const entity = state.entities[target];
      if (!entity || !isSession(entity)) return state;

      /**
       * A pinned session keeps its key in front, rather than refusing the title
       * outright (HIVE-78, relaxed by HIVE-108).
       *
       * The pin says the user told the app which issue this session is for, and
       * that outranks anything Claude infers. It used to be enforced by refusing
       * *every* title, which was correct while the alternative was `sess-03` —
       * but the alternative is now a description of the work, and `HIVE-73` plus
       * that description beats either alone.
       *
       * **The prefix is `ticket`, never `name`.** Passing the current name would
       * compound: `HIVE-73-back-key-interception` would become the prefix of the
       * next frame's name, and the row would grow a word a second. The ticket key
       * is the one part of the name that is fixed.
       *
       * That spends `ticketSessionName`'s `-2`, and deliberately. A second
       * session on one ticket opens as `HIVE-73-2`, and once each has a topic
       * they are `HIVE-73-<their own topics>` — already distinct, and more
       * legible than a counter. The `taken` check below is the backstop for the
       * case where they are not.
       *
       * A pin with no ticket behind it cannot name a prefix, so it keeps the
       * pre-HIVE-108 behaviour and refuses. Nothing produces that state today —
       * `setSessionTicket` writes both fields together — and a restored record
       * that somehow carries one without the other is better left alone than
       * renamed on a guess.
       */
      if (entity.namePinned === true && entity.ticket === undefined) return state;
      const next = hiveNameFromTitle(
        name,
        entity.namePinned === true ? entity.ticket : undefined,
      );
      // A title with nothing nameable in it is not a rename, the same way an
      // empty title never was.
      if (next === undefined) return state;

      /**
       * Refuse the title the finished conversation left in the terminal.
       *
       * Suppressed until a *different* name arrives, not merely once: Claude
       * repaints the title continuously, so the stale value comes back many
       * times a second and a one-shot guard would let the second one through.
       * Anything else means the agent has genuinely renamed itself, and the
       * terminal stops being suspect from then on.
       *
       * Compared **after** normalising, because that is the space `staleTitles`
       * records in — it stores the retired row's `name`, which is already a
       * normalised value. Comparing the raw title against it would never match,
       * and the successor would inherit the name this guard exists to withhold.
       */
      const terminal = terminalOf(entity);
      const stale = staleTitles.get(terminal);
      if (stale === next) return state;
      if (stale !== undefined) staleTitles.delete(terminal);

      if (entity.name === next) return state;

      /**
       * One name, one session — **numbered, not refused** (HIVE-109).
       *
       * Inferred names collide in a way ids never did: two sessions on one
       * ticket can reach the same title, and so can two unrelated sessions asked
       * the same kind of question. Asking two sessions "whats the time now"
       * produced `Current time` in both transcripts, measured.
       *
       * HIVE-108 refused the loser, on the stated grounds that a `-2` "would not
       * survive the next repaint … a write per frame, forever". **That trace was
       * wrong**, and the cost of believing it was a row that sat on `sess-0n`
       * for the rest of its life while its own transcript held a perfectly good
       * title. Suffixing is stable, for two independent reasons:
       *
       * - the comparison below happens *after* disambiguation, so a row already
       *   called `current-time-2` compares equal to its own recomputed name and
       *   no write occurs; and
       * - a name that is already this candidate plus a number is kept as-is, so
       *   the number does not move when the row that took the bare name ends.
       *
       * `ticketSessionName` has spelled a second session on one ticket `-2`
       * since HIVE-78. This is the same rule for inferred names, and it resolves
       * the same way: first to arrive keeps the bare name.
       *
       * **Only live rows hold a name.** An ended one is a record of work that
       * finished, and it keeps its name for the ENDED list rather than to reserve
       * it — most sharply after a `/clear`, where the retired row and its
       * successor share a terminal and the successor is *expected* to arrive at
       * the same name once the agent repaints it. Counting the dead here left
       * that successor unnamed for the life of the app.
       */
      const heldByAnother = (candidate: string): boolean =>
        Object.values(state.entities).some(
          (other) =>
            isSession(other) &&
            other.id !== target &&
            !isEnded(other.status) &&
            other.name === candidate,
        );

      /*
        Already wearing a number for this very name: keep it. Without this the
        row would drop back to the bare name the moment the session holding it
        ended — a rename the user did nothing to cause, on a row they are
        watching.
      */
      const numberedVariant =
        entity.name !== undefined &&
        entity.name.startsWith(`${next}-`) &&
        /^\d+$/.test(entity.name.slice(next.length + 1));
      if (numberedVariant) return state;

      let unique = next;
      // Starts at 2, so the second session to reach a name is `-2`, exactly as
      // `ticketSessionName` numbers a second session on one ticket.
      for (let suffix = 2; heldByAnother(unique); suffix += 1) {
        unique = `${next}-${suffix}`;
      }
      if (entity.name === unique) return state;

      return {
        entities: { ...state.entities, [target]: { ...entity, name: unique } },
      };
    }),

  /**
   * Record what a session says about its own context and rate limits (HIVE-79).
   *
   * Resolved through {@link currentSessionIn} like every other session write, so
   * a report that arrives just after `/clear` lands on the successor rather than
   * on the row the store has already retired.
   *
   * **Merged, not replaced.** Each status line payload is a complete
   * observation, but its fields drop in and out independently — `rate_limits` is
   * absent until a session's first API response and for the whole life of an
   * API-key session. Overwriting wholesale would drop the limits on every tick
   * that happened not to carry them, having already known the answer. Undefined
   * fields are dropped from the patch so absence never overwrites knowledge; the
   * receiver omits a field it did not read rather than sending `undefined`.
   *
   * **`null` is not absence, and it does overwrite.** `contextPct` arrives as an
   * explicit `null` when the session reported a context window it could not put
   * a percentage on — before the first assistant turn, and again after
   * `/compact`. Merging that away would leave the pre-compact reading on screen,
   * confidently, as the one number the user just changed. So the patch filter
   * drops `undefined` only, and a `null` writes through to clear it. See
   * `metrics-contract.ts`, which is where the distinction is defined.
   */
  setSessionMetrics: (id, metrics) =>
    set((state) => {
      const target = currentSessionIn(state, id);
      const entity = state.entities[target];
      if (!entity || !isSession(entity)) return state;

      const patch = Object.fromEntries(
        Object.entries(metrics).filter(([, value]) => value !== undefined),
      ) as SessionMetrics;
      if (Object.keys(patch).length === 0) return state;

      const previous = state.metrics[target];
      const next = { ...previous, ...patch };

      /*
        Dropped when nothing moved. The 30-second refresh re-reports identical
        numbers for a session nobody is typing into, and a new object identity
        each time would re-render the chip on a timer for no reason.
      */
      if (
        previous !== undefined &&
        (Object.keys(next) as (keyof SessionMetrics)[]).every(
          (key) => previous[key] === next[key],
        ) &&
        Object.keys(previous).length === Object.keys(next).length
      ) {
        return state;
      }

      return { ...state, metrics: { ...state.metrics, [target]: next } };
    }),

  /**
   * Main observed where this session is working and what is checked out there
   * (HIVE-78).
   *
   * The replacement for the `feat/<id>` fiction. Same shape and same guards as
   * `setSessionStatus` — the terminal's *current* row, agents ignored, an
   * unchanged value dropped — and the last of those matters more here than
   * anywhere else: main already suppresses unchanged branches, so a write
   * reaching this action twice means two observations genuinely differed, and
   * dropping the no-op keeps a rail of thirteen rows from re-rendering when a
   * fourteenth session's `git` call comes back with the same answer.
   */
  setSessionBranch: (id, branch, cwd) =>
    set((state) => {
      const target = currentSessionIn(state, id);
      const entity = state.entities[target];
      if (!entity || !isSession(entity)) return state;
      if (entity.branch === (branch ?? undefined) && entity.cwd === cwd) {
        return state;
      }

      /**
       * `null` from the wire becomes a **genuinely absent key** on the entity.
       *
       * Two spellings of "there is no branch" would mean every surface handled
       * both, and one of them would eventually render the string `null`. The
       * wire needs `null` because a typed event cannot omit a field
       * conditionally; the store does not.
       *
       * Destructured away rather than spread as `{ branch: undefined }`, which
       * is what this first shipped as and is not the same thing: an own
       * property whose value is `undefined` is still a key. A session observed
       * on a branch and then moved to a detached HEAD would have kept
       * `'branch' in entity === true` and diverged under `toStrictEqual` from a
       * session nobody had ever looked at — the same key-for-key comparison
       * `spawnSession` and `clearSession` already spread-to-absent for.
       */
      const { branch: _dropped, ...withoutBranch } = entity;
      const next =
        branch === null
          ? { ...withoutBranch, cwd }
          : { ...entity, branch, cwd };

      return {
        entities: {
          ...state.entities,
          [target]: next,
        },
      };
    }),

  /**
   * The user said, in their own words, which ticket this session is for
   * (HIVE-78).
   *
   * Called from `use-session-status.ts` **after** the key has been confirmed
   * against Jira — this action does no validation of its own, because the check
   * that matters is a network call and a store must stay synchronous.
   *
   * ## Why it pins the name — when the user spoke it
   *
   * Associating without renaming would leave a row called `sess-03` sitting on
   * the `ABC-123` card, which is the association the user asked for and none of
   * the recognition. Pinning is what makes the new name survive Claude's next
   * title repaint — see {@link Session.namePinned}.
   *
   * That reasoning is about a user who *said* the key, and it does not carry to
   * a key merely read off a branch. `{ rename: false }` is the caller saying so
   * — see {@link SetSessionTicketOptions}.
   *
   * ## Why it refuses a session that already has a ticket
   *
   * A session moved between tickets mid-conversation is a claim about work that
   * has already happened in it, and the row would carry a name that does not
   * describe most of its own transcript. A user who genuinely wants that has a
   * better tool: `/clear`, which retires the row and opens a fresh one.
   */
  setSessionTicket: (id, ticket, { source = 'prompt' } = {}) => {
    /**
     * Read, decide, write, *then* tell main (HIVE-107) — rather than the bare
     * `set(updater)` this was, with the note made separately by its caller.
     *
     * Two things follow from the note being made here, and both were bugs
     * while it was made there:
     *
     * - **It carries the name.** The name is settled in this function and
     *   nowhere else — `ticketSessionName` de-duplicates against the whole
     *   fleet — so a caller can only send the key, and main had no other way
     *   to learn what the row is now called: this rename never reaches Claude,
     *   so it never comes back on the title stream. The session history kept
     *   the id, and the next launch restored it over a name the user had been
     *   reading all afternoon.
     * - **It only speaks when it acted.** The three refusals below are silent
     *   from outside, so an unconditional note beside the call wrote a ticket
     *   into the session history that the store had just declined — and keyed
     *   it on the raw id rather than `currentSessionIn`, which after a
     *   `/clear` is a different row.
     *
     * `get()` before `set()` is the shape `resumeSession` uses a few actions
     * down, and for the same reason: the decision needs the state, and the
     * effect must not run inside an updater.
     */
    const state = get();
    const target = currentSessionIn(state, id);
    const entity = state.entities[target];
    if (!entity || !isSession(entity)) return;
    /**
     * An existing ticket refuses a second one — **unless** the first was only
     * inferred and the second was spoken.
     *
     * The plain "already has a ticket" refusal was right while the prompt was
     * the only signal, and became a bug the moment a branch could associate:
     * main reads the branch at spawn, so the inference reliably arrives *first*
     * and the refusal handed every contest to the weaker evidence. See
     * {@link Session.ticketInferred}.
     *
     * Two spoken keys still refuse the second. That is a user changing their
     * mind mid-conversation, and the row would end up carrying a name that
     * describes almost none of its own transcript — `/clear` is the honest tool
     * for it, and it already retires the row and opens a successor.
     */
    if (entity.ticket !== undefined) {
      const displaces = source === 'prompt' && entity.ticketInferred === true;
      if (!displaces) return;
    }
    // An ended row is history; naming it now would rewrite the record.
    if (isEnded(entity.status)) return;

    /**
     * A branch-inferred link **associates without renaming**.
     *
     * The two callers are not equally sure of themselves, and the name is where
     * that difference has to show. A prompt is the user saying it: they typed
     * "work on ABC-123", so answering with a row called `ABC-123` is the
     * recognition they asked for. A branch is an inference *about* them — often
     * about a checkout they made days ago — and it is strong enough to file the
     * session on the right card, which is a correction, but not strong enough
     * to overwrite the name they have been reading all afternoon, which would
     * be a surprise with no cause on screen.
     *
     * It costs the card nothing: `facetsForTicket` matches on `ticket`, never
     * on the name, so the row appears either way. The only difference is what
     * it is called when it gets there.
     */
    const name =
      source === 'prompt' ? ticketSessionName(ticket, state.entities) : undefined;

    /**
     * `ticketInferred` is set by the branch path and *removed* by the prompt
     * one.
     *
     * A promoted row must stop being displaceable: leaving the flag on after a
     * spoken key would let the next branch-shaped guess overwrite it again, one
     * checkout later. Deleted from a fresh object rather than assigned
     * `undefined`, because this store's snapshots are compared key-for-key and
     * an explicit `undefined` is a different shape from an absent key — the
     * same rule `clearSession` follows a few actions down.
     */
    let next: Session;
    if (name === undefined) {
      next = { ...entity, ticket, ticketInferred: true };
    } else {
      next = { ...entity, ticket, name, namePinned: true };
      delete next.ticketInferred;
    }

    set((current) => ({
      entities: {
        ...current.entities,
        [target]: next,
      },
      orchLines: capLines([
        ...current.orchLines,
        /*
          The new name, never the id (HIVE-91) — and only the name: it always
          carries the ticket key (`HIVE-73`, `HIVE-73-2`), so spelling the
          ticket again would read `HIVE-73 is working HIVE-73`.

          The silent branch has no name to spell, so it says what it did instead
          — and it does still say something. An association the user did not ask
          for out loud is exactly the kind that should leave a trace they can
          find afterwards, because the card changing under them is otherwise the
          only evidence it happened.
        */
        name === undefined
          ? // Names the row, unlike the rename case: there the new name *is* the
            // key and identifies itself, whereas `linked → HIVE-111` alone
            // leaves the reader to guess which of thirteen sessions moved.
            line(`  ${entityLabel(entity)} linked → ${ticket}`, 'dim')
          : line(`  renamed → ${name}`, 'dim'),
      ]),
    }));

    // So the association *and the name it produced* survive a quit (HIVE-87,
    // HIVE-107). Fire and forget: `lib/session-history` swallows the failure.
    // A silent link sends no name because it changed none — main keeps the one
    // it already had rather than being told `undefined` and clearing it.
    noteSessionTicket({
      entityId: target,
      ticket,
      ...(name === undefined ? {} : { name }),
    });
  },

  /**
   * `/clear` — the conversation ended, the terminal did not.
   *
   * Where `terminated` comes from a pty exit that main watched, this comes from
   * a hook: `SessionEnd{reason:'clear'}`, fired on a session sitting alive at
   * its prompt. So the row becomes `done` — the work finished — and a successor
   * opens on the **same terminal**, which is the whole point. Nothing is
   * spawned; there is already a process, and it is still running.
   *
   * ## What the successor inherits, and what it does not
   *
   * `terminalId`, `project`, `branch`, `ticket`, `model` and `effort` carry
   * over: they describe the *terminal*, and a `/clear` changes none of them.
   * `task`, `name`, `pr` and `lines` do not: they described a conversation that
   * just ended, and carrying the old name forward would make the successor look
   * like a continuation of work it cannot see. Claude renames it moments later
   * anyway, through the same `renameSession` path any session uses.
   *
   * `ticket` is in the first list rather than the second, and the WORK panel is
   * why: the link is the user's answer to "which terminal is on this issue",
   * and dropping it here would make a session vanish from its ticket card at
   * the instant the user typed `/clear` — on the same terminal, still in the
   * same repository, still working the same issue.
   *
   * ## Ordering
   *
   * The successor takes the retired session's *place* in `order` rather than
   * being appended. The rails read that array positionally, and a terminal the
   * user has had open all day jumping to the bottom of the list because they
   * typed `/clear` would be a navigation surprise with no cause they can see.
   *
   * An unknown id, an agent, or a session that already ended is a no-op — a
   * hook can arrive for a row the user removed a moment earlier, and the honest
   * answer to that race is to do nothing.
   */
  resumeSession: (id) => {
    const current = get().entities[id];
    if (current === undefined || !isSession(current)) return;
    /*
      Both guards are refusals rather than no-ops with side effects: opening the
      tab anyway would put the user in front of a terminal this action has not
      arranged to exist.
    */
    if (!isEnded(current.status)) return;
    if (current.resumable !== true) return;

    set((state) => {
      /*
        Live again *before* the tab opens, and that ordering is the whole of
        this action. `center-stage.tsx` reads `isTerminated` on mount to decide
        whether to disable stdin, and `resolve-transport` reads the row to build
        the spawn — so a row still marked ended would mount a read-only surface
        over the very session it was asked to reopen.

        `idle` rather than `working`: nothing is running yet. The process reports
        its own status within a turn, and claiming activity we have not observed
        is the habit `activity.ts` exists to avoid.
      */
      const revived: Session = { ...current, status: 'idle' };
      /*
        And covered again while it starts (HIVE-101). A resume runs the very
        same login shell as a spawn — `direnv` reloads, the package manager
        reports — so the wait it hides is identical and there is no reason the
        second time through should be noisier than the first.
      */
      revived.booting = true;
      /*
        The ending is over, so the record of *how* it ended goes with it —
        otherwise `isTerminated` keeps answering yes and the surface stays
        read-only. `resumable` deliberately stays: a session resumed once can be
        finished and resumed again, and it is still what tells the transport to
        continue rather than begin.
      */
      delete revived.endedBy;
      /*
        And it is no longer a row the app merely *outlived* (HIVE-88). While the
        table drew a PREVIOUS RUN divider, leaving this set made a resumed row
        satisfy both that group and ACTIVE, so it was drawn twice sharing one
        selection index — the exact double-draw HIVE-88 fixed. The divider is
        gone and that particular symptom with it, but the flag still feeds
        `endedReason`, which would otherwise go on calling a live session
        something the app outlived. `reviveIfLive` clears it when a live status
        arrives; this is the other way in.
      */
      delete revived.restored;
      /*
        And it stopped being over, so the moment it stopped is not a fact about
        it any more (see `stampLifecycle`). Left in place, a resumed row would
        go on sorting among the ended ones by the time it used to have.

        `resumedAt` is what it sorts by instead. Clearing `endedAt` alone sent
        it back to `createdAt` — when the conversation *first* started — so a
        session resumed at 11:00 sorted below one spawned at 10:00, putting the
        row the user had just acted on furthest from the header.
      */
      revived.resumedAt = Date.now();
      stampLifecycle(revived);
      return { entities: { ...state.entities, [id]: revived } };
    });

    /**
     * **Actually start a process.** The store update above only changes how the
     * row reads; without this the surface would re-enable stdin over a pty that
     * exited and swallow every keystroke, with the Resume control now gone
     * because it is gated on the row being ended. There is no way back from
     * that state, which makes it worse than refusing outright.
     *
     * Two calls, because two different latches are in the way:
     *
     * - `reopenChannel` clears the renderer's per-entity latch. `PtyTransport`
     *   marks a channel `closed` on exit and never clears it — that is what
     *   stops a tab switch resurrecting a finished agent — and it also drops
     *   `spawnResult`, so the request below genuinely asks rather than handing
     *   back the previous answer.
     * - `requestSpawn` is the spawn path rather than `pty.restart`, and the
     *   distinction is load-bearing: `ptyRestart` deliberately does not forward
     *   `resume` ("a restart is never a resume"), so restarting here would start
     *   a **new** conversation under the promise of continuing the old one.
     *
     * Keyed on the *terminal*, like every other spawn: a successor minted by
     * `/clear` inherits its predecessor's pty, and the channel is keyed the same
     * way.
     */
    const terminalId = terminalOf(current);
    reopenChannel(terminalId);
    void requestSpawn(terminalId, current.project, {
      ...(current.model === undefined ? {} : { model: current.model }),
      ...(current.effort === undefined ? {} : { effort: current.effort }),
      resume: true,
    });

    useUiStore.getState().openTab(id);
  },

  /**
   * Claude is up — uncover the terminal (HIVE-101).
   *
   * Deliberately tolerant, because every one of these is a real path:
   *
   * - **called twice** — `/clear` starts a second Claude session in the same
   *   pty and produces a second `SessionStart`;
   * - **called for a row that is already uncovered** — the timeout or a
   *   keystroke got there first;
   * - **called for an id that has ended or gone** — the report raced a `/done`.
   *
   * All three are no-ops rather than errors. Deleting an absent key is free, so
   * the only thing worth guarding is writing a new object when nothing changed:
   * `entities` is compared by identity all over this file, and a fresh map on
   * every duplicate report would re-render the fleet for nothing.
   */
  markSessionReady: (id) => {
    const current = get().entities[id];
    if (!current || !isSession(current) || current.booting !== true) return;

    set((state) => {
      const uncovered: Session = { ...current };
      delete uncovered.booting;
      return { entities: { ...state.entities, [id]: uncovered } };
    });
  },

  finishSession: (id, resumable) => {
    /**
     * Resolved to the terminal's **current** row, like every other session
     * write in this file — see {@link currentSessionIn}.
     *
     * Main always names the terminal: `HIVE_SESSION_ID` is baked into the pty's
     * environment at spawn and never changes, so after a `/clear` it is still
     * calling the row that was retired. Reading `entities[id]` directly meant
     * `spawn → /clear → /done` found an already-ended row, returned early, and
     * left the successor `idle` on a pty that had exited — with no "terminal has
     * died" notice, stdin enabled, and no ending for any cap to reap. Main takes
     * the finished branch instead of publishing `terminated`, so nothing else
     * was coming to correct it either.
     */
    const target = currentSessionIn(get(), id);
    const current = get().entities[target];
    if (current === undefined || !isSession(current)) return;
    /*
      Already ended is a no-op rather than a re-write. `/done` posts once, but
      the exit that follows can reach `settleExit` by two routes — `ptyExit` and
      `ptyLost` — and a second pass must not resurrect a row the cap has since
      dropped, nor bounce the user out of a tab they have moved on to.
    */
    if (isEnded(current.status)) return;

    set((state) => {
      const finished: Session = {
        ...current,
        status: 'done',
        endedBy: 'finished',
        /*
          Main's answer, carried on the event — not inferred from the fact of a
          finish. `/done` usually keeps its uuid where `/clear` drops it, but a
          terminal that was cleared *and then* finished has no uuid left and no
          way to get one, so offering Resume there would start a new
          conversation while promising the old one. This flag is also what
          exempts the row from `DONE_CAP`.
        */
        resumable,
      };
      /*
        `idleDetail` is only ever set alongside `idle`; carrying one across
        would draw a hollow ring on an ended row (HIVE-83).
      */
      delete finished.idleDetail;
      // When it stopped — what the fleet table sorts ENDED by. See
      // `stampLifecycle`; `/done` reaches an ending without going through
      // `setSessionStatus`, so it has to stamp for itself.
      stampLifecycle(finished);
      return { entities: { ...state.entities, [target]: finished } };
    });

    /*
      Only when it is the tab actually on screen. Bouncing unconditionally
      would throw the user out of whatever they were reading because some other
      session finished in the background — which is precisely the kind of
      attention theft the fleet view exists to prevent.
    */
    const ui = useUiStore.getState();
    if (ui.activeTab === target) ui.backToOrch();
  },

  clearSession: (id) => {
    /**
     * Resolve to the terminal's live row first.
     *
     * A terminal cleared twice sends the same `HIVE_SESSION_ID` both times, so
     * the second `/clear` names a row that is already `done`. Retiring by that
     * id would no-op and leave the successor running under a conversation the
     * user has just wiped.
     */
    const targetId = currentSessionIn(get(), id);
    const current = get().entities[targetId];
    if (!current || !isSession(current) || isEnded(current.status)) return null;

    const successorId = nextSessionId(get().entities);
    const successor: Session = {
      kind: 'session',
      id: successorId,
      terminalId: terminalOf(current),
      project: current.project,
      status: 'idle',
      task: '',
      // A successor is a new session on an old terminal, so it is new *now* —
      // not when its predecessor opened. The two rows sit next to each other in
      // `order` and the table has to be able to tell them apart.
      createdAt: Date.now(),
      cost: '$0.00',
      lines: [],
      /**
       * The branch and directory carry over, and are now allowed to be absent
       * (HIVE-78).
       *
       * They describe the *terminal*, which `/clear` does not move: the pty is
       * still running, still in the same directory, still on the same branch.
       * Spread rather than assigned so a successor to a session nobody had
       * observed yet inherits an absent field rather than an explicit
       * `undefined` — the store's snapshots are compared key-for-key.
       */
      ...(current.branch === undefined ? {} : { branch: current.branch }),
      ...(current.cwd === undefined ? {} : { cwd: current.cwd }),
      ...(current.ticket === undefined ? {} : { ticket: current.ticket }),
      /*
        And how it was learned, with it. A successor that inherited the ticket
        but not the flag would be a row the user never spoke for that could no
        longer be corrected by speaking — the displacement rule reads this.
      */
      ...(current.ticketInferred === true ? { ticketInferred: true } : {}),
      /**
       * A pinned name **does** carry over, unlike a name the agent chose.
       *
       * The two are different claims. An agent's name described the
       * conversation that just ended, so it is dropped a few lines below. A
       * pinned name says "this terminal is working ABC-123", which is a fact
       * about the terminal and survives a `/clear` exactly as `ticket` does —
       * and the successor inherits `ticket`, so dropping the name would leave a
       * row on the ticket card with the agent's next auto-title on it.
       */
      ...(current.namePinned === true
        ? { namePinned: true, ...(current.name === undefined ? {} : { name: current.name }) }
        : {}),
      ...(current.model === undefined ? {} : { model: current.model }),
      ...(current.effort === undefined ? {} : { effort: current.effort }),
    };

    /**
     * The name the terminal is still advertising belongs to the conversation
     * that just ended. Until Claude names the new one, ignore it.
     */
    if (current.name !== undefined) {
      staleTitles.set(terminalOf(current), current.name);
    }

    set((state) => {
      /**
       * `idleDetail` is only ever set alongside `idle` — a retired row must
       * not carry one across, or `done` draws a hollow ring instead of the
       * solid brand dot it owns (HIVE-83). `StatusDot` now derives hollowness
       * from `status === 'idle'` too, so this is belt and braces rather than
       * the only guard.
       */
      /*
        `endedBy` is what keeps this row distinguishable from a `/done` one now
        that both are `done` (HIVE-93), and it is what stops the centre stage
        showing "this terminal has died" over a pty that is very much alive —
        the successor is using it.

        `resumable: false` is stated rather than omitted. Main drops this
        conversation's uuid on `/clear` (`sessions/index.ts`), so there is
        nothing to resume, and an absent field would read as "not yet known"
        to anything that later learns otherwise.
      */
      const retired: Session = {
        ...current,
        status: 'done',
        endedBy: 'cleared',
        resumable: false,
      };
      delete retired.idleDetail;
      // See `finishSession` — `/clear` is the other ending that never passes
      // through `setSessionStatus`.
      stampLifecycle(retired);
      const entities: Record<string, Entity> = {
        ...state.entities,
        [targetId]: retired,
        [successorId]: successor,
      };

      const at = state.order.indexOf(targetId);
      const order =
        at === -1
          ? [...state.order, successorId]
          : [
              ...state.order.slice(0, at),
              successorId,
              targetId,
              ...state.order.slice(at + 1),
            ];

      /**
       * Drop the oldest `done` rows past the cap — but never a resumable one.
       *
       * Oldest by position in `order`, which is spawn order — the same
       * definition of "oldest" every other capped list in this store uses.
       * Their entities go with them; an entity nothing lists is a leak.
       *
       * **The `resumable` exemption is not a refinement, it is what keeps the
       * cap honest** (HIVE-93). Capping `done` was justified by one sentence:
       * "a cleared session's successor is right there", so nothing is lost. The
       * moment `done` also meant `/done` and an app quit, that stopped being
       * true — neither has a successor, and both keep a conversation the user
       * can reopen. Dropping those would delete the row *and* the only visible
       * route back to a transcript that still exists on disk.
       *
       * A cleared row is still capped, and still for the original reason: its
       * uuid was dropped, so `resumable` is false and there is nothing behind it
       * that its successor does not already carry.
       */
      const doneIds = order.filter((entityId) => {
        const entity = entities[entityId];
        return (
          entity !== undefined &&
          isSession(entity) &&
          entity.status === 'done' &&
          entity.resumable !== true
        );
      });
      const excess = new Set(doneIds.slice(0, Math.max(0, doneIds.length - DONE_CAP)));
      if (excess.size > 0) {
        for (const dropped of excess) delete entities[dropped];
      }

      return {
        entities,
        order: excess.size === 0 ? order : order.filter((e) => !excess.has(e)),
      };
    });

    /**
     * Follow the terminal, not the row.
     *
     * The user is looking at this terminal — they just typed into it. If the
     * retired row was on screen, the successor has to take the stage or the
     * next keystroke goes to a tab that no longer accepts one.
     */
    if (useUiStore.getState().activeTab === targetId) {
      useUiStore.getState().openTab(successorId);
    }

    /**
     * The console is the only place the retired session is now named.
     *
     * Its row is inert and carries no transcript, so without this line a
     * session the user worked in for an hour would leave no trace of *what* it
     * was — only that something called `sess-04` finished.
     */
    set((state) => ({
      orchLines: capLines([
        ...state.orchLines,
        // `entityLabel`, not a hand-spelled `?? ` — the fallback also has to
        // catch an *empty* name, which is the one case `??` lets through, and
        // spelling it here is the duplication that function exists to prevent.
        line(`  ✓ ${entityLabel(current)} done — cleared`, 'green'),
        // No successor id (HIVE-91): it has no name yet, and the row on the rail
        // is where the user will meet it.
        line('  ▸ a new session started in the same terminal', 'dim'),
      ]),
    }));

    return successorId;
  },

  /**
   * Install real issues (HIVE-69), **keeping both slices' identity when the
   * answer has not changed** (HIVE-81).
   *
   * The identity guard arrived with the poller. Before it, this ran once on
   * mount and an unconditional `set` cost nothing; now it runs every minute
   * whether or not Jira has anything new, and both slices are subscribed to by
   * name (`useTickets`, `useTicketSource`), so a quiet minute would re-render
   * the whole WORK panel and re-resolve every card's sessions. Most minutes are
   * quiet minutes. This is exactly what {@link HiveState.hydratePrs} does, for
   * exactly the same reason.
   *
   * Wholesale replacement is still safe when something *did* change: the
   * ticket→session link lives on `Session.ticket`, which this never touches.
   */
  hydrateTickets: (issues, capped) =>
    set((state) => {
      const tickets = issues.map((issue) => ({
        key: issue.key,
        status: issue.status,
        statusCategory: issue.statusCategory,
        title: issue.summary,
        url: issue.url,
      }));

      const source = state.ticketSource;
      const settled =
        source.kind === 'live' && !source.stale && source.capped === capped;

      return {
        tickets: sameTickets(tickets, state.tickets) ? state.tickets : tickets,
        ticketSource: settled
          ? source
          : { kind: 'live', stale: false, capped },
      };
    }),

  /**
   * A read failed — **staleness over emptiness**.
   *
   * If there are already live tickets they stay exactly as they are and only
   * `stale` flips. Replacing a populated panel with an error is the wrong trade
   * for a tool the user leaves open on a second monitor: the tickets it is
   * showing were true a minute ago, and "possibly out of date" is far more
   * useful than nothing at all.
   *
   * With no live tickets there is nothing to keep, so the failure is the state.
   *
   * **Already-failed stays put**, exactly as {@link HiveState.reportPrFailure}
   * does it and now for the same reason: this runs on every sweep, so a Jira
   * outage re-reports the same failure once a minute for as long as it lasts,
   * and minting a new `ticketSource` each time would re-render the WORK panel —
   * and re-resolve every card's sessions — to say precisely what it already
   * said.
   */
  reportTicketFailure: (message) =>
    set((state) => {
      const source = state.ticketSource;

      if (source.kind === 'live') {
        // `return state` rather than an empty patch: zippering an unchanged
        // partial still rebuilds the root object and wakes every listener.
        return source.stale ? state : { ticketSource: { ...source, stale: true } };
      }

      return source.kind === 'failed' && source.message === message
        ? state
        : { ticketSource: { kind: 'failed', message } };
    }),

  /**
   * Nothing to read from — and repeating that conclusion changes nothing.
   *
   * This is the path that repeats longest of all: a machine with no Jira site
   * configured reaches it on every sweep, forever. Both slices are held so the
   * panel's explanation renders once rather than once a minute, which is what
   * {@link HiveState.reportPrsUnconfigured} already does.
   */
  reportTicketsUnconfigured: () =>
    set((state) => {
      const settled = state.ticketSource.kind === 'unconfigured';

      if (settled && state.tickets.length === 0) return state;

      return {
        tickets: state.tickets.length === 0 ? state.tickets : [],
        ticketSource: settled ? state.ticketSource : { kind: 'unconfigured' },
      };
    }),

  /**
   * Replace one ticket, in place (HIVE-70).
   *
   * Not `hydrateTickets`. Re-running the whole query after moving one issue
   * would reorder the panel under the user's cursor — the default query sorts
   * by `updated`, and the issue they just transitioned is now the most recently
   * updated one, so it would jump to the top the instant they clicked.
   *
   * An unknown key is a no-op rather than an append: a transition can only be
   * applied to a ticket that is on screen, so a key that is not in the list
   * means the list changed underneath and the next refresh is the right fix —
   * not an orphan row nothing else knows about.
   *
   * There is no longer anything to carry over. This used to preserve a
   * `sessions` array, which was the tell that the link was stored in the wrong
   * place: every writer of a ticket had to remember to copy it forward, and
   * exactly one of them did. Moving the key onto the session deleted the
   * obligation rather than satisfying it (HIVE-73).
   */
  updateTicket: (issue) =>
    set((state) => {
      const at = state.tickets.findIndex((ticket) => ticket.key === issue.key);
      if (at === -1) return state;

      const next = [...state.tickets];
      next[at] = {
        key: issue.key,
        status: issue.status,
        statusCategory: issue.statusCategory,
        title: issue.summary,
        url: issue.url,
      };
      return { tickets: next };
    }),

  /**
   * Read the configured query and install the answer (HIVE-69).
   *
   * Lives on the store rather than in a hook for the same reason `sendToEntity`
   * does: it is a domain action with a browser-target gate, and the gate is
   * `isDesktop()` — feature-detecting the bridge, never the user agent.
   *
   * Never throws. `lib/jira.ts` answers `null` instead of rejecting, and `null`
   * here means the channel itself failed, which is a failure with a message
   * rather than an exception a panel would have to catch.
   */
  refreshTickets: async () => {
    /**
     * A browser has no bridge, so it has no Jira — and that is a
     * configuration answer, not a failure. It settles here rather than sitting
     * on `loading` forever, which is what an early `return` would now mean.
     */
    if (!isDesktop()) {
      get().reportTicketsUnconfigured();
      return;
    }

    /**
     * One sweep at a time, however many callers ask.
     *
     * The poller dedups its own ticks, but the WORK panel's "Try again" calls
     * this action directly — so a retry clicked while a slow sweep is out used
     * to start a second Jira search. The harm is the one `refreshPrs` writes
     * down: if the retry answered first and the older sweep then failed,
     * `reportTicketFailure` would mark the just-installed fresh list stale,
     * putting a "may be out of date" banner over data a second old. Sharing the
     * promise makes the retry *join* the sweep instead of racing it.
     *
     * Wraps the status read as well as the search, because both hops cost a
     * round trip and neither is worth doing twice concurrently.
     */
    inFlightTicketSweep ??= (async () => {
      /**
       * **Nothing here sets `loading`.** That is the boot state, left to the
       * first answer to clear, permanently — `refreshPrs`'s rule, and tickets
       * now need it for the same reason.
       *
       * This used to announce every sweep that was not already `live`, which
       * was harmless when it ran once on mount. Now it polls: on a machine with
       * no Jira configured — or through any Jira outage — the source is
       * `unconfigured`/`failed` and stays that way, so every sweep replaced the
       * panel's explanation (and, in the `failed` case, the retry button the
       * user was reaching for) with three pulsing skeleton rows, once a minute,
       * forever.
       *
       * The case the old guard was protecting is protected by its absence: a
       * settled `live` list is never blanked, because nothing blanks anything.
       */
      const status = await readJiraStatus();
      if (status === null) {
        get().reportTicketFailure(
          'The app could not reach its own main process.',
        );
        return;
      }
      if (
        status.site === null ||
        status.email === null ||
        status.credential.kind === 'none' ||
        status.credential.kind === 'unavailable'
      ) {
        get().reportTicketsUnconfigured();
        return;
      }

      /**
       * No `jql` here on purpose.
       *
       * The configured override is applied in **main**, which already reads the
       * config on every verb. Passing it from the renderer would mean the store
       * reading a setting, holding it, and racing a hand-edit of the file — for
       * a value main has in front of it anyway.
       */
      const result = await searchJiraIssues();
      if (result === null) {
        get().reportTicketFailure(
          'The app could not reach its own main process.',
        );
        return;
      }
      if (!result.ok) {
        get().reportTicketFailure(result.error.message);
        return;
      }
      get().hydrateTickets(result.value.issues, result.value.capped);
    })().finally(() => {
      inFlightTicketSweep = null;
    });

    return inFlightTicketSweep;
  },

  /**
   * Install a sweep's answer — **keeping both slices' identity when the answer
   * has not changed.**
   *
   * The poller sweeps every minute whether or not GitHub has anything new, and
   * an unconditional `set` handed the renderer two brand-new objects each time.
   * Both are subscribed to by name (`usePrs`, `usePrSource`), so a quiet minute
   * still re-rendered the PR panel and re-resolved every row's owning session
   * against the fleet. Most minutes are quiet minutes.
   *
   * `prSource` is compared as well as `prs`, and not as an afterthought: leaving
   * it churning would have left the panel re-rendering once a minute regardless
   * of what `prs` did, which is the whole thing this is here to stop. The
   * comparison covers `stale` because a sweep succeeding after a failure is a
   * real change — it is what takes the "may be out of date" banner down.
   */
  hydratePrs: (prs, repos) => {
    /**
     * What this sweep taught the fleet about itself, computed **before** the
     * write and applied inside it.
     *
     * Read through `get()` rather than from the updater's argument so the
     * notes can leave the `set` call: a zustand updater must be pure — it is
     * the wrong place to fire IPC — and the two see the same state, because
     * `set` is synchronous and nothing runs between these two lines.
     */
    const learned = learnSessionPrs(get(), prs);

    set((state) => {
      const source = state.prSource;
      const settled =
        source.kind === 'live' && !source.stale && source.repos === repos;
      const entities = rememberSessionPrs(state.entities, learned);

      return {
        prs: samePrs(prs, state.prs) ? state.prs : prs,
        prSource: settled ? source : { kind: 'live', stale: false, repos },
        // Omitted rather than assigned when nothing was learned — the common
        // case by a wide margin, once a fleet's PRs have settled. Writing an
        // identical map back would wake every entity subscriber on every tick
        // of a once-a-minute poller.
        ...(entities === state.entities ? {} : { entities }),
      };
    });

    // Fire-and-forget, and only for what actually changed. A steady fleet under
    // a running poller sends nothing.
    for (const note of learned) noteSessionPr(note);
  },

  /**
   * A sweep failed — **staleness over emptiness**, exactly as
   * {@link HiveState.reportTicketFailure} does it.
   *
   * A live list stays listed and only `stale` flips. This matters more here
   * than it does for tickets: the sweep runs every minute, so a single flaky
   * minute would otherwise blank a panel the user is looking at and fill it
   * again a minute later. With no live list there is nothing to keep, and the
   * failure is the state.
   *
   * **Already-failed stays put**, for the reason {@link HiveState.hydratePrs}
   * keeps an unchanged answer: a failure that persists is the *common* case, not
   * the exotic one. A machine with no network re-reports the same failure every
   * minute for as long as it is offline, and minting a new `prSource` each time
   * would re-render the panel once a minute to say exactly what it already said.
   */
  reportPrFailure: (message) =>
    set((state) => {
      const source = state.prSource;

      if (source.kind === 'live') {
        // `return state` rather than an empty patch: zippering an unchanged
        // partial still rebuilds the root object and wakes every listener.
        // Returning the state itself is what `setSessionStatus` does, and
        // zustand short-circuits on it.
        return source.stale ? state : { prSource: { ...source, stale: true } };
      }

      return source.kind === 'failed' && source.message === message
        ? state
        : { prSource: { kind: 'failed', message } };
    }),

  /**
   * Nothing to read from.
   *
   * Clears the list, unlike a failure: `unconfigured` is a *conclusion* — no
   * `gh`, no login, or no GitHub-backed project — and rows from a previous
   * configuration would be claiming to describe a setup that no longer exists.
   *
   * Repeating the same conclusion changes nothing, and this is the path that
   * repeats longest of all: a machine without `gh` installed reaches it on every
   * sweep, forever. Both slices are held so the panel's explanation renders once
   * rather than once a minute.
   */
  reportPrsUnconfigured: (message) =>
    set((state) => {
      const source = state.prSource;
      const settled =
        source.kind === 'unconfigured' && source.message === message;

      if (settled && state.prs.length === 0) return state;

      return {
        prs: state.prs.length === 0 ? state.prs : [],
        prSource: settled ? source : { kind: 'unconfigured', message },
      };
    }),

  /**
   * Sweep GitHub and install the answer.
   *
   * Lives on the store rather than in the hook that schedules it, for the same
   * reason `refreshTickets` does: it is a domain action with a browser-target
   * gate, and the gate is `isDesktop()` — feature-detecting the bridge, never
   * the user agent. The hook owns *when*; this owns *what*.
   *
   * Never throws. `lib/github.ts` answers `null` instead of rejecting, and
   * `null` here means the channel itself failed.
   *
   * **Nothing here sets `loading`.** That is the boot state and it is left to
   * the first answer to clear, permanently. An earlier version announced every
   * sweep that was not already `live`, which flickered the two states that most
   * need to stay readable: an `unconfigured` explanation and a `failed` message
   * with its retry button were both replaced by a skeleton once a minute, for
   * as long as the sweep took — up to twenty seconds of every sixty in which
   * the button the user was reaching for did not exist.
   */
  refreshPrs: async () => {
    if (!isDesktop()) {
      get().reportPrsUnconfigured(
        'Pull requests need the desktop app — this is the browser preview.',
      );
      return;
    }

    /**
     * One sweep at a time, however many callers ask.
     *
     * The poller already dedupes its own ticks, but "Try again" calls this
     * directly — so a retry clicked while a slow sweep is out used to start a
     * second `gh`. The harm is specific: if the retry answered first and the
     * older sweep then timed out, `reportPrFailure` would mark the
     * just-installed fresh list stale, putting a "may be out of date" banner
     * over data a second old. Sharing the promise makes the retry *join* the
     * sweep instead of racing it.
     */
    inFlightPrSweep ??= (async () => {
      const result = await readPullRequests();

      if (result === null) {
        get().reportPrFailure('The app could not reach its own main process.');
        return;
      }

      if (!result.ok) {
        /**
         * Three of the seven error kinds are *configuration*, not failure.
         *
         * They are the difference between a panel that explains what to set up
         * and one that apologises for something the user did not do. The other
         * four — offline, timeout, rate-limited, unknown — are failures, and a
         * live list survives them as stale.
         */
        const { kind, message } = result.error;
        if (
          kind === 'not-installed' ||
          kind === 'unauthenticated' ||
          kind === 'no-repos'
        ) {
          get().reportPrsUnconfigured(message);
          return;
        }

        get().reportPrFailure(message);
        return;
      }

      get().hydratePrs(result.value.prs, result.value.repos);
    })().finally(() => {
      inFlightPrSweep = null;
    });

    return inFlightPrSweep;
  },

  searchPrs: async (term, projectId) => {
    /*
      A monotonic ticket, not the term.

      Comparing terms is not enough: the debounce re-runs on a *scope* change
      too — ticking "All repos" re-queries the same words — so two requests can
      be in flight for one term, and the narrow one landing last would leave
      narrow results sitting under a checked "All repos". A counter is the only
      thing that distinguishes them, because the only difference between the two
      requests is which one was asked for second.
    */
    prSearchTicket += 1;
    const ticket = prSearchTicket;

    set((state) => ({
      prSearch: { ...state.prSearch, term, searching: true, error: null },
    }));

    if (!isDesktop()) {
      set({
        prSearch: {
          term,
          results: [],
          searching: false,
          error: 'Search needs the desktop app — this is the browser preview.',
        },
      });
      return;
    }

    const result = await searchPullRequests(term, projectId);

    // Superseded while it was out. Whatever this found is about a question the
    // user has already moved on from — a different term, or the same term at a
    // different scope.
    if (ticket !== prSearchTicket) return;

    if (result === null) {
      set({
        prSearch: {
          term,
          results: [],
          searching: false,
          error: 'The app could not reach its own main process.',
        },
      });
      return;
    }

    if (!result.ok) {
      set({
        prSearch: {
          term,
          results: [],
          searching: false,
          error: result.error.message,
        },
      });
      return;
    }

    set({
      prSearch: { term, results: result.value, searching: false, error: null },
    });
  },

  clearPrSearch: () => {
    // Retires anything in flight, so a search cancelled mid-request cannot
    // land its results into an empty box.
    prSearchTicket += 1;
    set({ prSearch: { term: '', results: null, searching: false, error: null } });
  },

  reset: () => {
    spawnCounter = 0;
    staleTitles.clear();
    // A sweep from the previous state must not install its answer into the new
    // one — dropping the handle makes the next caller start fresh.
    inFlightPrSweep = null;
    inFlightTicketSweep = null;
    // Same rule for a search in flight: bumping the ticket retires it, so its
    // answer cannot install itself into the fresh state.
    prSearchTicket += 1;
    /**
     * Nothing in this store stamps through the clock any more — the activity
     * feed was its only caller and the project explorer replaced it. The rewind
     * stays because the clock itself stays: it is documented infrastructure for
     * the simulation story, which will be its first consumer, and a store that
     * quietly stopped resetting a global would be a trap for whoever writes it.
     */
    resetClock();
    set({
      ...emptySeeds(),
      notifs: [],
      ledger: [],
      metrics: {},
      ticketSource: { kind: 'loading' },
      prSource: { kind: 'loading' },
      prSearch: { term: '', results: null, searching: false, error: null },
    });
  },
}));

/**
 * Selector hooks — the incorpx rule.
 *
 * Components never read the store object directly and never subscribe to the
 * whole store. Derived values are computed here, never stored, so there is
 * exactly one source of truth for every number on screen.
 */

/** One entity, or undefined. */
export const useEntity = (id: string) =>
  useHiveStore((state) => state.entities[id]);

/**
 * NUL, because it is the one byte neither an entity id nor a
 * `hiveNameFromTitle` output can contain — so it can never appear inside either
 * half of an encoded pair.
 */
const SESSION_NAME_SEPARATOR = '\u0000';

const sessionNameFieldsSelector = (state: HiveState): string[] =>
  state.order.flatMap((id) => {
    const entity = state.entities[id];
    if (entity === undefined || !isSession(entity) || isEnded(entity.status)) {
      return [];
    }
    /*
      `name ?? id` — the string the rail is actually showing, so main's toast and
      the rail agree even before Claude has titled the session (HIVE-108).
    */
    return [
      `${terminalOf(entity)}${SESSION_NAME_SEPARATOR}${entity.name ?? id}`,
    ];
  });

/**
 * Every live session, as `{ terminalId, name }` (HIVE-110).
 *
 * Encoded as strings and parsed back, for the reason `editor-store`'s
 * `tabFieldsSelector` spells out: `useShallow` compares one level deep, so a
 * selector returning freshly-built objects compares unequal on every render and
 * tears the subscriber down with "Maximum update depth exceeded". Strings it
 * can compare, so this re-renders when a session is opened, renamed or ended —
 * and not on a keystroke, a status change or a transcript line.
 *
 * **Live rows only.** An ended row keeps its own name and shares its terminal
 * with the successor a `/clear` minted, so including both would report two
 * names for one terminal and let the retired one win by list order.
 */
export const useSessionNameReports = (): SessionNameReport[] => {
  const encoded = useHiveStore(useShallow(sessionNameFieldsSelector));

  return useMemo(
    () =>
      encoded.map((entry) => {
        /*
          `-1` cannot happen — the encoder above always writes the separator —
          but it would decode silently and wrongly if it ever did (`slice(0, -1)`
          truncates the id, `slice(0)` returns the whole pair as the name). The
          fallback keeps the invariant in the code rather than only in a comment.
        */
        const at = entry.indexOf(SESSION_NAME_SEPARATOR);
        if (at === -1) return { terminalId: entry, name: entry };
        return {
          terminalId: entry.slice(0, at),
          name: entry.slice(at + SESSION_NAME_SEPARATOR.length),
        };
      }),
    [encoded],
  );
};

/**
 * What to call the session a **terminal** id names, right now (HIVE-110).
 *
 * The inbox's answer to a notification that outlives the name it was raised
 * under. Main raises a row carrying the terminal and the predicate alone
 * (`HiveNotification.subject`), and this resolves the words in front of it on
 * every render — so a session that titles itself an hour after the row landed
 * renames the row too, and a `sess-11` the user has never seen anywhere else
 * never appears.
 *
 * Resolved through `currentSessionIn`, the same mapping `currentRowFor` applies
 * to the click. That identity is the load-bearing part: whatever this hook names,
 * the click goes to, so the two can never describe different sessions — including
 * in the awkward case below, where the answer is debatable but is at least the
 * *same* debatable answer at both ends.
 *
 * ## What it answers once a terminal's whole lineage has ended
 *
 * `currentSessionIn` looks for a **live** row on the terminal and falls back to
 * the id it was given. For a terminal whose sessions have all ended, that id is
 * the original session — the pre-`/clear` predecessor, where there was a
 * `/clear` — and its entity is still in the store, so this renders the
 * *predecessor's* name rather than the successor's. Left as it is rather than
 * made to hunt for the most recently ended row: it names a session that really
 * did run on that terminal, `currentRowFor` sends the click to exactly that row,
 * and a notification about a lineage that is entirely over is a row on its way
 * out.
 *
 * The terminal id is the fallback for a terminal the store knows nothing about,
 * and `name ?? id` for a session Claude has not titled yet (HIVE-108) — which is
 * what the rail itself shows, so the row and the rail agree even while neither
 * has a name.
 *
 * Returns a **string**, so a subscriber re-renders when the name changes and
 * not when anything else about the entity does.
 */
export const useDisplayName = (terminalId: string): string =>
  useHiveStore((state) => {
    /*
      A row about no session at all — `pr.*`, `clone.done`, `app.update_*` —
      calls this with `''`, because a hook cannot be conditional. Answered before
      `currentSessionIn`, which would otherwise miss its `entities[terminalId]`
      fast path and walk the whole fleet on every store write, for a value the
      card then discards.
    */
    if (terminalId === '') return terminalId;

    /*
      Narrowed to a session rather than reading `name` off `Entity`, because an
      `Agent` has no name.
    */
    const id = currentSessionIn(state, terminalId);
    const entity = state.entities[id];
    /*
      The **row** id rather than the terminal, because that is what every other
      surface shows: after a `/clear` the two differ and the rail is naming the
      successor.
    */
    return entity !== undefined && isSession(entity)
      ? (entity.name ?? id)
      : terminalId;
  });

/** Session counts by status — drives the header (story 021). */
export const useCounts = () =>
  useHiveStore(
    useShallow((state) => {
      /**
       * Every member of `SessionStatus`, spelled out and typed as such.
       *
       * The literal used to list four of five, so a session in the missing
       * state incremented `undefined` and put a `NaN` in the header — a whole
       * count silently reading "NaN done" the first time any session ended.
       * `Record<SessionStatus, number>` is what makes the next status a compile
       * error instead of that.
       */
      const counts: Record<SessionStatus, number> = {
        working: 0,
        waiting: 0,
        idle: 0,
        done: 0,
        terminated: 0,
      };
      for (const id of state.order) {
        const entity = state.entities[id];
        if (!entity || !isSession(entity)) continue;
        /**
         * A quiet main agent with something still running counts as
         * **working**, not idle.
         *
         * The status field is still `idle` and still correct — it is what a
         * hook observed about the main agent — but this tally is read beside
         * the rows it describes, and every one of those rows now says
         * `working (agents)` in green. Bucketing on the raw status put three
         * green `working (agents)` rows under a header reading
         * `0 working · 0 waiting · 3 idle`, which is the header and the table
         * contradicting each other about the same three sessions.
         *
         * So the number answers the question the label answers — *is this task
         * progressing* — rather than the one the status field answers. The
         * distinction is not lost: {@link useIdleDetailCounts} still keys on
         * `status === 'idle'` and feeds the tooltip's `N with agents`
         * breakdown, which is where it has room to be spelled out.
         *
         * The cost, stated plainly: `counts` is no longer a partition of
         * `SessionStatus` by that field. It is still keyed by it, and the
         * `Record<SessionStatus, number>` above still makes a sixth status a
         * compile error — which is the property that entry exists for.
         */
        const bucket =
          entity.status === 'idle' && entity.idleDetail !== undefined
            ? 'working'
            : entity.status;
        counts[bucket] += 1;
      }
      return counts;
    }),
  );

/**
 * Idle sessions, broken down by what is still running (HIVE-83).
 *
 * A second selector rather than a wider `useCounts()`: the header's visible
 * tally stays five numbers on purpose (widening it was the thing this story
 * deliberately did not do), and this feeds the tooltip only. Computed here,
 * never stored — one source of truth per number on screen, same rule as
 * `useCounts()`.
 */
export const useIdleDetailCounts = () =>
  useHiveStore(
    useShallow((state) => {
      let agents = 0;
      let script = 0;
      for (const id of state.order) {
        const entity = state.entities[id];
        if (!entity || !isSession(entity) || entity.status !== 'idle') continue;
        if (entity.idleDetail === 'agents') agents += 1;
        else if (entity.idleDetail === 'script') script += 1;
      }
      return { agents, script };
    }),
  );

/** Active sessions first, then ended ones — the keyboard nav order (041, 060). */
export const useNavOrder = () =>
  useHiveStore(
    useShallow((state) => {
      /**
       * **Two** buckets, each newest-first, and both facts are the table's
       * rather than this selector's.
       *
       * There were three until the fleet table stopped drawing a PREVIOUS RUN
       * divider: restored rows are ended rows, and once every group sorts by
       * recency they interleave with this run's endings correctly on their own.
       * The `restored` flag is still on the entity — Resume and `endedReason`
       * both read it — it simply no longer partitions anything.
       *
       * This selector exists precisely to keep the caret and the rows agreeing
       * about where "here" is, so the partition *and* the sort have to match
       * `session-table.tsx` exactly. A flattening in a different order from the
       * one on screen makes the down arrow skip a row and come back to it.
       */
      const active: string[] = [];
      const ended: string[] = [];
      for (const id of state.order) {
        const entity = state.entities[id];
        if (!entity || !isSession(entity)) continue;
        if (isEnded(entity.status)) ended.push(id);
        else active.push(id);
      }
      return [
        ...byRecency(active, state.entities),
        ...byRecency(ended, state.entities),
      ];
    }),
  );

/**
 * Sessions either side of the orchestrator table's ENDED divider (041).
 *
 * Two flat selectors rather than one returning `{ active, done }`. `useShallow`
 * compares the *returned value's* own properties, so an object of two freshly
 * built arrays is never shallow-equal to the last one — the component
 * re-renders, rebuilds the arrays, and loops until React gives up. Flat arrays
 * are compared element by element, which is what makes them stable.
 *
 * Derived here rather than in the component so they stay consistent with
 * `useNavOrder()`, which flattens the same partition into the keyboard order.
 *
 * **Both are newest-first** (`byRecency`). The table used to paint `order`
 * straight through, which is insertion order — so the newest session was at the
 * bottom of the live group, and the ended half read oldest-first from the top,
 * with last run's rows arriving in the session history's own oldest-ending-first
 * sequence. The one row a fleet table exists to show first was reliably the one
 * furthest from the header.
 */
const isActiveSession = (entity: Entity | undefined) =>
  entity !== undefined && isSession(entity) && !isEnded(entity.status);

export const useActiveSessions = () =>
  useHiveStore(
    useShallow((state) =>
      byRecency(
        state.order.filter((id) => isActiveSession(state.entities[id])),
        state.entities,
      ),
    ),
  );

/**
 * The other side of the divider: finished *and* terminated (story 108), and
 * since this story **also last run's**.
 *
 * One group rather than two, because the divider answers "is this still going?"
 * and both answers are no. The row itself says which kind of ended it is, which
 * is where that distinction is actually useful.
 *
 * ## Why PREVIOUS RUN is gone
 *
 * It used to be a third group with a divider of its own, and this selector
 * excluded `restored` rows to feed it. The justification was real but was
 * entirely about *ordering*: "what did I just finish?" is about this run of the
 * app, and while every list was in insertion order a launch or two buried
 * today's two endings under yesterday's twenty. A divider was the cheapest way
 * to keep the recent answer at the top.
 *
 * Sorting by recency answers the same question directly and better. Today's
 * endings are at the top because they are the most recent, and a row from last
 * week is below them without needing a heading to say so — while the awkward
 * case the divider handled badly, a session that ended thirty seconds before
 * the app was quit and now sits under a heading called PREVIOUS RUN, simply
 * lands where it belongs.
 *
 * `restored` is still on the entity and still load-bearing: Resume is only
 * offered on rows main says are resumable, and `endedReason` uses it to explain
 * *how* a row ended. It just no longer decides which list a row is in.
 */
export const useEndedSessions = () =>
  useHiveStore(
    useShallow((state) =>
      byRecency(
        state.order.filter((id) => {
          const entity = state.entities[id];
          return (
            entity !== undefined && isSession(entity) && isEnded(entity.status)
          );
        }),
        state.entities,
      ),
    ),
  );

/**
 * Does any row on the fleet table offer Resume? (HIVE-100)
 *
 * A **table-level** question, which is what makes it a store selector rather
 * than something each row works out for itself. Resume is a control beside the
 * row, outside the button that holds the cells, so it occupies width the
 * columns do not — and a slot reserved per-row would put the `PR` cell of a
 * resumable row in a different place from its neighbour's, and both of them
 * somewhere other than under the header. One answer for the whole table is what
 * keeps the column a column.
 *
 * Reserved only when something needs it, because the width is not free: the
 * table's floors are measured against a 1100px window (see `COL` in
 * `session-table.tsx`), and a slot held open on every launch would spend that
 * headroom on a control most fleets never show.
 *
 * The predicate is the row's own — `ended` **and** `resumable` — deliberately
 * duplicated rather than exported, because these are two different questions
 * that happen to share an answer: this one asks whether to hold the space open,
 * the row asks whether to draw the button. Reads `order`, so it sees exactly
 * the rows the table draws, and returns a boolean rather than a list, so the
 * header re-renders only when the answer flips.
 */
export const useHasResumable = (): boolean =>
  useHiveStore((state) =>
    state.order.some((id) => {
      const entity = state.entities[id];
      return (
        entity !== undefined &&
        isSession(entity) &&
        isEnded(entity.status) &&
        entity.resumable === true
      );
    }),
  );

/**
 * The background agents, alphabetically (HIVE-114).
 *
 * Was "in fixture order (story 033)" — there are no agent fixtures any more.
 * The order comes from `hydrateAgents`, and it is alphabetical because a
 * folder listing has no meaningful order of its own and the user names these
 * themselves.
 */
export const useAgentOrder = () =>
  useHiveStore(useShallow((state) => state.agentOrder));

/**
 * One agent by name, or `null` if that id is not an agent (HIVE-114).
 *
 * Narrows rather than casting, so a caller handed a *session*'s id gets `null`
 * instead of a row that renders half-correctly — `entities` is one map and the
 * two kinds share it.
 */
export const useAgent = (name: string) =>
  useHiveStore((state) => {
    const entity = state.entities[name];

    return entity !== undefined && isAgent(entity) ? entity : null;
  });

/**
 * One agent's run log.
 *
 * A selector rather than `useAgent(name).lines` so a line batch re-renders the
 * run view and nothing else — the same reason every other consumer here goes
 * through a named hook.
 */
export const useAgentLines = (name: string): TermLine[] =>
  useHiveStore((state) => {
    const entity = state.entities[name];

    return entity !== undefined && isAgent(entity) ? entity.lines : EMPTY_LINES;
  });

/**
 * Stable identity for an agent that has never run, and for a name that is not
 * an agent at all — a fresh `[]` per call re-renders every consumer on any
 * unrelated store write. The same reason `EMPTY_LINES` exists above it.
 */
const EMPTY_RUNS: RunSummary[] = [];

export interface AgentGroup {
  key: 'awake' | 'sleeping' | 'paused';
  label: string;
  ids: string[];
}

/**
 * The rail's groups, in the order they are read (HIVE-116).
 *
 * The question a grouping answers here is *should I look at this?*, which is
 * why `failed` files under Awake rather than earning a fourth group: a broken
 * agent is not resting, and filing it under Sleeping would bury the one row
 * that actually needs a person. Inside Awake, `asking` sorts first and ties
 * break on the most recent run — the same "what needs me first" order the
 * fleet table reads in.
 *
 * An empty group is omitted rather than drawn with a zero: a header reading
 * `PAUSED 0` is a line of noise about nothing.
 */
export const useAgentsByGroup = (): AgentGroup[] => {
  /*
    The three fields the grouping reads, and nothing else.

    Subscribing to `state.entities` re-ran this on every write to *any* entity
    — a line batch from a running agent, a session's status change — because
    the map's identity changes each time, and the memo below then handed every
    row a fresh object. `useShallow` over a flat tuple list means an unrelated
    write compares equal and the rail does not re-render at all. This is the
    rule `CLAUDE.md` states as keeping a picker keystroke from re-rendering
    thirteen live terminals.
  */
  const rows = useHiveStore(
    useShallow((state) =>
      state.agentOrder.flatMap((id) => {
        const entity = state.entities[id];

        // `entities` holds both kinds and an agent name is a legal session id,
        // so the same narrowing every other agent selector does.
        if (entity === undefined || !isAgent(entity)) return [];

        return [`${id}|${entity.status}|${entity.lastRunAt ?? 0}`];
      }),
    ),
  );

  return useMemo(() => {
    /*
      Encoded as strings, not tuples, and that is `useShallow`'s doing: it
      compares the returned array's elements by identity, so an array of freshly
      built tuples is never equal to the last one — every read looks like a
      change, `useSyncExternalStore` re-renders, and React stops it with
      "maximum update depth exceeded". Primitives compare by value and settle.

      `|` is safe as a separator: `AGENT_NAME_PATTERN` admits lowercase letters,
      digits and dashes only.
    */
    const parsed = rows.map((row) => {
      const [id = '', status = '', lastRunAt = '0'] = row.split('|');

      return { id, status, lastRunAt: Number(lastRunAt) };
    });

    const bucket: Record<AgentGroup['key'], (typeof parsed)[number][]> = {
      awake: [],
      sleeping: [],
      paused: [],
    };

    for (const row of parsed) {
      if (row.status === 'paused') bucket.paused.push(row);
      else if (row.status === 'sleeping') bucket.sleeping.push(row);
      else bucket.awake.push(row);
    }

    bucket.awake.sort((a, b) => {
      if (a.status === 'asking' && b.status !== 'asking') return -1;
      if (b.status === 'asking' && a.status !== 'asking') return 1;

      return b.lastRunAt - a.lastRunAt;
    });

    const labels: Record<AgentGroup['key'], string> = {
      awake: 'Awake',
      sleeping: 'Sleeping',
      paused: 'Paused',
    };

    return (['awake', 'sleeping', 'paused'] as const)
      .filter((key) => bucket[key].length > 0)
      .map((key) => ({
        key,
        label: labels[key],
        ids: bucket[key].map((row) => row.id),
      }));
  }, [rows]);
};

/** One agent's run summaries, **oldest first** — most recent last. */
export const useAgentRuns = (name: string): RunSummary[] =>
  useHiveStore((state) => {
    const entity = state.entities[name];

    return entity !== undefined && isAgent(entity) ? entity.runs : EMPTY_RUNS;
  });

export interface AgentFacts {
  status: AgentStatus;
  /** The open ask this agent is waiting on, when it is `asking`. */
  askRef?: string;
  wake: string;
  next: string;
  todayRuns: number;
  todayCost: string;
  sessionUuid?: string;
  runsSinceRotate: number;
  rotateAfter: number;
}

/**
 * The agent view's five fact tiles, derived on read (HIVE-116).
 *
 * "Today" is the **user's** calendar day, compared with `toDateString()` rather
 * than against a UTC boundary — the same reason the ledger files itself by
 * local day: it is the person's day, and there is no server to have another
 * one. Storing the pair instead would make it wrong every midnight.
 */
export const useAgentFacts = (name: string): AgentFacts | null => {
  const entity = useHiveStore((state) => state.entities[name]);
  const ledger = useHiveStore((state) => state.ledger);

  return useMemo(() => {
    if (entity === undefined || !isAgent(entity)) return null;

    const today = new Date().toDateString();
    const todays = entity.runs.filter(
      (run) => new Date(run.startedAt).toDateString() === today,
    );
    const spend = todays.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
    const spent = formatRunCost(spend);
    const open = openAsks(ledger, Date.now()).find((ask) => ask.from === name);

    return {
      status: entity.status,
      ...(open?.ref === undefined ? {} : { askRef: open.ref }),
      wake: describeWake(entity.wake),
      next: describeNextRun(entity),
      todayRuns: todays.length,
      /*
        `$0.00` rather than a blank for a quiet day: the tile is a fact about
        spend, and an empty cell reads as "not measured" instead of "nothing".

        The no-runs case is spelled here rather than left to `formatRunCost`,
        which answers `$0.0000` for zero. Four decimals is right for a *run* —
        a wake routinely costs less than a cent, and `$0.00` for real work
        reads as a bug — but it is false precision about a day on which
        nothing happened. A day that did run, and cost less than a cent, still
        gets the four decimals for the original reason.
      */
      /*
        `$0.00` rather than a blank for a quiet day: the tile is a fact about
        spend, and an empty cell reads as "not measured" instead of "nothing".

        The no-runs case is spelled here rather than left to `formatRunCost`,
        which answers `$0.0000` for zero. Four decimals is right for a *run* —
        a wake routinely costs less than a cent, and `$0.00` for real work
        reads as a bug — but it is false precision about a day on which
        nothing happened. A day that did run, and cost less than a cent, still
        gets the four decimals for the original reason.

        Both conditions in one branch on purpose: `spent` is only `undefined`
        for a non-finite input, which a sum of numbers is not, so a separate
        `?? '$0.00'` would be a branch no test could ever reach.
      */
      todayCost: todays.length === 0 || spent === undefined ? '$0.00' : spent,
      ...(entity.sessionUuid === undefined
        ? {}
        : { sessionUuid: entity.sessionUuid }),
      runsSinceRotate: entity.runsSinceRotate,
      rotateAfter: entity.rotateAfter,
    };
  }, [entity, ledger, name]);
};

/**
 * The Agents tab's badge: open asks an **agent** is waiting on.
 *
 * Deliberately not `useOpenAskCount()`, which counts every open ask including
 * a session's, and deliberately not the Inbox's `useUnreadCount()`, which
 * counts notifications. Three badges, three different numbers — this one
 * answers "how many of my tenants are stuck on me?".
 *
 * Filtered here rather than in `openAsks`: that function is shared with main,
 * which has no notion of which parties are agents, and only the renderer holds
 * `agentOrder`.
 */
export const useAgentAskCount = (): number => {
  const ledger = useHiveStore((state) => state.ledger);
  const order = useHiveStore((state) => state.agentOrder);

  return useMemo(() => {
    const agents = new Set(order);

    return openAsks(ledger, Date.now()).filter((ask) => agents.has(ask.from))
      .length;
  }, [ledger, order]);
};

/**
 * One agent's side of the log — what it said, and what it was told.
 *
 * A selector rather than two `useLedgerEntries` calls merged in a component,
 * because it is a *union* and `LedgerReadQuery` cannot express one: `matches`
 * ands its fields, so `{ from, to }` would mean "from this agent AND addressed
 * to it", which is nothing.
 *
 * A broadcast from some other party is excluded on purpose. `matches` counts
 * an undirected entry as addressed to everyone, which is right for an inbox
 * and wrong for a thread — this column answers "what passed between us", and
 * an announcement to the whole hive did not.
 */
export const useAgentThread = (name: string): LedgerEntry[] => {
  const entries = useHiveStore((state) => state.ledger);

  return useMemo(
    () => entries.filter((entry) => entry.from === name || entry.to === name),
    [entries, name],
  );
};

/** The open ask one agent is waiting on — the `a71` in its row meta. */
export const useAgentAskRef = (name: string): string | undefined => {
  const ledger = useHiveStore((state) => state.ledger);

  return useMemo(
    () => openAsks(ledger, Date.now()).find((ask) => ask.from === name)?.ref,
    [ledger, name],
  );
};

/** Create a session on a project (stories 041, 044). */
export const useSpawnSession = () => useHiveStore((state) => state.spawnSession);

/** HIVE-61: main pushes the name the agent gave itself through this. */
export const useRenameSession = () =>
  useHiveStore((state) => state.renameSession);

/** Main observed a session's real branch and working directory (HIVE-78). */
export const useSetSessionBranch = () =>
  useHiveStore((state) => state.setSessionBranch);

export const useSetSessionMetrics = () =>
  useHiveStore((state) => state.setSessionMetrics);

/**
 * What a session last reported about its usage, or `undefined` (HIVE-79).
 *
 * Takes an optional id so the header's chip can call it unconditionally — a
 * hook cannot be called after an early return, and the chip returns null for
 * every tab that is not a session. `undefined` in gives `undefined` out.
 *
 * Subscribes to **one entry**, not the map, so a report about a background
 * session cannot re-render the chip showing the foreground one.
 */
export const useSessionMetrics = (id: string | undefined) =>
  useHiveStore((state) => (id === undefined ? undefined : state.metrics[id]));

/** A confirmed ticket key the user named mid-session (HIVE-78). */
export const useSetSessionTicket = () =>
  useHiveStore((state) => state.setSessionTicket);

/** `/clear`: main reports the conversation boundary through this. */
export const useClearSession = () =>
  useHiveStore((state) => state.clearSession);

/**
 * Open the selected row, or resume it when that is what it needs (HIVE-93).
 *
 * The keyboard's half of the Resume control. `openEntity` now refuses every
 * ended row, so without this a user could arrow onto a finished or restored
 * session, press Enter, and get nothing — with the only way through being a
 * mouse. That is the "unreachable from every surface at once" failure the
 * HIVE-88 comment this story deleted was written about, arriving from the
 * opposite direction.
 */
export const openOrResume = (id: string): boolean => {
  const entity = useHiveStore.getState().entities[id];
  if (
    entity !== undefined &&
    isSession(entity) &&
    isEnded(entity.status) &&
    entity.resumable === true
  ) {
    useHiveStore.getState().resumeSession(id);
    return true;
  }
  return useHiveStore.getState().openEntity(id);
};

/** Pick an ended session's conversation back up (HIVE-93). */
export const useResumeSession = () =>
  useHiveStore((state) => state.resumeSession);

/** `/done`: main reports the session's own ending through this (HIVE-93). */
export const useFinishSession = () =>
  useHiveStore((state) => state.finishSession);

/** Uncover a session whose Claude has finished starting (HIVE-101). */
export const useMarkSessionReady = () =>
  useHiveStore((state) => state.markSessionReady);

/**
 * Is this session still behind the boot cover? (HIVE-101)
 *
 * A boolean rather than the field, so a row that is not a session — or not
 * there at all — answers `false` rather than `undefined`, and so the subscriber
 * re-renders only when the answer flips rather than on every write to the
 * entity.
 */
export const useSessionBooting = (id: string): boolean =>
  useHiveStore((state) => {
    const entity = state.entities[id];
    return entity !== undefined && isSession(entity) && entity.booting === true;
  });

/**
 * Which terminal an id runs in — the id itself for anything that is not a
 * session, or a session that has never been cleared.
 *
 * A plain read rather than a hook, because its callers are inside `useMemo`
 * bodies keyed on the id list, not render paths of their own. Subscribing would
 * rebuild every transport whenever any unrelated slice changed, which is the
 * one thing `center-stage.tsx`'s cache exists to prevent.
 */
/**
 * The inverse of {@link terminalIdFor}: the row a terminal id names *now*.
 *
 * Main speaks terminal ids — they are baked into a pty's environment and never
 * change — so anything arriving from main names a terminal, not a row. After a
 * `/clear` that id belongs to the retired session, and acting on it directly
 * targets history: an OS notification clicked minutes later would refuse to
 * open (the row is ended) and drop the user on the orchestrator, instead of the
 * live session the notification was actually about.
 *
 * A plain read, like its inverse — its callers are event handlers, not render
 * paths, and a subscription would re-run them on unrelated writes.
 */
export function currentRowFor(id: string): string {
  return currentSessionIn(useHiveStore.getState(), id);
}

export function terminalIdFor(id: string): string {
  const entity = useHiveStore.getState().entities[id];
  return entity !== undefined && isSession(entity) ? terminalOf(entity) : id;
}

/** Story 096: main pushes a real session's derived status through this. */
export const useSetSessionStatus = () =>
  useHiveStore((state) => state.setSessionStatus);

/**
 * Open an entity's tab, honouring the terminated gate (story 108).
 *
 * **Every list row that navigates to a terminal uses this, not `useOpenTab`.**
 * The ui-store's action is now the low-level one: it records what is on screen
 * and asks no questions, which is right for the orchestrator tab and wrong for
 * anything that names an entity.
 */
export const useOpenEntity = () => useHiveStore((state) => state.openEntity);

/** Route a message to a session or agent (stories 041, 043). */
export const useSendToEntity = () => useHiveStore((state) => state.sendToEntity);

/** Execute a parsed console command (story 041). */
export const useRunOrchCommand = () =>
  useHiveStore((state) => state.runOrchCommand);

/*
 * `projectsOwningSessions` used to live here — every project id owning at least
 * one session, ended or not. Its only caller was the project-list merge, which
 * needed it to decide whether a seeded project had earned its place in the rail.
 * With no seeded projects there is nothing to decide, and a selector nobody
 * reads is a selector that drifts. `projectsOwningLiveSessions` below is the one
 * that survives, because the remove confirmation still has a number to state.
 */

/** Ids of projects owning a session that has not ended (story 101). */
const projectsOwningLiveSessions = (state: HiveState): string[] => {
  const ids: string[] = [];
  for (const id of state.order) {
    const entity = state.entities[id];
    if (!entity || !isSession(entity) || isEnded(entity.status)) continue;
    if (!ids.includes(entity.project)) ids.push(entity.project);
  }
  return ids;
};

/**
 * Projects that cannot be removed yet because a session is still running in
 * them (story 101; story 103 adds the confirmation that lifts this).
 *
 * A named selector rather than a component reading `state.entities` directly:
 * subscribing to the whole entity map would re-render the settings pane on
 * every status tick of every session, which is the cost the store's
 * selector-hook rule exists to prevent.
 */
export const useProjectsOwningLiveSessions = () =>
  useHiveStore(useShallow(projectsOwningLiveSessions));

/** How many still-running sessions each project owns (story 103). */
const liveSessionCounts = (state: HiveState): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const id of state.order) {
    const entity = state.entities[id];
    if (!entity || !isSession(entity) || isEnded(entity.status)) continue;
    counts[entity.project] = (counts[entity.project] ?? 0) + 1;
  }
  return counts;
};

/**
 * Live session counts per project (story 103).
 *
 * Counts rather than membership, because the remove confirmation states the
 * number out loud. {@link useProjectsOwningLiveSessions} deduplicates by
 * design — it answers "may this be removed?" — so counting its result always
 * yields 1, which is a sentence that contradicts its own plural.
 */
export const useLiveSessionCounts = () =>
  useHiveStore(useShallow(liveSessionCounts));

/**
 * The project list: the config file's, and only the config file's (story 031).
 *
 * This used to be a merge. There were five seeded projects, so the rule was
 * "config's, plus any fixture project that still owns a live session, marked
 * `demo`" — three table rows of precedence to stop the demo's sessions being
 * stranded by the first real project a user added.
 *
 * With no seeded projects there is nothing to merge and no precedence to
 * resolve: a project exists because the user mapped it. An empty config means
 * an empty list, which `projects-panel.tsx` says out loud rather than rendering
 * as a blank column.
 *
 * **Config order is the file's order and is never sorted.** Story 103's
 * drag-reorder works by rewriting that array, and the left rail reads it
 * positionally, so sorting here would silently make 103 unimplementable.
 */
export const useProjects = (): ProjectRow[] => {
  const snapshot = useSyncExternalStore(
    subscribeProjectConfig,
    projectConfigSnapshot,
    projectConfigSnapshot,
  );

  return useMemo(
    () =>
      (snapshot?.projects ?? []).map((entry) => ({
        id: entry.id,
        key: entry.key,
        name: entry.name,
        icon: entry.icon,
      })),
    [snapshot],
  );
};

/** Sessions for a project that have not ended (story 031). */
export const useProjectSessions = (projectId: string) =>
  useHiveStore(
    useShallow((state) =>
      state.order.filter((id) => {
        const entity = state.entities[id];
        return (
          entity !== undefined &&
          isSession(entity) &&
          entity.project === projectId &&
          !isEnded(entity.status)
        );
      }),
    ),
  );

/** Every work item, in fixture order (story 032). */
export const useTickets = () =>
  useHiveStore(useShallow((state) => state.tickets));

/** Where the ticket list came from, and how much to trust it (HIVE-69). */
export const useTicketSource = (): TicketSource =>
  useHiveStore((state) => state.ticketSource);

/** The refresh action, for the panel's mount effect and its retry (HIVE-69). */
export const useRefreshTickets = (): (() => Promise<void>) =>
  useHiveStore((state) => state.refreshTickets);

/** Install one re-read issue after a transition (HIVE-70). */
export const useUpdateTicket = (): ((issue: JiraIssue) => void) =>
  useHiveStore((state) => state.updateTicket);

/**
 * The five things the fleet-derived selectors below actually read off a session.
 *
 * A projection, not a summary: nothing here is for display. `branch` and
 * `project` are what a pull request is matched against, `ticket` is the reverse
 * of `Session.ticket`, and `ended` is `isEnded(status)` already applied.
 */
export interface SessionFacet {
  id: string;
  /**
   * Optional since HIVE-78, because {@link Session.branch} is.
   *
   * A session whose branch nobody has observed yet matches no pull request,
   * which is the correct answer rather than a gap: the alternative it replaces
   * matched against `feat/sess-01`, a string no PR could ever carry, so nothing
   * that worked before stops working. What changes is that the near-miss is now
   * *visible* as an absent field rather than hidden inside a plausible one.
   */
  branch: string | undefined;
  project: string;
  ticket: string | undefined;
  /** {@link isEnded}, resolved. See the note on churn in {@link selectSessionFacets}. */
  ended: boolean;
}

/**
 * The fleet, projected — and **the same array back** whenever nothing in the
 * projection changed.
 *
 * ## The problem this exists for
 *
 * `usePrs`, `useTicketPrs` and `useTicketSessions` all build fresh objects, so
 * none of them can use `useShallow` (freshly-built objects never compare equal,
 * and React loops until it bails out with "Maximum update depth exceeded" —
 * spelled out on {@link useTicketPrs}). They memoised over `entities` instead,
 * which is correct but far too broad: the entities map is replaced wholesale by
 * *any* write to *any* session, so one session's status flip re-resolved the
 * pull requests for every ticket card in the WORK panel and every row in the PR
 * panel. Thirteen live sessions made that a routine event.
 *
 * Subscribing to this instead narrows the trigger to the fields that can
 * actually change an answer. `useSyncExternalStore` requires a snapshot to be
 * referentially stable when the underlying data has not changed, and returning
 * the cached array is exactly that contract — not an optimisation on top of it.
 *
 * ## Why `ended` and not `status`
 *
 * Because a status is a five-state field and the selectors only ever ask one
 * question of it. Collapsing it here means the most frequent write in the whole
 * app — a session going `working` → `waiting` → `working` as an agent asks and
 * is answered — changes no facet at all, so the memo holds and nothing
 * downstream recomputes. Only crossing the live/ended boundary counts.
 *
 * ## Why the cache needs no reset
 *
 * It is compared by value on every call and never trusted. A `reset()` produces
 * an empty projection, which either differs from the cache and replaces it, or
 * matches it and is correctly the same empty array. There is no state in which a
 * stale entry can be returned, which is what makes a module-level cache safe for
 * a store this one is a singleton of.
 */
let facetCache: SessionFacet[] = [];

function sameFacets(
  next: readonly SessionFacet[],
  previous: readonly SessionFacet[],
): boolean {
  if (next.length !== previous.length) return false;

  return next.every((facet, index) => {
    const before = previous[index];
    return (
      facet.id === before.id &&
      facet.branch === before.branch &&
      facet.project === before.project &&
      facet.ticket === before.ticket &&
      facet.ended === before.ended
    );
  });
}

export function selectSessionFacets(state: HiveState): SessionFacet[] {
  const next: SessionFacet[] = [];

  /*
    Walked in `order` rather than over `Object.keys(entities)`, which is what
    every consumer of this used to do for itself: `order` is the array the rails
    already read positionally, so a ticket card lists its sessions in the same
    sequence the fleet table does, and a `/clear` successor inherits its
    predecessor's slot instead of jumping to the end of the card.
  */
  for (const id of state.order) {
    const entity = state.entities[id];
    if (!entity || !isSession(entity)) continue;

    next.push({
      id,
      branch: entity.branch,
      project: entity.project,
      ticket: entity.ticket,
      ended: isEnded(entity.status),
    });
  }

  if (sameFacets(next, facetCache)) return facetCache;

  facetCache = next;
  return facetCache;
}

/**
 * Every session that has *ever* been pointed at a ticket, in fleet order
 * (HIVE-73). Ended ones included — the three callers below each decide.
 *
 * The reverse of `Session.ticket`, computed rather than stored — which is what
 * makes the link immune to `hydrateTickets` replacing the whole ticket list on
 * every WORK-panel open.
 *
 * Answers **facets** rather than ids, which is what lets it be the single
 * definition of "this ticket's sessions": the card wants ids, the PR resolution
 * wants branches, and the live filter wants `ended`. Handing back ids would send
 * two of the three straight back to the fleet to look up what they were just
 * given.
 */
function facetsForTicket(
  ticketKey: string,
  fleet: readonly SessionFacet[],
): SessionFacet[] {
  return fleet.filter((session) => session.ticket === ticketKey);
}

/**
 * The subset still running — what the card's session rows list.
 *
 * **Why the rows filter and the PR resolution does not.** The two answer
 * different questions. A session row answers "who is working this ticket", so
 * an ended session is not an answer. A PR row answers "what did work on this
 * ticket produce", and a merged PR is precisely the output of a session that
 * has finished — filtering ended sessions there would empty the PR section of
 * every completed ticket, which is the opposite of what the concept shows for
 * a Done issue.
 *
 * The filter is also what keeps `/clear` from duplicating a row. `clearSession`
 * retires the old row as `done` and gives the successor the same `ticket`,
 * because the terminal is still on the same issue — so without this both would
 * list, and the card would grow by one row on every clear.
 */
function liveSessionsForTicket(
  ticketKey: string,
  fleet: readonly SessionFacet[],
): string[] {
  return facetsForTicket(ticketKey, fleet)
    .filter((session) => !session.ended)
    .map((session) => session.id);
}

/**
 * The session that owns a PR, or `null`.
 *
 * ## Two signals, and why both are needed
 *
 * **Branch** is the strong one — it is the thing GitHub and the fleet genuinely
 * share. But a branch name is not unique across repositories: cross-repo work
 * routinely uses the same name in two of them (`feat/thing` in the frontend and
 * the backend, one ticket, two PRs). Matching on branch alone would resolve a
 * backend PR to whichever session happened to come first in `order` — possibly
 * the frontend one — and clicking the card would open the wrong terminal, which
 * is worse than opening nothing.
 *
 * So **project** narrows it, but only when it can: `entity.project` is a config
 * id derived from a directory name and `repo` is GitHub's, and while they
 * usually match they are not the same namespace. Requiring equality would break
 * the link for anyone whose checkout is named differently from the repository.
 * The rule is therefore *disambiguate, do not filter*: if any candidate's
 * project matches the repository, only those candidates are considered;
 * otherwise every candidate stays, and a single unambiguous one still wins.
 *
 * ## Live beats ended
 *
 * A branch outlives the session that made it — `/clear` retires a row and opens
 * a successor on the same branch, and ended rows linger under `DONE_CAP` — so
 * the first match in `order` is frequently a corpse. Opening it would land the
 * user on a terminal that cannot be typed into, next to a PR that is very much
 * alive.
 */
function sessionForPr(
  pr: Pick<PrRecord, 'branch' | 'repo'>,
  fleet: readonly SessionFacet[],
): string | null {
  /**
   * `session.branch !== undefined` is not redundant with the equality (HIVE-78).
   *
   * `pr.branch` is always a string today, so the comparison alone would already
   * exclude an unobserved session — but the guard states the rule the *code*
   * relies on rather than borrowing it from a property of the other operand.
   * A session whose branch nobody has looked at yet owns no pull request.
   */
  const candidates = fleet.filter(
    (session) => session.branch !== undefined && session.branch === pr.branch,
  );

  const sameProject = candidates.filter(
    (session) => session.project.toLowerCase() === pr.repo.toLowerCase(),
  );
  const pool = sameProject.length > 0 ? sameProject : candidates;

  /**
   * A live match, or **nothing** — never an ended one.
   *
   * There used to be a `?? pool[0]?.id` fallback here, and it defeated both the
   * paragraph above and the type's own contract (`Pr.session` is documented as
   * `null` when no *live* session is on the branch). `openEntity` refuses ended
   * sessions outright — it calls `backToOrch()` and returns `false` — so
   * handing back a corpse did not open a terminal, it bounced the user to the
   * orchestrator and swallowed the click.
   *
   * Worse, it did that in the **common** case rather than an exotic one: the
   * panel deliberately keeps PRs merged in the last 24 hours, and those are
   * exactly the branches whose sessions have finished or been retired by
   * `/clear`. Returning `null` restores what both surfaces already do with it —
   * open the PR on GitHub, as a real link that middle-click works on.
   */
  return pool.find((session) => !session.ended)?.id ?? null;
}

/**
 * The pull request a session owns, or `null` — {@link sessionForPr} run
 * backwards (HIVE-100).
 *
 * The fleet table's `PR` column read `Session.pr` from the day it was drawn,
 * and `Session.pr` has never been written by anything. Every row therefore
 * showed `—` forever, which is indistinguishable from "this branch has no pull
 * request" and so never looked like a bug. The work panel hit the identical
 * wall and fixed it the same way (`resolveTicketPrs`): resolve from the live
 * list at render, because a branch's PR is a fact about GitHub, not about the
 * session — it can be opened, approved or merged between two sweeps, and a
 * value frozen onto the row at spawn time would be wrong within the hour.
 *
 * ## The same two signals, and the same disambiguation
 *
 * Branch is the strong match; repository breaks the cross-repo tie, where one
 * branch name carries a frontend PR and a backend one. The rule is
 * {@link sessionForPr}'s exactly — *disambiguate, do not filter* — because
 * `project` is a config id from a directory name and `repo` is GitHub's, and
 * requiring equality would blank the column for anyone whose checkout is named
 * differently from the repository.
 *
 * ## Why the newest live PR wins
 *
 * A branch can carry more than one record here. The panel keeps PRs merged in
 * the last 24 hours, so a branch that just landed and was immediately reused
 * has both — and the merged one is the answer nobody wants in a *fleet* table,
 * whose subject is the work in front of you. Alive therefore beats merged, and
 * `updatedAt` breaks the remaining tie: descending ISO 8601 sorts
 * lexicographically, so the comparison needs no parse.
 */
export function resolveSessionPr(
  branch: string | undefined,
  project: string | undefined,
  prs: readonly PrRecord[],
  /**
   * The PR this session was last seen to own, if the live list cannot answer.
   *
   * Consulted **only** when the branch match finds nothing, never as a tie
   * break, because a live record is strictly better information: it is current,
   * it carries a state, and it is about the branch the session is on *now*.
   *
   * It is offered without a state, which is what marks the answer as a memory —
   * see {@link SessionPr.state}. It is what fills the column for the ordinary
   * case the live match cannot reach: a session that raised a PR, saw it merged
   * more than a day ago, and has since had its worktree torn down so its branch
   * reads `main` again.
   */
  remembered?: Session['lastPr'],
): SessionPr | null {
  const fallback: SessionPr | null =
    remembered === undefined
      ? null
      : { n: remembered.number, url: remembered.url };

  /*
    An unobserved branch matches nothing — the same guard `sessionForPr` states
    for the same reason (HIVE-78). The empty string is excluded too: it is what
    `branchLabel` already treats as absent, and a `''` here would be a value
    that compares equal to nothing while looking like it could.

    An unobserved branch falls through to the memory rather than to `null`: a
    row whose branch nobody ever read is exactly the row that most needs one.
  */
  if (branch === undefined || branch === '') return fallback;

  const candidates = prs.filter((pr) => pr.branch === branch);
  if (candidates.length === 0) return fallback;

  const sameProject =
    project === undefined
      ? []
      : candidates.filter(
          (pr) => pr.repo.toLowerCase() === project.toLowerCase(),
        );
  const pool = sameProject.length > 0 ? sameProject : candidates;

  const best = pool.reduce((winner, pr) => {
    const winnerLanded = winner.state === 'merged';
    const prLanded = pr.state === 'merged';
    if (winnerLanded !== prLanded) return winnerLanded ? pr : winner;
    return pr.updatedAt > winner.updatedAt ? pr : winner;
  });

  return { n: best.number, state: best.state, url: best.url };
}

/**
 * What a sweep just taught the fleet — one entry per session whose pull
 * request has *changed*, and nothing for the rest.
 *
 * Pure, and separate from applying it, because the two halves go to different
 * places: the entities patch belongs inside `set`, and the IPC belongs outside
 * it. Computing the list once and handing it to both is what keeps them from
 * disagreeing about which rows were touched.
 *
 * ## Why every session, live or ended
 *
 * The row that most needs remembering is the one that has just finished: a
 * session raises its PR near the end of its life, and the sweep that first sees
 * that PR usually lands *after* the session is over. Skipping ended rows would
 * miss precisely the case this exists for.
 *
 * ## Why only when it changes
 *
 * The poller runs once a minute for as long as the app is open. Writing on
 * every tick would be a store write, a re-render and an IPC round trip per
 * session per minute, all of it re-recording the same number. Comparing against
 * what the entity already holds makes a settled fleet free.
 *
 * Note that this only ever *adds* knowledge. A PR that drops out of the sweep —
 * merged more than a day ago, say — leaves the memory alone rather than
 * clearing it, which is the whole point: the memory outliving the live record
 * is the feature.
 */
function learnSessionPrs(
  state: HiveState,
  prs: readonly PrRecord[],
): SessionPrRequest[] {
  const learned: SessionPrRequest[] = [];

  for (const id of state.order) {
    const entity = state.entities[id];
    if (!entity || !isSession(entity)) continue;

    /*
      Resolved without the fallback: this is asking what the *live* list says,
      and passing the memory in would make a row that already has one resolve
      to itself and compare equal forever — correct, but only by accident.
    */
    const live = resolveSessionPr(entity.branch, entity.project, prs);
    if (live === null) continue;

    const known = entity.lastPr;
    if (known?.number === live.n && known.url === live.url) continue;

    /*
      **GitHub's repository name, not the project id**, which is what
      `SessionPrRecord.repo` says it holds. The two are allowed to differ —
      `resolveSessionPr` *disambiguates* on repo rather than filtering on it, so
      a checkout named differently from its GitHub repository still resolves —
      and recording `entity.project` here would quietly file the wrong one under
      a field documented as the other.

      Found by identity rather than re-resolved: `live` came out of `prs`, so
      the record behind it is in there, and matching it back is exact where a
      second pass through the resolution rules would be a second copy of them.
      The lookup cannot miss; `continue` states that rather than reaching for a
      fallback that would reintroduce exactly the wrong value.
    */
    const record = prs.find((pr) => pr.number === live.n && pr.url === live.url);
    if (record === undefined) continue;

    learned.push({
      entityId: id,
      pr: { number: live.n, repo: record.repo, url: live.url },
    });
  }

  return learned;
}

/**
 * Apply {@link learnSessionPrs}'s answer to the entities map.
 *
 * Returns **the same map** when there is nothing to apply, which is what lets
 * `hydratePrs` leave `entities` out of its patch entirely on a quiet tick. A
 * fresh object here would be a new identity for every entity subscriber in the
 * app, once a minute, to say nothing had changed.
 */
function rememberSessionPrs(
  entities: Record<string, Entity>,
  learned: readonly SessionPrRequest[],
): Record<string, Entity> {
  if (learned.length === 0) return entities;

  const next = { ...entities };
  for (const note of learned) {
    const entity = next[note.entityId];
    if (!entity || !isSession(entity)) continue;
    next[note.entityId] = { ...entity, lastPr: note.pr };
  }
  return next;
}

/**
 * PRs reachable from a Jira ticket (story 032, rebuilt for live data).
 *
 * ## Why this stopped reading `Session.pr`
 *
 * It used to walk the ticket's sessions and read a `pr` field off each one.
 * Nothing has ever written that field, so the section was permanently empty —
 * the fixtures made it look otherwise. The live list is the single source of
 * truth for state and findings, so the resolution now runs the other way: find
 * the PRs, then work out which session owns each.
 *
 * ## Two matches, in this order
 *
 * 1. **By branch** — a PR whose head branch is one of the ticket's sessions'
 *    branches. This is the strong link: the session was started for the ticket,
 *    and the branch is the thing GitHub and the fleet genuinely share.
 * 2. **By key** — a PR whose branch or title contains the ticket key. This
 *    catches the two cases the first misses: a PR raised outside the app, and
 *    one whose session has ended and aged out of the fleet. It is a text match
 *    and it is deliberately narrow — the key is bounded by non-word characters
 *    so `HIVE-7` cannot claim `HIVE-73`'s pull request.
 *
 * No dedupe. Each record is visited once and `prs` holds no duplicates, so a PR
 * that satisfies both rules is still encountered exactly once — a guard keyed on
 * the number would never fire, and would actively *drop* the case it looks like
 * it protects: a frontend #42 and a backend #42 on one ticket are two pull
 * requests, and both belong on the card.
 */
export function resolveTicketPrs(
  ticketKey: string,
  tickets: Ticket[],
  fleet: readonly SessionFacet[],
  prs: PrRecord[],
): TicketPr[] {
  const ticket = tickets.find((t) => t.key === ticketKey);
  if (!ticket) return [];

  /**
   * The branches this ticket's sessions are working on.
   *
   * Unobserved sessions are dropped rather than contributing `undefined`
   * (HIVE-78) — a set containing it would match nothing anyway, and letting it
   * in would leave the membership test below reading as though it might.
   */
  const branches = new Set<string>(
    facetsForTicket(ticketKey, fleet)
      .map((session) => session.branch)
      .filter((branch): branch is string => branch !== undefined),
  );

  /*
    Escaped, then bounded by non-word characters on both sides. A Jira key is
    `ABC-123` — the hyphen is the only regex-significant character in practice,
    but building the pattern from an escaped copy means a project key with a dot
    in it cannot turn into a wildcard.
  */
  const escaped = ticketKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentionsKey = new RegExp(`(?:^|\\W)${escaped}(?:\\W|$)`, 'i');

  const resolved: TicketPr[] = [];

  for (const pr of prs) {
    const matched =
      branches.has(pr.branch) ||
      mentionsKey.test(pr.branch) ||
      mentionsKey.test(pr.title);
    if (!matched) continue;

    resolved.push({
      n: pr.number,
      repo: pr.repo,
      state: pr.state,
      findings: pr.findings,
      url: pr.url,
      session: sessionForPr(pr, fleet),
    });
  }

  return resolved;
}

/**
 * Subscribes to the three store slices the resolution reads and memoises the
 * result.
 *
 * **Not `useShallow`.** This selector builds new objects rather than handing
 * back store-owned ones, and `useShallow` compares an array's *elements* by
 * identity — freshly-built objects never match, so every render would produce a
 * new snapshot and React would loop until it bails out with "Maximum update
 * depth exceeded". Subscribing to stable slices and memoising over them is what
 * keeps the identity stable between renders.
 *
 * The fleet arrives as {@link selectSessionFacets} rather than as `order` plus
 * `entities`, which is what makes "stable" true in practice as well as in
 * principle: the entities map is a new object after any write to any session, so
 * memoising over it re-resolved every ticket card in the panel whenever one
 * session anywhere changed status.
 */
export const useTicketPrs = (ticketKey: string): TicketPr[] => {
  const tickets = useHiveStore((state) => state.tickets);
  const fleet = useHiveStore(selectSessionFacets);
  const prs = useHiveStore((state) => state.prs);

  return useMemo(
    () => resolveTicketPrs(ticketKey, tickets, fleet, prs),
    [ticketKey, tickets, fleet, prs],
  );
};

/**
 * The sessions working a ticket (HIVE-73) — the card's session rows.
 *
 * Memoised over the fleet facets for the same reason `useTicketPrs` is: the
 * result is a freshly-built array, so a plain selector would hand React a new
 * identity on every store write and re-render every card in the panel whenever
 * any session anywhere changed.
 */
export const useTicketSessions = (ticketKey: string): string[] => {
  const fleet = useHiveStore(selectSessionFacets);

  return useMemo(
    () => liveSessionsForTicket(ticketKey, fleet),
    [ticketKey, fleet],
  );
};

/**
 * One ticket by key, or `undefined` (HIVE-73).
 *
 * The picker needs the title of the ticket it was opened for, and it cannot
 * reach into the WORK slice to get it — `features/sessions` and `features/work`
 * are fenced from each other. The store is the seam they share.
 */
export const useTicket = (ticketKey: string | null): Ticket | undefined =>
  useHiveStore((state) =>
    ticketKey === null
      ? undefined
      : state.tickets.find((ticket) => ticket.key === ticketKey),
  );

/**
 * How many work items exist — the left rail's Work tab badge (story 030).
 *
 * Counts every ticket, Done ones included, matching the concept. The badge
 * answers "how much work is tracked here", not "how much is outstanding".
 */
export const useTicketCount = () =>
  useHiveStore((state) => state.tickets.length);

/** Inbox unread count (stories 050, 021). */
export const useUnreadCount = () =>
  useHiveStore((state) => state.notifs.filter((notif) => notif.unread).length);

/** Clear the whole inbox — the header bell (021) and the inbox panel (051). */
export const useMarkAllRead = () => useHiveStore((state) => state.markAllRead);

/** The inbox, newest first (story 051). */
export const useNotifs = () => useHiveStore((state) => state.notifs);

/** Hydration and the push subscription — see `use-ledger-sync.ts`. */
export const useHydrateLedger = () => useHiveStore((state) => state.hydrateLedger);

/** Mirror `~/.hive/agents` into the fleet (HIVE-114). */
export const useHydrateAgents = () => useHiveStore((state) => state.hydrateAgents);
export const useLedgerAppend = () => useHiveStore((state) => state.ledgerAppend);

/** A run started, ended, or changed an agent's status (HIVE-115). */
export const useSetAgentStatus = () => useHiveStore((state) => state.setAgentStatus);

/** Run-log lines, as the process writes them (HIVE-115). */
export const useAppendAgentLines = () =>
  useHiveStore((state) => state.appendAgentLines);

/**
 * The ledger tail, optionally filtered.
 *
 * Memoised over the raw slice rather than wrapped in `useShallow`, for the
 * reason spelled out on {@link usePrs}: this builds a new array, and shallow-
 * comparing a freshly-built one never matches. Callers passing a `filter` must
 * hand over a stable object — an inline literal defeats the memo.
 */
export const useLedgerEntries = (filter?: LedgerReadQuery): LedgerEntry[] => {
  const entries = useHiveStore((state) => state.ledger);

  return useMemo(
    () => (filter === undefined ? entries : entries.filter((entry) => matches(entry, filter))),
    [entries, filter],
  );
};

/**
 * Asks nobody has answered.
 *
 * `Date.now()` is read inside the memo, so `ageMs` is as fresh as the last
 * entry rather than as fresh as the last render. That is the right trade here:
 * the TTL is a day, and re-deriving on every tick to keep a minutes-old age
 * exact would re-render the inbox for nothing.
 */
export const useOpenAsks = (): OpenAsk[] => {
  const entries = useHiveStore((state) => state.ledger);

  return useMemo(() => openAsks(entries, Date.now()), [entries]);
};

/** The badge. A number, so it needs no memo and no shallow compare. */
export const useOpenAskCount = (): number =>
  useHiveStore((state) => openAsks(state.ledger, Date.now()).length);

/** One conversation: the ask, and everything that named it. */
export const useThread = (id: string): LedgerEntry[] => {
  const entries = useHiveStore((state) => state.ledger);

  return useMemo(() => thread(entries, id), [entries, id]);
};

/**
 * Every PR the panel shows, with its owning session resolved (story 052).
 *
 * The match is made **here, on every render of the panel**, rather than stored
 * on the record when it arrives. A PR's branch is fixed; which session is on
 * that branch is not — one can be started, cleared or killed between two
 * sweeps, and a session id frozen at read time would send the user to a
 * terminal that is no longer there.
 *
 * Memoised over the three stable slices rather than wrapped in `useShallow`,
 * for the reason spelled out on {@link useTicketPrs}: this builds new objects,
 * and shallow-comparing freshly-built objects never matches.
 */
/**
 * `PrRecord` → `Pr`: everything main sent, plus the session that owns it.
 *
 * **Resolved, never stored** — see `Pr.session`. Shared by the sweep and the
 * search so a card behaves identically whichever list it came from.
 */
const resolvePrs = (
  records: readonly PrRecord[],
  fleet: ReturnType<typeof selectSessionFacets>,
): Pr[] =>
  records.map((pr) => ({
    n: pr.number,
    repo: pr.repo,
    title: pr.title,
    state: pr.state,
    findings: pr.findings,
    checks: pr.checks,
    url: pr.url,
    branch: pr.branch,
    session: sessionForPr(pr, fleet),
  }));

export const usePrs = (): Pr[] => {
  const prs = useHiveStore((state) => state.prs);
  const fleet = useHiveStore(selectSessionFacets);

  return useMemo(() => resolvePrs(prs, fleet), [prs, fleet]);
};

/**
 * The **searched** pull requests, resolved the same way.
 *
 * A search result is a `PrRecord` like any other, so it earns its owning
 * session by the same branch match — a search that turns up a PR the fleet is
 * working on should open that terminal, exactly as the sweep's rows do. Sharing
 * `resolvePrs` is what guarantees the two lists cannot start disagreeing about
 * what a card offers.
 *
 * `null` while nothing has been searched, which is how the panel tells "no
 * results" from "no search".
 */
export const usePrSearchResults = (): Pr[] | null => {
  const results = useHiveStore((state) => state.prSearch.results);
  const fleet = useHiveStore(selectSessionFacets);

  return useMemo(
    () => (results === null ? null : resolvePrs(results, fleet)),
    [results, fleet],
  );
};

/**
 * One row's pull request, resolved from the live list (HIVE-100).
 *
 * Takes an id rather than a branch so it can be called before the caller has
 * narrowed its entity: the fleet row bails out on a missing or non-session
 * entity, and a hook cannot sit behind that guard. The two subscriptions it
 * costs are the two the row already holds — `useEntity(id)` reads the same
 * slot — so this adds a `prs` subscription and nothing else.
 *
 * Memoised over `branch` and `project` rather than over the entity, for the
 * reason {@link usePrs} gives about freshly-built objects: those two strings are
 * the entire input, and every other field on a session changes far more often
 * than they do. A status flip therefore re-renders the row without re-resolving
 * its PR.
 */
export const useSessionPr = (id: string): SessionPr | null => {
  const prs = useHiveStore((state) => state.prs);
  const entity = useHiveStore((state) => state.entities[id]);

  const session = entity !== undefined && isSession(entity) ? entity : undefined;
  const branch = session?.branch;
  const project = session?.project;
  /*
    A third memo input, and it changes about as often as the other two: it is
    written once per session by the sweep that first resolves a PR for it, and
    then never again unless the answer genuinely changes.
  */
  const remembered = session?.lastPr;

  return useMemo(
    () => resolveSessionPr(branch, project, prs, remembered),
    [branch, project, prs, remembered],
  );
};

/** Where the PR list came from, and how much to trust it. */
export const usePrSource = () => useHiveStore((state) => state.prSource);

/** Sweep GitHub. The poller's entry point — see `hooks/use-pr-refresh.ts`. */
export const useRefreshPrs = () => useHiveStore((state) => state.refreshPrs);

/** What the PRs panel's search found, and whether it is still looking. */
export const usePrSearch = () => useHiveStore((state) => state.prSearch);
export const useSearchPrs = () => useHiveStore((state) => state.searchPrs);
export const useClearPrSearchResults = () =>
  useHiveStore((state) => state.clearPrSearch);


/** Mark one notification read, by its id (story 051, HIVE-75). */
export const useMarkRead = () => useHiveStore((state) => state.markRead);

/** Remove a notification the user has acted on (HIVE-93). */
export const useDismissNotif = () =>
  useHiveStore((state) => state.dismissNotif);

/** Empty the inbox — the panel's Clear all. */
export const useClearNotifs = () => useHiveStore((state) => state.clearNotifs);

/** Push a notification — the stream's entry point (stories 051, 061, HIVE-75). */
export const usePushNotif = () => useHiveStore((state) => state.pushNotif);

/** Install main's buffer on mount (HIVE-75). */
export const useHydrateNotifs = () =>
  useHiveStore((state) => state.hydrateNotifs);

/** Apply read-state the hub decided — see `use-notification-stream` (HIVE-75). */
export const useApplyRead = () => useHiveStore((state) => state.applyRead);

/** Apply a dismissal main decided on its own — see `use-notification-stream` (HIVE-81). */
export const useApplyDismiss = () =>
  useHiveStore((state) => state.applyDismiss);

/** The entity behind `activeTab`, or null for the orchestrator. */
export const useActiveEntity = () => {
  const activeTab = useUiStore((state) => state.activeTab);
  return useHiveStore((state) =>
    activeTab === 'orch' ? null : (state.entities[activeTab] ?? null),
  );
};
