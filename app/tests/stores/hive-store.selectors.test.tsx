import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  useFeed,
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

/**
 * Every selector hook is asserted against the fixtures. Derived values are
 * computed in selectors and never stored, so these tests are the only place
 * the expected numbers are written down twice — which is the point: a fixture
 * change that silently shifts a header count fails here.
 */
describe('hive-store selectors', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
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

  describe('useTicketPrs', () => {
    it('returns the PRs reachable from a ticket\'s sessions', () => {
      const { result } = renderHook(() => useTicketPrs('GRAC-3018'));

      expect(result.current).toEqual([
        {
          n: 482,
          repo: 'apfm-web',
          state: 'open',
          findings: 2,
          session: 'hero-refresh',
        },
      ]);
    });

    it('returns nothing when no session has a PR', () => {
      // GRAC-3010 covers nplusone and e2e-quote, neither of which has a PR.
      const { result } = renderHook(() => useTicketPrs('GRAC-3010'));
      expect(result.current).toEqual([]);
    });

    /**
     * The global list is the single source of truth. Fixture #219 is `approved`
     * there but still `open` on the `webhooks` session — the stale copy must
     * lose.
     */
    it('prefers the global list over the session\'s stale copy', () => {
      const { result } = renderHook(() => useTicketPrs('GRAC-2991'));

      expect(result.current[0].state).toBe('approved');
      expect(useHiveStore.getState().entities['webhooks']).toMatchObject({
        pr: { n: 219, state: 'open' },
      });
    });

    /**
     * The gap this selector was rewritten to close. `ecs-scaling` carries PR
     * #31, which the global `prs` list has never heard of; filtering that list
     * dropped GRAC-2954's PR section entirely.
     */
    it('falls back to the session\'s own pr when the global list lacks it', () => {
      expect(
        useHiveStore.getState().prs.some((pr) => pr.n === 31),
      ).toBe(false);

      const { result } = renderHook(() => useTicketPrs('GRAC-2954'));

      expect(result.current).toEqual([
        {
          n: 31,
          repo: 'infra-terraform',
          state: 'merged',
          findings: 0,
          session: 'ecs-scaling',
        },
      ]);
    });

    it('skips sessions the store does not know', () => {
      act(() => {
        useHiveStore.setState({
          tickets: [
            {
              key: 'GHOST-1',
              status: 'To Do',
              statusCategory: 'todo',
              title: 'Names a session that never existed',
              sessions: ['not-a-session', 'hero-refresh'],
            },
          ],
        });
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

    it('returns the five fixture projects in fixture order', () => {
      const { result } = renderHook(() => useProjects());

      expect(result.current.map((project) => project.id)).toEqual([
        'apfm-web',
        'referral-api',
        'advisor-portal',
        'design-system',
        'infra-terraform',
      ]);
    });

    it('carries each project’s icon name', () => {
      const { result } = renderHook(() => useProjects());

      expect(result.current[0].icon).toBe('ph-globe-hemisphere-west');
    });

    describe('the merge rule (story 101)', () => {
      it('returns the fixtures unchanged when there is no snapshot', () => {
        setProjectConfigForTest(null);

        const { result } = renderHook(() => useProjects());

        expect(result.current).toHaveLength(5);
        expect(result.current.every((row) => row.source === 'demo')).toBe(true);
      });

      it('returns the fixtures unchanged when the snapshot declares no projects', () => {
        setProjectConfigForTest(configured([]));

        const { result } = renderHook(() => useProjects());

        expect(result.current).toHaveLength(5);
        expect(result.current.every((row) => row.source === 'demo')).toBe(true);
      });

      it('names a demo row by its id, which is what it has always shown', () => {
        setProjectConfigForTest(null);

        const { result } = renderHook(() => useProjects());

        expect(result.current[0].name).toBe('apfm-web');
      });

      it('returns config projects plus fixture projects that still own sessions', () => {
        setProjectConfigForTest(configured([{ id: 'the-hive', name: 'The Hive' }]));

        const { result } = renderHook(() => useProjects());
        const rows = result.current;

        expect(rows[0]).toMatchObject({
          id: 'the-hive',
          name: 'The Hive',
          source: 'config',
        });
        // apfm-web owns fixture sessions, so dropping it would strand them.
        expect(rows.find((row) => row.id === 'apfm-web')?.source).toBe('demo');
      });

      it('drops fixture projects that own no sessions', () => {
        setProjectConfigForTest(configured([{ id: 'the-hive' }]));

        const { result } = renderHook(() => useProjects());
        const owning = new Set(
          Object.values(useHiveStore.getState().entities)
            .filter((entity) => entity.kind === 'session')
            .map((entity) => (entity as { project: string }).project),
        );

        for (const row of result.current.filter((r) => r.source === 'demo')) {
          expect(owning.has(row.id)).toBe(true);
        }
      });

      it('collapses a shared id to one row, config winning', () => {
        setProjectConfigForTest(configured([{ id: 'apfm-web', name: 'My APFM' }]));

        const { result } = renderHook(() => useProjects());
        const rows = result.current.filter((row) => row.id === 'apfm-web');

        // The upgrade path for anyone who already mapped apfm-web under 090.
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ source: 'config', name: 'My APFM' });
      });

      it('preserves config file order and never sorts', () => {
        setProjectConfigForTest(configured([{ id: 'zeta' }, { id: 'alpha' }]));

        const { result } = renderHook(() => useProjects());
        const ids = result.current
          .filter((row) => row.source === 'config')
          .map((row) => row.id);

        // Story 103's drag-reorder rewrites this array and the left rail reads
        // it positionally. Sorting here would make that story unimplementable.
        expect(ids).toEqual(['zeta', 'alpha']);
      });
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

    it('usePrs returns the four fixture PRs', () => {
      const { result } = renderHook(() => usePrs());

      expect(result.current.map((pr) => pr.n)).toEqual([482, 219, 495, 77]);
    });

    it('useFeed returns the seeded feed newest-first', () => {
      const { result } = renderHook(() => useFeed());

      expect(result.current).toHaveLength(7);
      expect(result.current[0].time).toBe('14:37');
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
