import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { createInitialState } from '@/data/fixtures';
import type { Effort, Entity, Model, Session, SessionStatus } from '@/types/entity';
import { isSession } from '@/types/entity';
import type { FeedItem } from '@/types/feed';
import type { Pr, TicketPr } from '@/types/pull-request';
import type { TermLine } from '@/types/terminal';
import type { Ticket } from '@/types/ticket';

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

/** Delay before a messaged session acknowledges, in ms. */
export const ACK_DELAY_MS = 2000;

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
  sendToEntity: (id: string, msg: string) => ReturnType<typeof setTimeout> | null;
  runOrchCommand: (raw: string) => void;
  markAllRead: () => void;
  markRead: (index: number) => void;
  pushFeed: (item: FeedItem) => void;
  appendEntityLines: (
    id: string,
    lines: TermLine[],
    status?: SessionStatus,
  ) => void;
  reset: () => void;
}

/** Feed is capped so a long-running demo cannot grow without bound. */
const FEED_CAP = 24;

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
    const session: Session = {
      kind: 'session',
      id,
      project: repo,
      branch: `feat/${id}`,
      status: task ? 'working' : 'idle',
      task: task ?? '',
      pr: null,
      cost: '$0.00',
      model: model ?? 'opus',
      effort: effort ?? 'high',
      lines: [
        line(`❯ claude --new ${repo}`, 'green'),
        line(
          task
            ? `  task: ${task}`
            : '  no task given — session idle, resume any time',
          'dim',
        ),
        task
          ? line('✱ Working…', 'amber')
          : line('✓ session idle — context saved', 'dim'),
      ],
    };

    set((state) => ({
      entities: { ...state.entities, [id]: session },
      order: [...state.order, id],
    }));

    get().pushFeed({
      time: nowLabel(),
      txt: `Spawned ${id} on ${repo}`,
      tone: 'brand',
      icon: 'ph-plus-circle',
    });

    useUiStore.getState().openTab(id);

    return id;
  },

  /**
   * Route a message to an entity.
   *
   * Returns the pending acknowledgement's timer handle so tests and the
   * simulation (story 061) can cancel it deterministically rather than racing
   * a real wait.
   */
  sendToEntity: (id, msg) => {
    const entity = get().entities[id];
    if (!entity) return null;

    get().appendEntityLines(id, [line(`❯ [orchestrator] ${msg}`, 'cyan')]);
    get().pushFeed({
      time: nowLabel(),
      txt: `Routed your reply to ${id}`,
      tone: 'brand',
      icon: 'ph-paper-plane-tilt',
    });

    return setTimeout(() => {
      get().appendEntityLines(
        id,
        [
          line(`  acknowledged — ${msg}`, 'dim'),
          line('✱ Working…', 'amber'),
        ],
        'working',
      );
    }, ACK_DELAY_MS);
  },

  /**
   * Execute an orchestrator console command.
   *
   * Story 041 owns the full grammar; this handles the subset the console boots
   * with and echoes anything else as an error, so 041 extends a working seam
   * rather than inventing one.
   */
  runOrchCommand: (raw) => {
    const input = raw.trim();
    if (!input) return;

    const pushOrch = (text: string, color: TermLine['color'] = 'ink') =>
      set((state) => ({ orchLines: [...state.orchLines, line(text, color)] }));

    pushOrch(`❯ ${input}`, 'green');

    const [command, ...rest] = input.split(/\s+/);

    if (command === 'help') {
      pushOrch('  send <session> <message>   route a message to a session', 'dim');
      pushOrch('  help                       show this list', 'dim');
      return;
    }

    if (command === 'send') {
      const [target, ...words] = rest;
      if (!target || words.length === 0) {
        pushOrch('  usage: send <session> <message>', 'red');
        return;
      }
      if (!get().entities[target]) {
        pushOrch(`  no such session: ${target}`, 'red');
        return;
      }
      get().sendToEntity(target, words.join(' '));
      pushOrch(`  routed to ${target}`, 'dim');
      return;
    }

    pushOrch(`  unknown command: ${command}`, 'red');
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

  reset: () => {
    spawnCounter = 0;
    set(createInitialState());
  },
}));

/** `HH:MM`, matching the concept's feed timestamps. */
function nowLabel(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

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
      const counts = { working: 0, waiting: 0, idle: 0, done: 0 };
      for (const id of state.order) {
        const entity = state.entities[id];
        if (entity && isSession(entity)) counts[entity.status] += 1;
      }
      return counts;
    }),
  );

/** Active sessions first, then done ones — the keyboard nav order (041, 060). */
export const useNavOrder = () =>
  useHiveStore(
    useShallow((state) => {
      const active: string[] = [];
      const done: string[] = [];
      for (const id of state.order) {
        const entity = state.entities[id];
        if (!entity || !isSession(entity)) continue;
        (entity.status === 'done' ? done : active).push(id);
      }
      return [...active, ...done];
    }),
  );

/** The long-lived background agents, in fixture order (story 033). */
export const useAgentOrder = () =>
  useHiveStore(useShallow((state) => state.agentOrder));

/** The project list, in fixture order (story 031). */
export const useProjects = () =>
  useHiveStore(useShallow((state) => state.projects));

/** Non-done sessions for a project (story 031). */
export const useProjectSessions = (projectId: string) =>
  useHiveStore(
    useShallow((state) =>
      state.order.filter((id) => {
        const entity = state.entities[id];
        return (
          entity !== undefined &&
          isSession(entity) &&
          entity.project === projectId &&
          entity.status !== 'done'
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

/** The entity behind `activeTab`, or null for the orchestrator. */
export const useActiveEntity = () => {
  const activeTab = useUiStore((state) => state.activeTab);
  return useHiveStore((state) =>
    activeTab === 'orch' ? null : (state.entities[activeTab] ?? null),
  );
};
