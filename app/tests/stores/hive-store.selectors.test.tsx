import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Session } from '@/types/entity';

import {
  emptySnapshot,
  type ConfigSnapshot,
} from '../../electron/shared/config-contract';
import {
  resetProjectConfig,
  setProjectConfigForTest,
} from '@lib/project-config';

import {
  useActiveEntity,
  useAgentOrder,
  useCounts,
  useEntity,
  useHiveStore,
  useMarkRead,
  useNavOrder,
  useNotifs,
  useProjects,
  useProjectSessions,
  usePrs,
  useTicketCount,
  useTicketPrs,
  useTickets,
  useUnreadCount,
} from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { seedDemoFleet } from '@tests/support/demo-fleet';

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
      const { result } = renderHook(() => useProjectSessions('apfm-web'));

      // hero-refresh, lead-form, e2e-quote — all apfm-web and none done.
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
      const { result } = renderHook(() => useProjectSessions('apfm-web'));

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
              project: 'apfm-web',
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
            pr.number === 482 ? { ...pr, repo: 'apfm-web-renamed' } : pr,
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
          repo: 'apfm-web',
          state: 'open',
          findings: 2,
          url: 'https://github.com/demo/apfm-web/pull/482',
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
        useHiveStore.setState({ prs: [twin('apfm-web'), twin('referral-api')] });
      });

      const { result } = renderHook(() => useTicketPrs('GRAC-3018'));

      expect(result.current.map((pr) => pr.repo)).toEqual([
        'apfm-web',
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
    it('counts the unread fixtures', () => {
      const { result } = renderHook(() => useUnreadCount());
      expect(result.current).toBe(3);
    });

    it('drops to zero once everything is read', () => {
      const { result } = renderHook(() => useUnreadCount());

      act(() => {
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
        { id: 'the-hive', name: 'The Hive', icon: 'ph-folder' },
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
    it('useNotifs returns the inbox in order', () => {
      const { result } = renderHook(() => useNotifs());

      expect(result.current).toHaveLength(5);
      expect(result.current[0].title).toBe('lead-form needs approval');
    });

    it('usePrs returns the seeded PRs, in order', () => {
      const { result } = renderHook(() => usePrs());

      expect(result.current.map((pr) => pr.n)).toEqual([482, 219, 495, 31, 77]);
    });

    it('useMarkRead marks exactly one notification read', () => {
      const { result } = renderHook(() => ({
        markRead: useMarkRead(),
        notifs: useNotifs(),
      }));

      act(() => {
        result.current.markRead(0);
      });

      expect(result.current.notifs[0].unread).toBe(false);
      expect(result.current.notifs[1].unread).toBe(true);
    });
  });
});
