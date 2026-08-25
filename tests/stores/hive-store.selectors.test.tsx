import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Session } from '@/types/entity';

import {
  emptySnapshot,
  type ConfigSnapshot,
} from '../../electron/shared/config-contract';
import type { PrRecord } from '../../electron/shared/github-contract';
import {
  resetProjectConfig,
  setProjectConfigForTest,
} from '@lib/project-config';

import {
  useActiveEntity,
  useAgentOrder,
  useCounts,
  useEntity,
  useHasResumable,
  useHiveStore,
  useMarkRead,
  useNavOrder,
  useNotifs,
  useProjects,
  useProjectSessions,
  usePrs,
  useSessionPr,
  useTicketCount,
  useTicketPrs,
  useTickets,
  useTicketSessions,
  useUnreadCount,
} from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { notif } from '../support/notifications';
import { seedDemoFleet } from '@tests/support/demo-fleet';

import { testProjectKey } from '@tests/support/project-key';

/**
 * Every selector hook is asserted against the fixtures. Derived values are
 * computed in selectors and never stored, so these tests are the only place
 * the expected numbers are written down twice — which is the point: a fixture
 * change that silently shifts a header count fails here.
 */
describe('hive-store selectors', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
  });

  describe('useEntity', () => {
    it('returns the entity', () => {
      const { result } = renderHook(() => useEntity('hero-refresh'));
      expect(result.current.id).toBe('hero-refresh');
    });

    it('returns undefined for an unknown id', () => {
      const { result } = renderHook(() => useEntity('nope'));
      expect(result.current).toBeUndefined();
    });
  });

  describe('useCounts', () => {
    it('splits the fixture sessions by status', () => {
      const { result } = renderHook(() => useCounts());

      // 4 working, 2 waiting, 2 idle, 2 done — 8 active and 2 ended overall.
      // No fixture is `terminated`: only a real pty exit produces one.
      expect(result.current).toEqual({
        working: 4,
        waiting: 2,
        idle: 2,
        done: 2,
        terminated: 0,
        // HIVE-87. No fixture is `closed` either: only a record read back from
        // the ledger at boot produces one, and nothing seeds the ledger here.
      });
    });

    it('counts sessions only, never agents', () => {
      const { result } = renderHook(() => useCounts());
      const total = Object.values(result.current).reduce((a, b) => a + b, 0);

      expect(total).toBe(10);
    });

    it('follows a status change', () => {
      const { result } = renderHook(() => useCounts());

      act(() => {
        useHiveStore
          .getState()
          .appendEntityLines('hero-refresh', [], 'done');
      });

      expect(result.current).toEqual({
        working: 3,
        waiting: 2,
        idle: 2,
        done: 3,
        terminated: 0,
      });
    });
  });

  describe('useNavOrder', () => {
    it('puts active sessions before done ones', () => {
      const { result } = renderHook(() => useNavOrder());

      expect(result.current).toEqual([
        'hero-refresh',
        'lead-form',
        'webhooks',
        'rails-upgrade',
        'call-notes',
        'dark-tokens',
        'e2e-quote',
        'nplusone',
        'tz-fix',
        'ecs-scaling',
      ]);
    });

    it('excludes agents', () => {
      const { result } = renderHook(() => useNavOrder());
      expect(result.current).not.toContain('slack-agent');
    });

    it('sinks a terminated session to the bottom, like a done one', () => {
      /**
       * The four selectors that partition the fleet used to spell
       * `status === 'done'` independently, which is exactly how a fifth state
       * gets silently forgotten in three of them. `isEnded` is one predicate so
       * they cannot disagree (story 108).
       */
      const { result } = renderHook(() => useNavOrder());

      act(() =>
        useHiveStore.getState().setSessionStatus('hero-refresh', 'terminated'),
      );

      // Seven still running, then the three that have ended — hero-refresh
      // keeps its place *within* that group, which is fixture order.
      expect(result.current.slice(7)).toEqual([
        'hero-refresh',
        'tz-fix',
        'ecs-scaling',
      ]);
      expect(result.current[0]).toBe('lead-form');
    });
  });

  describe('useProjectSessions', () => {
    it('returns a project\'s non-done sessions', () => {
      const { result } = renderHook(() => useProjectSessions('nova-web'));

      // hero-refresh, lead-form, e2e-quote — all nova-web and none done.
      expect(result.current).toEqual([
        'hero-refresh',
        'lead-form',
        'e2e-quote',
      ]);
    });

    it('omits done sessions', () => {
      const { result } = renderHook(() => useProjectSessions('advisor-portal'));

      // call-notes is waiting; tz-fix is done and must not appear.
      expect(result.current).toEqual(['call-notes']);
    });

    it('returns nothing for an unknown project', () => {
      const { result } = renderHook(() => useProjectSessions('nope'));
      expect(result.current).toEqual([]);
    });

    it('omits terminated sessions too (story 108)', () => {
      // The left rail lists what is *running* in a project. A dead pty is not.
      const { result } = renderHook(() => useProjectSessions('nova-web'));

      act(() =>
        useHiveStore.getState().setSessionStatus('lead-form', 'terminated'),
      );

      expect(result.current).toEqual(['hero-refresh', 'e2e-quote']);
    });
  });

  describe('usePrs', () => {
    /**
     * The owning session is a *match*, not a stored field.
     *
     * Main has never heard of a session, so `PrRecord` carries a branch and
     * this selector resolves the rest. #482 is on `feat/hero-refresh`, which is
     * exactly what the `hero-refresh` session is working.
     */
    it('resolves each PR to the session on its branch', () => {
      const { result } = renderHook(() => usePrs());

      const hero = result.current.find((pr) => pr.n === 482);
      expect(hero?.session).toBe('hero-refresh');
    });

    it('yields a null session when nothing is on the branch', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          prs: state.prs.map((pr) =>
            pr.number === 482 ? { ...pr, branch: 'feat/orphan' } : pr,
          ),
        }));
      });

      const { result } = renderHook(() => usePrs());

      expect(result.current.find((pr) => pr.n === 482)?.session).toBeNull();
    });

    /**
     * A live session beats an ended one on the same branch.
     *
     * `/clear` retires a row and opens a successor on the same branch, and
     * ended rows linger — so the first match in `order` is often a corpse.
     * Opening it would land the user on a terminal they cannot type into.
     */
    it('prefers a live session over an ended one on the same branch', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          entities: {
            ...state.entities,
            'hero-refresh-old': {
              ...(state.entities['hero-refresh'] as Session),
              id: 'hero-refresh-old',
              status: 'done',
            },
          },
          // The ended one first, so a naive `find` would pick it.
          order: ['hero-refresh-old', ...state.order],
        }));
      });

      const { result } = renderHook(() => usePrs());

      expect(result.current.find((pr) => pr.n === 482)?.session).toBe(
        'hero-refresh',
      );
    });

    /**
     * The test that used to live here asserted the opposite — that an ended
     * session is returned when it is the only match. That pinned a bug rather
     * than a decision: `openEntity` refuses ended sessions, so the id it handed
     * back bounced the user to the orchestrator instead of opening anything,
     * and both surfaces lost their GitHub link in the process.
     *
     * It is the common case, not an edge one: the panel keeps PRs merged in the
     * last 24 hours, and those are precisely the branches whose sessions have
     * ended or been retired by `/clear`.
     */
    it('resolves to null when the only session on the branch has ended', () => {
      const { result } = renderHook(() => usePrs());

      // `tz-fix` is done, and it is the only session on `fix/timezone-bug`.
      expect(result.current.find((pr) => pr.n === 77)?.session).toBeNull();
    });

    /**
     * The same branch name in two repositories is normal — one ticket, a
     * frontend and a backend session, both on `feat/shared`. Matching on branch
     * alone would open whichever came first in `order`, which is a coin toss
     * that lands the user in the wrong terminal half the time.
     */
    it('picks the session in the PR’s own repository when a branch is shared', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          entities: {
            ...state.entities,
            'fe-shared': {
              ...(state.entities['hero-refresh'] as Session),
              id: 'fe-shared',
              project: 'nova-web',
              branch: 'feat/shared',
            },
            'be-shared': {
              ...(state.entities['hero-refresh'] as Session),
              id: 'be-shared',
              project: 'referral-api',
              branch: 'feat/shared',
            },
          },
          // Frontend first, so a branch-only match would always answer `fe`.
          order: ['fe-shared', 'be-shared', ...state.order],
          prs: [
            {
              number: 900,
              title: 'Backend half',
              url: 'https://github.com/demo/referral-api/pull/900',
              repo: 'referral-api',
              owner: 'demo',
              branch: 'feat/shared',
              state: 'open' as const,
              findings: 0,
              checks: 'passing' as const,
              updatedAt: '2026-08-09T15:00:00Z',
            },
          ],
        }));
      });

      const { result } = renderHook(() => usePrs());

      expect(result.current[0].session).toBe('be-shared');
    });

    /**
     * Project **disambiguates**, it does not filter. A checkout directory named
     * differently from its repository is common, and requiring equality would
     * break the link for everyone who has one — so an unambiguous branch match
     * still wins when no project matches.
     */
    it('still links when no session’s project matches the repository', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          prs: state.prs.map((pr) =>
            pr.number === 482 ? { ...pr, repo: 'nova-web-renamed' } : pr,
          ),
        }));
      });

      const { result } = renderHook(() => usePrs());

      expect(result.current.find((pr) => pr.n === 482)?.session).toBe(
        'hero-refresh',
      );
    });
  });

  describe('useTicketPrs', () => {
    /**
     * The link is the **branch**, resolved against the live PR list.
     *
     * This used to read `Session.pr` — a field nothing has ever written, which
     * is why the PR section of a ticket card was permanently empty in the real
     * app and only looked populated in tests.
     */
    it("returns the PRs on the branches of a ticket's sessions", () => {
      const { result } = renderHook(() => useTicketPrs('GRAC-3018'));

      expect(result.current).toEqual([
        {
          n: 482,
          repo: 'nova-web',
          state: 'open',
          findings: 2,
          url: 'https://github.com/demo/nova-web/pull/482',
          session: 'hero-refresh',
        },
      ]);
    });

    it('returns nothing when no PR is on any of the ticket’s branches', () => {
      // GRAC-3010 covers nplusone and e2e-quote, neither of which has a PR.
      const { result } = renderHook(() => useTicketPrs('GRAC-3010'));
      expect(result.current).toEqual([]);
    });

    /**
     * The second match: the key in the PR's title.
     *
     * It catches the two cases a branch match misses — a PR raised outside the
     * app, and one whose session has ended and aged out of the fleet.
     */
    it('matches a PR whose title names the ticket', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          tickets: [
            {
              key: 'HIVE-73',
              status: 'In Progress',
              statusCategory: 'in-progress',
              title: 'Start a session from a ticket',
            },
            ...state.tickets,
          ],
          prs: [
            {
              number: 61,
              title: 'feat(work): start a session from a ticket (HIVE-73)',
              url: 'https://github.com/demo/the-hive/pull/61',
              repo: 'the-hive',
              owner: 'demo',
              branch: 'goal/ticket-session-link',
              state: 'open' as const,
              findings: 0,
              checks: 'passing' as const,
              updatedAt: '2026-08-09T12:55:04Z',
            },
            ...state.prs,
          ],
        }));
      });

      const { result } = renderHook(() => useTicketPrs('HIVE-73'));

      expect(result.current).toHaveLength(1);
      expect(result.current[0]).toMatchObject({ n: 61, session: null });
    });

    it('matches a PR whose branch names the ticket', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          tickets: [
            {
              key: 'HIVE-73',
              status: 'In Progress',
              statusCategory: 'in-progress',
              title: 'Start a session from a ticket',
            },
            ...state.tickets,
          ],
          prs: [
            {
              number: 61,
              title: 'Start a session from a ticket',
              url: 'https://github.com/demo/the-hive/pull/61',
              repo: 'the-hive',
              owner: 'demo',
              branch: 'feat/HIVE-73-session-link',
              state: 'open' as const,
              findings: 0,
              checks: 'passing' as const,
              updatedAt: '2026-08-09T12:55:04Z',
            },
            ...state.prs,
          ],
        }));
      });

      const { result } = renderHook(() => useTicketPrs('HIVE-73'));

      expect(result.current.map((pr) => pr.n)).toEqual([61]);
    });

    /**
     * The key match is bounded by non-word characters, so a shorter key cannot
     * claim a longer one's PR. Without the boundary, `HIVE-7` matches
     * `HIVE-73` and every ticket in a project would collect its neighbours'
     * pull requests.
     */
    it('does not let HIVE-7 claim HIVE-73’s pull request', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          tickets: [
            {
              key: 'HIVE-7',
              status: 'To Do',
              statusCategory: 'todo',
              title: 'A different ticket',
            },
            ...state.tickets,
          ],
          prs: [
            {
              number: 61,
              title: 'feat(work): start a session from a ticket (HIVE-73)',
              url: 'https://github.com/demo/the-hive/pull/61',
              repo: 'the-hive',
              owner: 'demo',
              branch: 'goal/ticket-session-link',
              state: 'open' as const,
              findings: 0,
              checks: 'passing' as const,
              updatedAt: '2026-08-09T12:55:04Z',
            },
            ...state.prs,
          ],
        }));
      });

      const { result } = renderHook(() => useTicketPrs('HIVE-7'));

      expect(result.current).toEqual([]);
    });

    /** A PR that matches by branch *and* by key is still listed once. */
    it('lists a PR that matches both ways only once', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          prs: state.prs.map((pr) =>
            pr.number === 482
              ? { ...pr, title: 'Hero refresh (GRAC-3018)' }
              : pr,
          ),
        }));
      });

      const { result } = renderHook(() => useTicketPrs('GRAC-3018'));

      expect(result.current.map((pr) => pr.n)).toEqual([482]);
    });

    /**
     * Cross-repo work on one ticket, which a number-keyed dedupe used to eat.
     *
     * A frontend #42 and a backend #42 are two pull requests, and a ticket
     * worked across two repositories has to show both — that is the shape of
     * nearly every change in this workspace.
     */
    it('keeps two PRs that share a number across repositories', () => {
      const twin = (repo: string) => ({
        number: 42,
        title: 'Cross-repo change (GRAC-3018)',
        url: `https://github.com/demo/${repo}/pull/42`,
        repo,
        owner: 'demo',
        branch: `feat/cross-${repo}`,
        state: 'open' as const,
        findings: 0,
        checks: 'passing' as const,
        updatedAt: '2026-08-09T15:00:00Z',
      });

      act(() => {
        useHiveStore.setState({ prs: [twin('nova-web'), twin('referral-api')] });
      });

      const { result } = renderHook(() => useTicketPrs('GRAC-3018'));

      expect(result.current.map((pr) => pr.repo)).toEqual([
        'nova-web',
        'referral-api',
      ]);
    });

    it('resolves only the sessions pointing at this ticket', () => {
      act(() => {
        useHiveStore.setState({
          tickets: [
            {
              key: 'GHOST-1',
              status: 'To Do',
              statusCategory: 'todo',
              title: 'One session claims it',
            },
          ],
        });
        // `hero-refresh` is on the branch of PR #482; `webhooks` is on #219's
        // and stays on its own ticket, so a resolver that ignored the key would
        // return two.
        useHiveStore.setState((current) => ({
          entities: {
            ...current.entities,
            'hero-refresh': {
              ...(current.entities['hero-refresh'] as Session),
              ticket: 'GHOST-1',
            },
          },
        }));
      });

      const { result } = renderHook(() => useTicketPrs('GHOST-1'));

      expect(result.current).toHaveLength(1);
      expect(result.current[0].session).toBe('hero-refresh');
    });

    it('returns nothing for an unknown ticket', () => {
      const { result } = renderHook(() => useTicketPrs('NOPE-1'));
      expect(result.current).toEqual([]);
    });
  });

  describe('useUnreadCount', () => {
    it('counts what is unread, and nothing else', () => {
      const { result } = renderHook(() => useUnreadCount());
      expect(result.current).toBe(0);

      act(() => {
        useHiveStore
          .getState()
          .hydrateNotifs([
            notif({ id: 'a' }),
            notif({ id: 'b' }),
            notif({ id: 'c', unread: false }),
          ]);
      });

      expect(result.current).toBe(2);
    });

    it('drops to zero once everything is read', () => {
      const { result } = renderHook(() => useUnreadCount());

      act(() => {
        useHiveStore.getState().hydrateNotifs([notif({ id: 'a' })]);
        useHiveStore.getState().markAllRead();
      });

      expect(result.current).toBe(0);
    });
  });

  describe('useActiveEntity', () => {
    it('is null while the orchestrator is active', () => {
      const { result } = renderHook(() => useActiveEntity());
      expect(result.current).toBeNull();
    });

    it('follows the active tab', () => {
      const { result } = renderHook(() => useActiveEntity());

      act(() => {
        useUiStore.getState().openTab('webhooks');
      });

      expect(result.current?.id).toBe('webhooks');
    });

    it('is null when the active tab names an entity that is gone', () => {
      const { result } = renderHook(() => useActiveEntity());

      act(() => {
        useUiStore.getState().openTab('nope');
      });

      expect(result.current).toBeNull();
    });
  });

  describe('useAgentOrder', () => {
    it('returns the three fixture agents in order', () => {
      const { result } = renderHook(() => useAgentOrder());

      expect(result.current).toEqual([
        'slack-agent',
        'pr-reviewer',
        'standup-agent',
      ]);
    });
  });

  describe('useProjects', () => {
    const configured = (
      entries: { id: string; name?: string }[],
    ): ConfigSnapshot => ({
      ...emptySnapshot('/tmp/hive/config.json'),
      projects: entries.map(({ id, name }) => ({
        id,
        name: name ?? id,
        path: `/repos/${id}`,
        icon: 'ph-folder',
        origin: 'local' as const,
        status: 'ok' as const,
        key: testProjectKey(id),
        isRepo: true,
      })),
    });

    afterEach(() => {
      resetProjectConfig();
    });

    /**
     * The config decides, and nothing else does.
     *
     * This block used to describe a *merge*: config projects, plus any seeded
     * project that still owned a live seeded session, marked `source: 'demo'`,
     * with a precedence rule for a shared id. Every one of those cases existed
     * to stop the demo dataset stranding its own sessions. Both the dataset and
     * the merge are gone, and what is left is a much shorter contract — which is
     * the point of having removed it.
     */
    it('is empty when the config declares no projects', () => {
      setProjectConfigForTest(configured([]));

      const { result } = renderHook(() => useProjects());

      expect(result.current).toEqual([]);
    });

    it('is empty when there is no snapshot at all', () => {
      setProjectConfigForTest(null);

      const { result } = renderHook(() => useProjects());

      expect(result.current).toEqual([]);
    });

    /*
     * The guard against the bug this all started with — five repositories
     * nobody had mapped appearing in a fresh install — used to be a test here
     * that filled the store's `projects` slice and asserted the rail ignored
     * it. That slice no longer exists, so the guard moved into the type system:
     * `useHiveStore.setState({ projects: … })` does not compile.
     */

    it('returns the configured projects, with their names and icons', () => {
      setProjectConfigForTest(configured([{ id: 'the-hive', name: 'The Hive' }]));

      const { result } = renderHook(() => useProjects());

      expect(result.current).toEqual([
        { id: 'the-hive', key: 'th', name: 'The Hive', icon: 'ph-folder' },
      ]);
    });

    it('preserves config file order and never sorts', () => {
      setProjectConfigForTest(configured([{ id: 'zeta' }, { id: 'alpha' }]));

      const { result } = renderHook(() => useProjects());

      // Story 103's drag-reorder rewrites this array and the left rail reads
      // it positionally. Sorting here would make that story unimplementable.
      expect(result.current.map((row) => row.id)).toEqual(['zeta', 'alpha']);
    });
  });

  describe('useTickets', () => {
    it('returns all eight fixture tickets in fixture order', () => {
      const { result } = renderHook(() => useTickets());

      expect(result.current.map((ticket) => ticket.key)).toEqual([
        'GRAC-3018',
        'GRAC-3022',
        'GRAC-2991',
        'GRAC-3010',
        'GRAC-2977',
        'GRAC-3005',
        'GRAC-2810',
        'GRAC-2954',
      ]);
    });
  });

  describe('useTicketCount', () => {
    it('counts every fixture ticket, Done ones included', () => {
      const { result } = renderHook(() => useTicketCount());

      expect(result.current).toBe(8);
    });

    it('follows the store rather than caching a number', () => {
      const { result } = renderHook(() => useTicketCount());

      act(() => {
        useHiveStore.setState({ tickets: [] });
      });

      expect(result.current).toBe(0);
    });
  });

  describe('rail selectors', () => {
    it('useNotifs returns the inbox newest first', () => {
      const { result } = renderHook(() => useNotifs());
      expect(result.current).toHaveLength(0);

      act(() => {
        useHiveStore
          .getState()
          .hydrateNotifs([
            notif({ id: 'a', title: 'older', createdAt: 1_000 }),
            notif({ id: 'b', title: 'newer', createdAt: 2_000 }),
          ]);
      });

      expect(result.current.map((n) => n.title)).toEqual(['newer', 'older']);
    });

    it('usePrs returns the seeded PRs, in order', () => {
      const { result } = renderHook(() => usePrs());

      expect(result.current.map((pr) => pr.n)).toEqual([482, 219, 495, 31, 77]);
    });

    it('useMarkRead marks exactly the notification it names', () => {
      const { result } = renderHook(() => ({
        markRead: useMarkRead(),
        notifs: useNotifs(),
      }));

      act(() => {
        useHiveStore
          .getState()
          .hydrateNotifs([
            notif({ id: 'a', createdAt: 2_000 }),
            notif({ id: 'b', createdAt: 1_000 }),
          ]);
      });

      act(() => {
        result.current.markRead('a');
      });

      expect(result.current.notifs.find((n) => n.id === 'a')?.unread).toBe(false);
      expect(result.current.notifs.find((n) => n.id === 'b')?.unread).toBe(true);
    });
  });

  /**
   * What the fleet-derived selectors are allowed to react to.
   *
   * These are `toBe` assertions, and the identity *is* the behaviour under test:
   * all three hooks build fresh arrays of fresh objects, so a new identity is a
   * re-render of every ticket card in the WORK panel and every row in the PR
   * panel. They used to memoise over `entities`, which is replaced wholesale by
   * any write to any session — so one session changing status re-resolved the
   * pull requests for all of them.
   *
   * Each hook is checked both ways round. Stability alone would be satisfied by
   * a selector that had simply stopped updating, so every "holds" case is paired
   * with a "moves" case that proves the cache still lets a real change through.
   */
  describe('fleet selector stability', () => {
    /** All three, because all three shared the over-broad subscription. */
    const FLEET_HOOKS: [string, () => unknown][] = [
      ['usePrs', () => usePrs()],
      ['useTicketPrs', () => useTicketPrs('GRAC-3018')],
      ['useTicketSessions', () => useTicketSessions('GRAC-3018')],
    ];

    it.each(FLEET_HOOKS)(
      '%s holds its identity across terminal output',
      (_label, hook) => {
        const { result } = renderHook(hook);
        const before = result.current;

        act(() => {
          useHiveStore
            .getState()
            .appendEntityLines('hero-refresh', [{ text: 'more', color: 'ink' }]);
        });

        expect(result.current).toBe(before);
      },
    );

    /**
     * The point of projecting `ended` rather than carrying `status`.
     *
     * `working` → `waiting` is the most frequent write in the app — an agent
     * asking a question and being answered — and it cannot change any of these
     * answers, so it must not cost a recomputation.
     */
    it.each(FLEET_HOOKS)(
      '%s holds its identity across a status change',
      (_label, hook) => {
        const { result } = renderHook(hook);
        const before = result.current;

        act(() => {
          useHiveStore
            .getState()
            .appendEntityLines('hero-refresh', [], 'waiting');
        });

        expect(result.current).toBe(before);
      },
    );

    /** A session ending crosses the boundary the projection does keep. */
    it('recomputes when a session ends', () => {
      const { result } = renderHook(() => useTicketSessions('GRAC-3018'));

      expect(result.current).toEqual(['hero-refresh']);

      act(() => {
        useHiveStore.getState().appendEntityLines('hero-refresh', [], 'done');
      });

      expect(result.current).toEqual([]);
    });

    /** So does a branch moving, which is what a PR is matched on. */
    it('recomputes when a session changes branch', () => {
      const { result } = renderHook(() => usePrs());

      expect(result.current.find((pr) => pr.n === 482)?.session).toBe(
        'hero-refresh',
      );

      act(() => {
        useHiveStore.setState((state) => ({
          entities: {
            ...state.entities,
            'hero-refresh': {
              ...(state.entities['hero-refresh'] as Session),
              branch: 'feat/moved',
            },
          },
        }));
      });

      expect(result.current.find((pr) => pr.n === 482)?.session).toBeNull();
    });

    /** A new session is a new facet, however quiet the rest of the fleet is. */
    it('recomputes when a session joins the ticket', () => {
      const { result } = renderHook(() => useTicketSessions('GRAC-3018'));
      const before = result.current;

      act(() => {
        useHiveStore.setState((state) => ({
          entities: {
            ...state.entities,
            'hero-refresh-two': {
              ...(state.entities['hero-refresh'] as Session),
              id: 'hero-refresh-two',
            },
          },
          order: [...state.order, 'hero-refresh-two'],
        }));
      });

      expect(result.current).not.toBe(before);
      expect(result.current).toEqual(['hero-refresh', 'hero-refresh-two']);
    });
  });

  /**
   * The other half of the same problem: the poller sweeps every minute whether
   * or not GitHub has anything new, and an unconditional `set` handed the
   * renderer two brand-new objects each time. Both slices are subscribed to by
   * name, so a quiet minute still re-rendered the panel.
   */
  describe('hydratePrs', () => {
    /** Equal by value, never the same array — that is the whole comparison. */
    const resweep = () =>
      useHiveStore.getState().prs.map((pr) => ({ ...pr }));

    beforeEach(() => {
      act(() => {
        useHiveStore.getState().hydratePrs(resweep(), 3);
      });
    });

    it('keeps both slices when a sweep found nothing new', () => {
      const { prs, prSource } = useHiveStore.getState();

      act(() => {
        useHiveStore.getState().hydratePrs(resweep(), 3);
      });

      expect(useHiveStore.getState().prs).toBe(prs);
      expect(useHiveStore.getState().prSource).toBe(prSource);
    });

    it('keeps the PR panel from recomputing on a quiet sweep', () => {
      const { result } = renderHook(() => usePrs());
      const before = result.current;

      act(() => {
        useHiveStore.getState().hydratePrs(resweep(), 3);
      });

      expect(result.current).toBe(before);
    });

    it.each([
      ['a finding appeared', (pr: PrRecord) => ({ ...pr, findings: pr.findings + 1 })],
      ['checks changed', (pr: PrRecord) => ({ ...pr, checks: 'failing' as const })],
      ['a PR was approved', (pr: PrRecord) => ({ ...pr, state: 'approved' as const })],
      ['the title changed', (pr: PrRecord) => ({ ...pr, title: 'renamed' })],
    ])('installs a new list when %s', (_label, change) => {
      const before = useHiveStore.getState().prs;

      act(() => {
        useHiveStore
          .getState()
          .hydratePrs(
            before.map((pr, index) => (index === 0 ? change(pr) : { ...pr })),
            3,
          );
      });

      expect(useHiveStore.getState().prs).not.toBe(before);
    });

    it('installs a new list when a PR disappeared', () => {
      const before = useHiveStore.getState().prs;

      act(() => {
        useHiveStore.getState().hydratePrs(before.slice(1), 3);
      });

      expect(useHiveStore.getState().prs).toHaveLength(before.length - 1);
    });

    /**
     * `collectPrs` sorts live work above what landed, so a reordering is a real
     * change even when the set of pull requests is identical.
     */
    it('installs a new list when the order changed', () => {
      const before = useHiveStore.getState().prs;

      act(() => {
        useHiveStore.getState().hydratePrs([...before].reverse(), 3);
      });

      expect(useHiveStore.getState().prs).not.toBe(before);
    });

    /** A sweep succeeding after a failure is what takes the banner down. */
    it('replaces a stale source even when the list is unchanged', () => {
      act(() => {
        useHiveStore.getState().reportPrFailure('gh timed out');
      });
      expect(useHiveStore.getState().prSource).toMatchObject({ stale: true });

      act(() => {
        useHiveStore.getState().hydratePrs(resweep(), 3);
      });

      expect(useHiveStore.getState().prSource).toEqual({
        kind: 'live',
        stale: false,
        repos: 3,
      });
    });

    /**
     * The failure paths repeat far longer than the happy one — a machine with
     * no network re-reports the same failure every minute for as long as it is
     * offline — so holding identity there matters more, not less.
     */
    it('holds the source while a failure persists', () => {
      act(() => {
        useHiveStore.getState().reportPrFailure('gh timed out');
      });
      const stale = useHiveStore.getState().prSource;

      act(() => {
        useHiveStore.getState().reportPrFailure('gh timed out');
      });

      expect(useHiveStore.getState().prSource).toBe(stale);
    });

    it('holds both slices while the same conclusion repeats', () => {
      act(() => {
        useHiveStore.getState().reportPrsUnconfigured('no gh on this machine');
      });
      const { prs, prSource } = useHiveStore.getState();
      expect(prs).toEqual([]);

      act(() => {
        useHiveStore.getState().reportPrsUnconfigured('no gh on this machine');
      });

      expect(useHiveStore.getState().prs).toBe(prs);
      expect(useHiveStore.getState().prSource).toBe(prSource);
    });

    it('replaces the conclusion when its explanation changed', () => {
      act(() => {
        useHiveStore.getState().reportPrsUnconfigured('no gh on this machine');
      });
      const before = useHiveStore.getState().prSource;

      act(() => {
        useHiveStore.getState().reportPrsUnconfigured('gh is not logged in');
      });

      expect(useHiveStore.getState().prSource).not.toBe(before);
      expect(useHiveStore.getState().prSource).toMatchObject({
        kind: 'unconfigured',
        message: 'gh is not logged in',
      });
    });

    /** A first failure after a live sweep still has to raise the banner. */
    it('still flips a live source to stale', () => {
      const before = useHiveStore.getState().prSource;

      act(() => {
        useHiveStore.getState().reportPrFailure('gh timed out');
      });

      expect(useHiveStore.getState().prSource).not.toBe(before);
      expect(useHiveStore.getState().prSource).toMatchObject({ stale: true });
    });

    it('replaces the source when the repository count changed', () => {
      const before = useHiveStore.getState().prSource;

      act(() => {
        useHiveStore.getState().hydratePrs(resweep(), 4);
      });

      expect(useHiveStore.getState().prSource).not.toBe(before);
      expect(useHiveStore.getState().prSource).toMatchObject({ repos: 4 });
    });
  });

  /**
   * The fleet table's `PR` column, and the meta bar's chip (HIVE-100).
   *
   * Both read `Session.pr` until this story, and `Session.pr` was never once
   * written — not by `spawnSession`, not by a hook, not by any IPC payload. So
   * the column showed `—` on every row of every real fleet, which is exactly
   * what "this branch has no pull request" looks like. It took a user
   * screenshot to notice.
   *
   * The resolution is `usePrs()` run backwards: branch first, repository to
   * break a cross-repo tie.
   */
  describe('useSessionPr', () => {
    it('resolves the PR on the session’s branch', () => {
      const { result } = renderHook(() => useSessionPr('hero-refresh'));

      expect(result.current).toEqual({
        n: 482,
        state: 'open',
        url: 'https://github.com/demo/nova-web/pull/482',
      });
    });

    it('answers null when no PR is on the branch', () => {
      // `fix/lead-form-validation` carries no record in the fixture.
      const { result } = renderHook(() => useSessionPr('lead-form'));

      expect(result.current).toBeNull();
    });

    it('answers null for an unknown id, and for an agent', () => {
      expect(renderHook(() => useSessionPr('nope')).result.current).toBeNull();
      expect(
        renderHook(() => useSessionPr('slack-agent')).result.current,
      ).toBeNull();
    });

    /**
     * HIVE-78's guard, restated: a session whose branch nobody has observed
     * owns no pull request. Without it an `undefined` branch would compare
     * against records and match nothing — the right answer reached by luck
     * rather than by rule.
     */
    it('answers null while the branch is unobserved', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          entities: {
            ...state.entities,
            'hero-refresh': {
              ...(state.entities['hero-refresh'] as Session),
              branch: undefined,
            },
          },
        }));
      });

      const { result } = renderHook(() => useSessionPr('hero-refresh'));

      expect(result.current).toBeNull();
    });

    /**
     * The cross-repo case `sessionForPr` exists for, seen from the other side:
     * one branch name, two repositories, two pull requests. Resolving by branch
     * alone would hand the frontend session the backend's PR — and the link
     * would open the wrong page, which is worse than opening none.
     */
    it('breaks a two-repo branch collision on the project', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          prs: [
            ...state.prs,
            {
              number: 9001,
              title: 'Same branch, other repo',
              url: 'https://github.com/demo/referral-api/pull/9001',
              repo: 'referral-api',
              owner: 'demo',
              branch: 'feat/hero-refresh',
              state: 'open',
              findings: 0,
              checks: 'passing',
              updatedAt: '2026-08-10T09:00:00Z',
            } satisfies PrRecord,
          ],
        }));
      });

      const { result } = renderHook(() => useSessionPr('hero-refresh'));

      // Newer by `updatedAt`, and still not this session's — `nova-web` is.
      expect(result.current?.n).toBe(482);
    });

    /**
     * When the repository cannot disambiguate — a checkout named differently
     * from its repo, which the *disambiguate, do not filter* rule deliberately
     * tolerates — the newest record wins rather than whichever GitHub happened
     * to return first.
     */
    it('takes the most recently updated when the project cannot decide', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          prs: [
            ...state.prs.filter((pr) => pr.number !== 482),
            {
              number: 482,
              title: 'Older',
              url: 'https://github.com/demo/checkout-named-otherwise/pull/482',
              repo: 'checkout-named-otherwise',
              owner: 'demo',
              branch: 'feat/hero-refresh',
              state: 'open',
              findings: 0,
              checks: 'passing',
              updatedAt: '2026-08-01T00:00:00Z',
            } satisfies PrRecord,
            {
              number: 700,
              title: 'Newer',
              url: 'https://github.com/demo/checkout-named-otherwise/pull/700',
              repo: 'checkout-named-otherwise',
              owner: 'demo',
              branch: 'feat/hero-refresh',
              state: 'open',
              findings: 0,
              checks: 'passing',
              updatedAt: '2026-08-20T00:00:00Z',
            } satisfies PrRecord,
          ],
        }));
      });

      const { result } = renderHook(() => useSessionPr('hero-refresh'));

      expect(result.current?.n).toBe(700);
    });

    /**
     * A branch that just landed and was reused carries both records for a day
     * — the panel keeps merged PRs for 24 hours. The fleet table's subject is
     * the work in front of you, so the live one wins even though the merged one
     * is newer.
     */
    it('prefers a live PR over a merged one, however recent the merge', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          prs: [
            ...state.prs,
            {
              number: 999,
              title: 'Landed an hour ago',
              url: 'https://github.com/demo/nova-web/pull/999',
              repo: 'nova-web',
              owner: 'demo',
              branch: 'feat/hero-refresh',
              state: 'merged',
              findings: 0,
              checks: 'passing',
              updatedAt: '2099-01-01T00:00:00Z',
            } satisfies PrRecord,
          ],
        }));
      });

      const { result } = renderHook(() => useSessionPr('hero-refresh'));

      expect(result.current?.n).toBe(482);
    });
  });

  /**
   * Whether the fleet table holds its Resume column open (HIVE-100).
   *
   * One answer for the whole table, because a column that some rows reserve and
   * others do not is not a column — the header can then be over at most one
   * kind of row, which is the misalignment this story was reported for.
   */
  describe('useHasResumable', () => {
    it('is false for a fleet with nothing to resume', () => {
      const { result } = renderHook(() => useHasResumable());

      expect(result.current).toBe(false);
    });

    it('is true once an ended session is resumable', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          entities: {
            ...state.entities,
            'tz-fix': {
              ...(state.entities['tz-fix'] as Session),
              status: 'done',
              resumable: true,
            },
          },
        }));
      });

      const { result } = renderHook(() => useHasResumable());

      expect(result.current).toBe(true);
    });

    /**
     * A *live* session that happens to carry the flag reserves nothing: the
     * row's own control is gated on `ended` too, so a column held open for it
     * would be permanently empty and permanently wrong.
     */
    it('ignores a live session carrying the flag', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          entities: {
            ...state.entities,
            'hero-refresh': {
              ...(state.entities['hero-refresh'] as Session),
              resumable: true,
            },
          },
        }));
      });

      const { result } = renderHook(() => useHasResumable());

      expect(result.current).toBe(false);
    });
  });
});
