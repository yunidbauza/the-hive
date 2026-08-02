import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  useActiveEntity,
  useAgentOrder,
  useCounts,
  useEntity,
  useHiveStore,
  useNavOrder,
  useProjects,
  useProjectSessions,
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

      // 4 working, 2 waiting, 2 idle, 2 done — 8 active and 2 done overall.
      expect(result.current).toEqual({
        working: 4,
        waiting: 2,
        idle: 2,
        done: 2,
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
});
