import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { createInitialState } from '@/data/fixtures';
import type { Effort, Entity, Model, Session, SessionStatus } from '@/types/entity';
import { isSession } from '@/types/entity';
import type { FeedItem } from '@/types/feed';
import type { TermLine } from '@/types/terminal';

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

/** PRs reachable from a ticket's sessions (story 032). */
export const useTicketPrs = (ticketKey: string) =>
  useHiveStore(
    useShallow((state) => {
      const ticket = state.tickets.find((t) => t.key === ticketKey);
      if (!ticket) return [];
      return state.prs.filter((pr) => ticket.sessions.includes(pr.session));
    }),
  );

/** Inbox unread count (stories 050, 021). */
export const useUnreadCount = () =>
  useHiveStore((state) => state.notifs.filter((notif) => notif.unread).length);

/** The entity behind `activeTab`, or null for the orchestrator. */
export const useActiveEntity = () => {
  const activeTab = useUiStore((state) => state.activeTab);
  return useHiveStore((state) =>
    activeTab === 'orch' ? null : (state.entities[activeTab] ?? null),
  );
};
