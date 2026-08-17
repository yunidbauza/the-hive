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
  isEnded,
  isSession,
  resolveEntityRef,
  terminalOf,
} from '@/types/entity';
import type { HiveNotification } from '@/types/notification';
import type { Pr, TicketPr } from '@/types/pull-request';
import type { TermLine } from '@/types/terminal';
import type { Ticket } from '@/types/ticket';


import { isDesktop } from '@config/runtime';
import { reset as resetClock } from '@lib/fake-clock';
import { readPullRequests } from '@lib/github';
import { readJiraStatus, searchJiraIssues } from '@lib/jira';
import {
  projectConfigSnapshot,
  subscribeProjectConfig,
} from '@lib/project-config';
import { pickPhrase } from '@lib/swarm/phrases';
import { requestSpawn } from '@lib/terminal/pty-transport';
import { sendToSession } from '@lib/terminal/session-input';
import type { PrRecord } from '@shared/github-contract';
import type { JiraIssue } from '@shared/jira-contract';
import type { SessionMetrics } from '@shared/metrics-contract';
import { NOTIFICATION_CAP } from '@shared/notification-contract';
import { currentTheme } from '@stores/appearance-store';
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

  spawnSession: (
    repo: string,
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
   * Apply read-state the hub decided, without writing it back (HIVE-75).
   *
   * Separate from {@link markRead} precisely because it must **not** write
   * through: this is the echo of a decision main already made — most often the
   * user clicking a desktop toast, which the renderer cannot observe any other
   * way.
   */
  applyRead: (id: string | null) => void;
  appendEntityLines: (
    id: string,
    lines: TermLine[],
    status?: SessionStatus,
  ) => void;
  setSessionStatus: (id: string, status: SessionStatus) => void;
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
   * The user named the ticket this session is for, in prose (HIVE-78).
   *
   * Associates the session and pins its name to the key. The key must already
   * have been confirmed against Jira; this action does not check.
   */
  setSessionTicket: (id: string, ticket: string) => void;
  /**
   * `/clear` ended this session's conversation; its terminal kept running.
   *
   * Retires the row as `done` and opens a successor on the same terminal.
   * Answers the successor's id, or `null` if there was nothing to retire.
   */
  clearSession: (id: string) => string | null;
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

/** The `help` output — one row per command in the grammar. */
const HELP_LINES = [
  '  help                       show this list',
  '  status                     one line per session',
  '  open <session>             open a session in the center stage',
  '  send <session> <message>   route a message to a session',
  '  spawn <repo> <task>        start a new session on a project',
  '  clear                      empty this transcript',
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

export const useHiveStore = create<HiveState>()((set, get) => ({
  ...emptySeeds(),
  notifs: [],
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

  /**
   * Create a session and open its tab.
   *
   * Actions that span both stores call the other store's action explicitly —
   * no store subscribes to the other. That keeps the dependency one-way and
   * makes the cross-store effect visible at the call site.
   */
  spawnSession: (repo, task, model, effort, ticket) => {
    const id = nextSessionId(get().entities);
    // Resolved once: the seed transcript quotes them back, so a default applied
    // in two places could print one model and record another.
    const resolvedModel = model ?? 'opus';
    const resolvedEffort = effort ?? 'high';

    /**
     * A session started from a ticket card is called after its issue (HIVE-78).
     *
     * Resolved here rather than in the picker because collision-avoidance needs
     * to see the whole fleet, and the store is what holds it. The name goes two
     * places from here — onto the entity, and onto the command line as
     * `--name` — so the row and the agent agree from the first frame instead of
     * the row saying `HIVE-73` while the agent's prompt box says `sess-07`.
     */
    const name = ticket
      ? ticketSessionName(ticket, get().entities)
      : undefined;

    const session: Session = {
      kind: 'session',
      id,
      project: repo,
      /**
       * Only present when the picker was opened from a ticket card, which is
       * why it is spread conditionally rather than assigned `undefined`: an
       * explicit `ticket: undefined` key is a different object shape from an
       * absent one, and the store's snapshots are compared in tests.
       */
      ...(ticket ? { ticket } : {}),
      /**
       * Named up front only when a ticket said what to call it. Spread for the
       * same reason `ticket` is: an explicit `name: undefined` is a different
       * object shape from an absent key, and these snapshots are compared.
       */
      ...(name === undefined ? {} : { name }),
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
      pr: null,
      cost: '$0.02',
      model: resolvedModel,
      effort: resolvedEffort,
      lines: [
        line(
          `❯ claude --model ${resolvedModel} --effort ${resolvedEffort} — new session on ${repo}`,
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
     * The console records every spawn, whoever asked for it — the `spawn`
     * command, the picker (044), or a future daemon event. Logging here rather
     * than at each call site is what keeps the transcript complete.
     */
    set((state) => ({
      orchLines: capLines([
        ...state.orchLines,
        line(`  spawned ${id} on ${repo}`, 'dim'),
      ]),
    }));

    /**
     * Ask for the process **here**, not when a surface mounts (story 097).
     *
     * The lazy path works — `PtyTransport` requests a spawn on subscribe — but
     * its refusal reaches only the terminal, asynchronously, and only if a
     * surface mounted at all. The console has to print main's exact message,
     * so the request is made where the transcript is. That is the same
     * argument that already puts the `spawned …` line above here rather than
     * at each call site, and it means the picker (044) gets the refusal too.
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
      void requestSpawn(id, repo, {
        ...(task === undefined ? {} : { task }),
        model: resolvedModel,
        effort: resolvedEffort,
        /**
         * Sent only when a ticket named it (HIVE-78). Omitted otherwise, so
         * main falls back to the entity id and the command line is exactly the
         * one HIVE-61 shipped.
         */
        ...(name === undefined ? {} : { name }),
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
        theme: currentTheme(),
      }).then((outcome) => {
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
    const entity = get().entities[id];
    if (!(entity !== undefined && isSession(entity) && isEnded(entity.status))) {
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
            `  ${entityLabel(entity).padEnd(16)}${STATUS_WORD[entity.status].padEnd(13)}${entity.project} · ${branchLabel(entity)}`,
            STATUS_COLOR[entity.status],
          );
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

      case 'spawn': {
        /**
         * The config decides what exists, exactly as the rail and picker do.
         *
         * This read `state.projects` — the store's own slice — which worked
         * only because that slice was seeded with five demo projects at boot.
         * Emptying the seed left it always empty, so every `spawn` answered
         * "unknown repo" for projects sitting right there in the Projects
         * panel. One source for "which projects exist", and it is the config.
         *
         * **On desktop, no snapshot means permissive, not empty.** `main.tsx`
         * fires `loadProjectConfig()` without awaiting, and `project-config.ts`
         * leaves the snapshot `null` when that read throws — deliberately, so a
         * broken IPC hop degrades rather than locks the app. Treating `null` as
         * "no projects" would make this verb refuse every repo during the first
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
        const known =
          (snapshot === null && isDesktop()) ||
          (snapshot?.projects.some((project) => project.id === command.repo) ??
            false);
        if (!known) {
          pushOrch(
            `  unknown repo: ${command.repo} — try one from the Projects panel`,
            'red',
          );
          return;
        }
        // No confirmation line here: `spawnSession` writes it, so both this
        // command and the picker log exactly once.
        get().spawnSession(command.repo, command.task);
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

  applyRead: (id) =>
    set((state) => ({
      notifs:
        id === null
          ? state.notifs.map((notif) => ({ ...notif, unread: false }))
          : state.notifs.map((notif) =>
              notif.id === id ? { ...notif, unread: false } : notif,
            ),
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
   */
  setSessionStatus: (id, status) =>
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
      if (!entity || !isSession(entity) || entity.status === status) return state;
      return {
        entities: { ...state.entities, [target]: { ...entity, status } },
      };
    }),

  /**
   * The agent reported a new display name (HIVE-61).
   *
   * The same shape and the same guards as `setSessionStatus`, and for the same
   * reasons: agents are ignored rather than rejected, and an unchanged value is
   * dropped so a session repeating its title — which Claude does on every
   * repaint — cannot produce a store write, and a re-render, per repaint.
   *
   * The name is **not** validated against the pattern `--name` is filtered by.
   * That pattern governs what the app is willing to put on a command line; this
   * value came off a terminal title and is only ever rendered, so restricting it
   * would reject the perfectly good "fix the login bug" a user just typed into
   * `/rename`.
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
       * A pinned name outranks the agent's (HIVE-78).
       *
       * The app pinned it because the user said which ticket they were working
       * on, and Claude has no idea that happened — it goes on repainting
       * `✳ sess-03` several times a second. Without this the rename would be
       * visible for about one frame.
       *
       * Checked before the stale-title guard because it subsumes it: while
       * pinned, *every* title is refused, whatever its provenance.
       */
      if (entity.namePinned === true) return state;

      /**
       * Refuse the title the finished conversation left in the terminal.
       *
       * Suppressed until a *different* name arrives, not merely once: Claude
       * repaints the title continuously, so the stale value comes back many
       * times a second and a one-shot guard would let the second one through.
       * Anything else means the agent has genuinely renamed itself, and the
       * terminal stops being suspect from then on.
       */
      const terminal = terminalOf(entity);
      const stale = staleTitles.get(terminal);
      if (stale === name) return state;
      if (stale !== undefined) staleTitles.delete(terminal);

      if (entity.name === name) return state;
      return {
        entities: { ...state.entities, [target]: { ...entity, name } },
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
   * ## Why it pins the name
   *
   * Associating without renaming would leave a row called `sess-03` sitting on
   * the `ABC-123` card, which is the association the user asked for and none of
   * the recognition. Pinning is what makes the new name survive Claude's next
   * title repaint — see {@link Session.namePinned}.
   *
   * ## Why it refuses a session that already has a ticket
   *
   * A session moved between tickets mid-conversation is a claim about work that
   * has already happened in it, and the row would carry a name that does not
   * describe most of its own transcript. A user who genuinely wants that has a
   * better tool: `/clear`, which retires the row and opens a fresh one.
   */
  setSessionTicket: (id, ticket) =>
    set((state) => {
      const target = currentSessionIn(state, id);
      const entity = state.entities[target];
      if (!entity || !isSession(entity)) return state;
      if (entity.ticket !== undefined) return state;
      // An ended row is history; naming it now would rewrite the record.
      if (isEnded(entity.status)) return state;

      const name = ticketSessionName(ticket, state.entities);

      return {
        entities: {
          ...state.entities,
          [target]: { ...entity, ticket, name, namePinned: true },
        },
        orchLines: capLines([
          ...state.orchLines,
          line(`  ${target} is working ${ticket} — renamed ${name}`, 'dim'),
        ]),
      };
    }),

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
      pr: null,
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
      const retired: Session = { ...current, status: 'done' };
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
       * Drop the oldest `done` rows past the cap.
       *
       * Oldest by position in `order`, which is spawn order — the same
       * definition of "oldest" every other capped list in this store uses.
       * Their entities go with them; an entity nothing lists is a leak.
       */
      const doneIds = order.filter((entityId) => {
        const entity = entities[entityId];
        return entity !== undefined && isSession(entity) && entity.status === 'done';
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
        line(`  ▸ ${successorId} started in the same terminal`, 'dim'),
      ]),
    }));

    return successorId;
  },

  /**
   * Install real issues (HIVE-69).
   *
   * Wholesale replacement, and that is safe now in a way it would not have been
   * while tickets carried a `sessions` array: the ticket→session link lives on
   * `Session.ticket`, which this never touches. A user can refresh the WORK
   * panel as often as they like and the sessions on every card survive it,
   * because they were never stored on the card in the first place (HIVE-73).
   */
  hydrateTickets: (issues, capped) =>
    set({
      tickets: issues.map((issue) => ({
        key: issue.key,
        status: issue.status,
        statusCategory: issue.statusCategory,
        title: issue.summary,
        url: issue.url,
      })),
      ticketSource: { kind: 'live', stale: false, capped },
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
   */
  reportTicketFailure: (message) =>
    set((state) => {
      if (state.ticketSource.kind === 'live') {
        return {
          ticketSource: { ...state.ticketSource, stale: true },
        };
      }
      return { ticketSource: { kind: 'failed', message } };
    }),

  reportTicketsUnconfigured: () =>
    set({ tickets: [], ticketSource: { kind: 'unconfigured' } }),

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
     * Announce the read — but only when there is nothing on screen to announce
     * it *over*.
     *
     * A refresh with tickets already listed keeps them listed. Blanking a good
     * list to a skeleton on every reopen would be the original bug wearing the
     * opposite mask: content the user was reading, replaced by a placeholder,
     * for the duration of a network round trip.
     *
     * It is also what keeps `reportTicketFailure` able to do its job. That
     * action marks a *live* list stale rather than discarding it, and it decides
     * by reading the source it is replacing — so moving an already-live source
     * to `loading` here would turn every "could not reach Jira, these may be out
     * of date" into a bare failure with the tickets thrown away.
     *
     * Keyed on the *source*, not on `tickets.length`. A successful read that
     * matched nothing is `live` with an empty array, and the panel says "No
     * issues matched your query." — a real answer. Counting rows would treat
     * that answer as "nothing yet" and replace it with three pulsing
     * placeholders on every reopen, which is the same content-for-placeholder
     * swap the paragraph above rejects.
     */
    if (get().ticketSource.kind !== 'live') {
      set({ ticketSource: { kind: 'loading' } });
    }

    const status = await readJiraStatus();
    if (status === null) {
      get().reportTicketFailure('The app could not reach its own main process.');
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
     * reading a setting, holding it, and racing a hand-edit of the file — for a
     * value main has in front of it anyway.
     */
    const result = await searchJiraIssues();
    if (result === null) {
      get().reportTicketFailure('The app could not reach its own main process.');
      return;
    }
    if (!result.ok) {
      get().reportTicketFailure(result.error.message);
      return;
    }
    get().hydrateTickets(result.value.issues, result.value.capped);
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
  hydratePrs: (prs, repos) =>
    set((state) => {
      const source = state.prSource;
      const settled =
        source.kind === 'live' && !source.stale && source.repos === repos;

      return {
        prs: samePrs(prs, state.prs) ? state.prs : prs,
        prSource: settled ? source : { kind: 'live', stale: false, repos },
      };
    }),

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

  reset: () => {
    spawnCounter = 0;
    staleTitles.clear();
    // A sweep from the previous state must not install its answer into the new
    // one — dropping the handle makes the next caller start fresh.
    inFlightPrSweep = null;
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
      metrics: {},
      ticketSource: { kind: 'loading' },
      prSource: { kind: 'loading' },
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
        if (entity && isSession(entity)) counts[entity.status] += 1;
      }
      return counts;
    }),
  );

/** Active sessions first, then ended ones — the keyboard nav order (041, 060). */
export const useNavOrder = () =>
  useHiveStore(
    useShallow((state) => {
      const active: string[] = [];
      const ended: string[] = [];
      for (const id of state.order) {
        const entity = state.entities[id];
        if (!entity || !isSession(entity)) continue;
        (isEnded(entity.status) ? ended : active).push(id);
      }
      return [...active, ...ended];
    }),
  );

/**
 * Sessions either side of the orchestrator table's COMPLETED divider (041).
 *
 * Two flat selectors rather than one returning `{ active, done }`. `useShallow`
 * compares the *returned value's* own properties, so an object of two freshly
 * built arrays is never shallow-equal to the last one — the component
 * re-renders, rebuilds the arrays, and loops until React gives up. Flat arrays
 * are compared element by element, which is what makes them stable.
 *
 * Derived here rather than in the component so they stay consistent with
 * `useNavOrder()`, which flattens the same partition into the keyboard order.
 */
const isActiveSession = (entity: Entity | undefined) =>
  entity !== undefined && isSession(entity) && !isEnded(entity.status);

export const useActiveSessions = () =>
  useHiveStore(
    useShallow((state) =>
      state.order.filter((id) => isActiveSession(state.entities[id])),
    ),
  );

/**
 * The other side of the divider: finished *and* terminated (story 108).
 *
 * One group rather than two, because the divider answers "is this still going?"
 * and both answers are no. The row itself says which kind of ended it is, which
 * is where that distinction is actually useful.
 */
export const useEndedSessions = () =>
  useHiveStore(
    useShallow((state) =>
      state.order.filter((id) => {
        const entity = state.entities[id];
        return (
          entity !== undefined && isSession(entity) && isEnded(entity.status)
        );
      }),
    ),
  );

/** The long-lived background agents, in fixture order (story 033). */
export const useAgentOrder = () =>
  useHiveStore(useShallow((state) => state.agentOrder));

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
export const usePrs = (): Pr[] => {
  const prs = useHiveStore((state) => state.prs);
  const fleet = useHiveStore(selectSessionFacets);

  return useMemo(
    () =>
      prs.map((pr) => ({
        n: pr.number,
        repo: pr.repo,
        title: pr.title,
        state: pr.state,
        findings: pr.findings,
        checks: pr.checks,
        url: pr.url,
        branch: pr.branch,
        session: sessionForPr(pr, fleet),
      })),
    [prs, fleet],
  );
};

/** Where the PR list came from, and how much to trust it. */
export const usePrSource = () => useHiveStore((state) => state.prSource);

/** Sweep GitHub. The poller's entry point — see `hooks/use-pr-refresh.ts`. */
export const useRefreshPrs = () => useHiveStore((state) => state.refreshPrs);


/** Mark one notification read, by its id (story 051, HIVE-75). */
export const useMarkRead = () => useHiveStore((state) => state.markRead);

/** Remove a notification the user has acted on (HIVE-93). */
export const useDismissNotif = () =>
  useHiveStore((state) => state.dismissNotif);

/** Push a notification — the stream's entry point (stories 051, 061, HIVE-75). */
export const usePushNotif = () => useHiveStore((state) => state.pushNotif);

/** Install main's buffer on mount (HIVE-75). */
export const useHydrateNotifs = () =>
  useHiveStore((state) => state.hydrateNotifs);

/** Apply read-state the hub decided — see `use-notification-stream` (HIVE-75). */
export const useApplyRead = () => useHiveStore((state) => state.applyRead);

/** The entity behind `activeTab`, or null for the orchestrator. */
export const useActiveEntity = () => {
  const activeTab = useUiStore((state) => state.activeTab);
  return useHiveStore((state) =>
    activeTab === 'orch' ? null : (state.entities[activeTab] ?? null),
  );
};
