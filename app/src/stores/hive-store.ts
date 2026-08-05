import { useMemo, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { createInitialState } from '@/data/fixtures';
import type { ParsedCommand } from '@/types/command';
import { USAGE } from '@/types/command';
import type {
  Effort,
  Entity,
  Model,
  Project,
  ProjectRow,
  Session,
  SessionStatus,
} from '@/types/entity';
import { isEnded, isSession, isTerminated } from '@/types/entity';
import type { FeedItem } from '@/types/feed';
import type { Notification } from '@/types/notification';
import type { Pr, TicketPr } from '@/types/pull-request';
import type { TermLine } from '@/types/terminal';
import type { Ticket } from '@/types/ticket';

import { isDesktop } from '@config/runtime';
import { reset as resetClock, stamp } from '@lib/fake-clock';
import {
  projectConfigSnapshot,
  subscribeProjectConfig,
} from '@lib/project-config';
import { requestSpawn } from '@lib/terminal/pty-transport';
import { sendToSession } from '@lib/terminal/session-input';
import { useUiStore } from '@stores/ui-store';

/**
 * Domain state — what the system knows, as opposed to what the user is looking
 * at (which lives in `ui-store.ts`).
 *
 * The actions mirror what the future orchestrator daemon will do, so panels
 * stay pure views and swapping in a real backend later replaces this store's
 * internals rather than the component tree. That seam is the point; see
 * `stories/000-overview.md` → Decision record.
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

interface HiveState {
  entities: Record<string, Entity>;
  order: string[];
  agentOrder: string[];
  projects: ReturnType<typeof createInitialState>['projects'];
  tickets: ReturnType<typeof createInitialState>['tickets'];
  prs: ReturnType<typeof createInitialState>['prs'];
  notifs: ReturnType<typeof createInitialState>['notifs'];
  feed: FeedItem[];
  orchLines: TermLine[];

  spawnSession: (
    repo: string,
    task?: string,
    model?: Model,
    effort?: Effort,
  ) => string;
  sendToEntity: (
    id: string,
    msg: string,
    origin?: MessageOrigin,
  ) => SendOutcome | null;
  openEntity: (id: string) => boolean;
  runOrchCommand: (command: ParsedCommand) => void;
  markAllRead: () => void;
  markRead: (index: number) => void;
  pushNotif: (notif: Notification) => void;
  pushFeed: (item: FeedItem) => void;
  appendEntityLines: (
    id: string,
    lines: TermLine[],
    status?: SessionStatus,
  ) => void;
  setSessionStatus: (id: string, status: SessionStatus) => void;
  reset: () => void;
}

/** Feed is capped so a long-running demo cannot grow without bound. */
const FEED_CAP = 24;

/**
 * Inbox cap (story 051). Eight is what fits the rail without scrolling on a
 * laptop, and an inbox that grows without bound stops being an inbox.
 */
const NOTIF_CAP = 8;

/**
 * Console transcript cap (story 041). Oldest lines drop first.
 *
 * Unlike the feed, this one has a second job: the transcript is replayed into
 * an xterm on every subscribe, so an unbounded array would make opening the
 * orchestrator slower the longer the session had been running.
 */
const ORCH_LINE_CAP = 200;

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

/** Deterministic-enough id for a prototype: `sess-a1`, `sess-a2`, … */
function nextSessionId(): string {
  spawnCounter += 1;
  return `sess-${spawnCounter.toString(36).padStart(2, '0')}`;
}

const line = (text: string, color: TermLine['color'] = 'ink'): TermLine => ({
  text,
  color,
});

export const useHiveStore = create<HiveState>()((set, get) => ({
  ...createInitialState(),

  /**
   * Create a session and open its tab.
   *
   * Actions that span both stores call the other store's action explicitly —
   * no store subscribes to the other. That keeps the dependency one-way and
   * makes the cross-store effect visible at the call site.
   */
  spawnSession: (repo, task, model, effort) => {
    const id = nextSessionId();
    // Resolved once: the seed transcript quotes them back, so a default applied
    // in two places could print one model and record another.
    const resolvedModel = model ?? 'opus';
    const resolvedEffort = effort ?? 'high';

    const session: Session = {
      kind: 'session',
      id,
      project: repo,
      branch: `feat/${id}`,
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
          ? line(`✱ Working… ${task}`, 'amber')
          : line('· Ready — type below to give this session its task', 'dim'),
      ],
    };

    set((state) => ({
      entities: { ...state.entities, [id]: session },
      order: [...state.order, id],
    }));

    get().pushFeed({
      time: stamp(),
      txt: `Spawned ${id} on ${repo}`,
      tone: 'brand',
      icon: 'ph-plus-circle',
    });

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
      const result = sendToSession(id, msg);

      get().pushFeed({
        time: stamp(),
        txt: result.ok
          ? origin === 'orchestrator'
            ? `Routed your reply to ${id}`
            : `Routed your message to ${id}`
          : `Could not route to ${id} — ${result.reason}`,
        tone: result.ok ? 'brand' : 'amber',
        icon: result.ok ? 'ph-paper-plane-tilt' : 'ph-warning',
      });

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
        ? [line(`❯ [orchestrator] ${msg}`, 'cyan')]
        : [line(''), line(`❯ ${msg}`, 'cyan')];

    get().appendEntityLines(id, echo);
    get().pushFeed({
      time: stamp(),
      txt:
        origin === 'orchestrator'
          ? `Routed your reply to ${id}`
          : `Routed your message to ${id}`,
      tone: 'brand',
      icon: 'ph-paper-plane-tilt',
    });

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
          [line(ACK_LINE, 'blue'), line('✱ Working…', 'amber')],
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
    if (!isTerminated(get().entities[id])) {
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

    pushOrch(`❯ ${command.raw}`, 'green');

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
            `  ${entity.id.padEnd(16)}${STATUS_WORD[entity.status].padEnd(13)}${entity.project} · ${entity.branch}`,
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
        if (!get().entities[command.target]) {
          pushOrch(`  no such session: ${command.target}`, 'red');
          return;
        }
        /**
         * The refusal is printed, not swallowed (story 108). A console that
         * answered `opened sess-02` and then did not open it would be worse
         * than one that said nothing at all.
         */
        if (!get().openEntity(command.target)) {
          pushOrch(
            `  ${command.target} has terminated — its process is gone`,
            'red',
          );
          return;
        }
        pushOrch(`  opened ${command.target}`, 'dim');
        return;
      }

      case 'send': {
        if (!get().entities[command.target]) {
          pushOrch(`  no such session: ${command.target}`, 'red');
          return;
        }

        const outcome = get().sendToEntity(command.target, command.message);
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
        pushOrch(`  routed → ${command.target}`, 'dim');
        return;
      }

      case 'spawn': {
        const known = get().projects.some(
          (project) => project.id === command.repo,
        );
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

  markAllRead: () =>
    set((state) => ({
      notifs: state.notifs.map((notif) => ({ ...notif, unread: false })),
    })),

  markRead: (index) =>
    set((state) => ({
      notifs: state.notifs.map((notif, i) =>
        i === index ? { ...notif, unread: false } : notif,
      ),
    })),

  pushNotif: (notif) =>
    set((state) => ({ notifs: [notif, ...state.notifs].slice(0, NOTIF_CAP) })),

  pushFeed: (item) =>
    set((state) => ({ feed: [item, ...state.feed].slice(0, FEED_CAP) })),

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
      const entity = state.entities[id];
      if (!entity || !isSession(entity) || entity.status === status) return state;
      return {
        entities: { ...state.entities, [id]: { ...entity, status } },
      };
    }),

  reset: () => {
    spawnCounter = 0;
    resetClock();
    set(createInitialState());
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

/** Ids of projects that still own at least one session (story 101). */
const projectsOwningSessions = (state: HiveState): string[] => {
  const ids: string[] = [];
  for (const id of state.order) {
    const entity = state.entities[id];
    if (!entity || !isSession(entity)) continue;
    if (!ids.includes(entity.project)) ids.push(entity.project);
  }
  return ids;
};

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
 * The project list: the config's, merged with the fixtures (stories 031, 101).
 *
 * | Situation | The list is |
 * |---|---|
 * | No snapshot — browser demo, first frames of launch | fixtures, unchanged |
 * | Snapshot with zero projects | fixtures, unchanged |
 * | Snapshot with projects | the config's, **plus** fixture projects that still own live sessions, marked `demo` |
 *
 * The third row is the load-bearing one. The work panel, the orchestrator
 * table and its console `ls`, and `lib/terminal/resolve-transport` all reach
 * sessions through `entity.project`; dropping fixture projects the moment a
 * real one is added would strand every one of them. Marking them `demo` is
 * honest and costs one field.
 *
 * A config project and a fixture project sharing an id collapse to a single
 * row and **config wins** — that is the upgrade path for anyone who already
 * mapped `apfm-web` under story 090.
 *
 * **Config order is the file's order and is never sorted.** Story 103's
 * drag-reorder works by rewriting that array, and the left rail reads it
 * positionally, so sorting here would silently make 103 unimplementable.
 */
export const useProjects = (): ProjectRow[] => {
  const fixtures = useHiveStore(useShallow((state) => state.projects));
  const owning = useHiveStore(useShallow(projectsOwningSessions));
  const snapshot = useSyncExternalStore(
    subscribeProjectConfig,
    projectConfigSnapshot,
    projectConfigSnapshot,
  );

  return useMemo(() => {
    const asDemo = (project: Project): ProjectRow => ({
      ...project,
      name: project.id,
      source: 'demo',
    });

    const configured = snapshot?.projects ?? [];
    if (configured.length === 0) return fixtures.map(asDemo);

    const rows: ProjectRow[] = configured.map((entry) => ({
      id: entry.id,
      name: entry.name,
      icon: entry.icon,
      source: 'config',
    }));
    const claimed = new Set(rows.map((row) => row.id));

    for (const fixture of fixtures) {
      if (claimed.has(fixture.id)) continue; // config wins
      if (!owning.includes(fixture.id)) continue; // no live sessions, drop it
      rows.push(asDemo(fixture));
    }

    return rows;
  }, [fixtures, owning, snapshot]);
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

/**
 * PRs reachable from a ticket's sessions, with their state resolved (story 032).
 *
 * Walks the ticket's sessions rather than filtering the global `prs` list,
 * because a session can carry a PR the global list has never heard of — fixture
 * `ecs-scaling` holds #31, which is absent from `prs`, and filtering would drop
 * ticket GRAC-2954's PR section entirely.
 *
 * Where the global list *does* know the number it wins outright: it is the
 * single source of truth for state and findings, and a session's own `pr.state`
 * is a stale copy. Fixture #219 proves the difference — `approved` globally,
 * still `open` on the `webhooks` session.
 */
export function resolveTicketPrs(
  ticketKey: string,
  tickets: Ticket[],
  entities: Record<string, Entity>,
  prs: Pr[],
): TicketPr[] {
  const ticket = tickets.find((t) => t.key === ticketKey);
  if (!ticket) return [];

  const resolved: TicketPr[] = [];

  for (const sessionId of ticket.sessions) {
    const entity = entities[sessionId];
    if (!entity || !isSession(entity)) continue;

    const sessionPr = entity.pr;
    if (!sessionPr) continue;

    const known = prs.find((pr) => pr.n === sessionPr.n);

    resolved.push({
      n: sessionPr.n,
      repo: entity.project,
      state: known?.state ?? sessionPr.state,
      findings: known?.findings ?? 0,
      session: sessionId,
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
 * depth exceeded". Subscribing to the stable slices and memoising over them is
 * what keeps the identity stable between renders.
 */
export const useTicketPrs = (ticketKey: string): TicketPr[] => {
  const tickets = useHiveStore((state) => state.tickets);
  const entities = useHiveStore((state) => state.entities);
  const prs = useHiveStore((state) => state.prs);

  return useMemo(
    () => resolveTicketPrs(ticketKey, tickets, entities, prs),
    [ticketKey, tickets, entities, prs],
  );
};

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

/** Every open PR the fleet produced (story 052). */
export const usePrs = () => useHiveStore((state) => state.prs);

/** The orchestrator's activity feed, newest first (story 053). */
export const useFeed = () => useHiveStore((state) => state.feed);

/** Mark one notification read, by its index in `notifs` (story 051). */
export const useMarkRead = () => useHiveStore((state) => state.markRead);

/** Push a notification — the simulation's entry point (stories 051, 061). */
export const usePushNotif = () => useHiveStore((state) => state.pushNotif);

/** The entity behind `activeTab`, or null for the orchestrator. */
export const useActiveEntity = () => {
  const activeTab = useUiStore((state) => state.activeTab);
  return useHiveStore((state) =>
    activeTab === 'orch' ? null : (state.entities[activeTab] ?? null),
  );
};
