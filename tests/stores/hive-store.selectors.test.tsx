import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { terminalOf, type Agent, type Entity, type Session, type Terminal } from '@/types/entity';
import type { AgentSummary } from '@shared/agent-contract';
import { LEDGER_MEMORY_CAP, type LedgerEntry } from '@shared/ledger-contract';
import type { NotificationKind } from '@shared/notification-contract';
import type { PlanTaskStatus, SessionPlan } from '@shared/plan-contract';

import {
  emptySnapshot,
  type ConfigSnapshot,
} from '../../electron/shared/config-contract';
import type { PrRecord, PrTimeline } from '../../electron/shared/github-contract';
import {
  resetProjectConfig,
  setProjectConfigForTest,
} from '@lib/project-config';

import {
  accountLimitsOf,
  agentWorksIn,
  currentRowFor,
  flapCountsOf,
  fleetGroupsOf,
  type FleetView,
  repoDirName,
  useActiveEntity,
  useActiveSessions,
  useCurrentRow,
  useAskingAgentCount,
  useWorkingAgentCount,
  useAgentLive,
  useAgentLiveCount,
  useDelegateTitle,
  useDelegateWord,
  useAgentPr,
  useCounts,
  useFleetAgents,
  useEndedMore,
  useFleetGroup,
  useFleetNavOrder,
  useAgentsWorkingIn,
  useOvermindHeadCounts,
  useProjectCounts,
  useSessionsHeadCounts,
  useEntity,
  useHasResumable,
  useHiveStore,
  useEndedSessions,
  useNavOrder,
  useChangedFileCount,
  useChangedFileMark,
  useChangedFiles,
  usePlan,
  usePlanProgress,
  useProjects,
  useProjectSessions,
  usePrs,
  usePrsQuiet,
  useAgentsListed,
  usePrsListed,
  useSessionsListed,
  useWorkListed,
  useHatchery,
  useHatcherySearch,
  usePrNeedsYouCount,
  usePrFlapCounts,
  useSessionPr,
  useSessionPrRow,
  useNextTransition,
  useOpenTicket,
  useTicketEvents,
  useTicketGroups,
  useTicketPrs,
  useTicketProperties,
  useTickets,
  useTicketSessions,
  useUnreadCount,
  useEchoes,
  useSummons,
  useSummonsCount,
  useYoursAgain,
  useCombEntities,
  useCombSummary,
  useCommentOnPr,
  useHolderPost,
  useLoadPrDetail,
  useChecksGraph,
  usePrChecks,
  usePrChecksActions,
  usePrDetail,
  usePushes,
  useShownJob,
  usePrEvents,
  usePrOpener,
  useReviewUrls,
  useShipTrack,
  useLoadPrTimeline,
  usePrTimelineEntry,
  useTimelineModel,
  useAccountLimits,
  useComingUp,
  useWhileAway,
  whileAwayOf,
} from '@stores/hive-store';
import { useUiStore } from '@stores/ui-store';
import { notif } from '../support/notifications';
import { seedDemoFleet, seedDemoProjectConfig } from '@tests/support/demo-fleet';

import { testProjectKey } from '@tests/support/project-key';
import { prRecord } from '@tests/support/prs';
import type { JiraIssue } from '@shared/jira-contract';

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
        // HIVE-87. No fixture is `closed` either: only a record read back
        // from the session history at boot produces one, and nothing seeds
        // the session history here.
      });
    });

    /**
     * A quiet main agent with something still running counts as **working**.
     *
     * The status field stays `idle` — that is what a hook observed — but this
     * tally is read directly beside the rows it describes, and those rows say
     * `working (agents)` in green. Bucketing on the raw status put three green
     * `working` rows under a header reading `0 working · 3 idle`.
     */
    it('buckets a quiet session with something running as working', () => {
      act(() => {
        useHiveStore
          .getState()
          .setSessionStatus('rails-upgrade', 'idle', 'agents');
        useHiveStore.getState().setSessionStatus('e2e-quote', 'idle', 'script');
      });

      const { result } = renderHook(() => useCounts());

      expect(result.current).toMatchObject({ working: 6, idle: 0 });
    });

    /** A genuinely free session — nothing running at all — is still idle. */
    it('leaves a plain idle session in the idle bucket', () => {
      act(() => {
        useHiveStore.getState().setSessionStatus('rails-upgrade', 'idle');
      });

      const { result } = renderHook(() => useCounts());

      expect(result.current).toMatchObject({ working: 4, idle: 2 });
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

      /*
        The demo fleet seeds three agents, and HIVE-117 put them in the table
        between the two session groups — so they are in this order too, in the
        rank `useFleetAgents` applies.
      */
      expect(result.current).toEqual([
        'hero-refresh',
        'lead-form',
        'webhooks',
        'rails-upgrade',
        'call-notes',
        'dark-tokens',
        'e2e-quote',
        'nplusone',
        'pr-reviewer',
        'slack-agent',
        'standup-agent',
        'tz-fix',
        'ecs-scaling',
      ]);
    });

    /**
     * Agents **are** in the order, since HIVE-117 put them in the table.
     *
     * This assertion used to be `not.toContain`, and it was right while the
     * fleet table drew sessions only. Once an agent row renders the caret and
     * sets `selId` on click, leaving it out of this list makes it selectable
     * and unreachable at once: `↓` from an agent teleported to the first
     * session, `↑` to the last ended row, and `→` opened nothing, because
     * `console-input.tsx` gates opening on membership here.
     */
    it('includes agents, between the two session groups', () => {
      const { result } = renderHook(() => useNavOrder());

      const agentAt = result.current.indexOf('slack-agent');

      expect(agentAt).toBeGreaterThan(-1);
      // After the last active session, before the first ended one.
      expect(agentAt).toBeGreaterThan(result.current.indexOf('nplusone'));
      expect(agentAt).toBeLessThan(result.current.indexOf('tz-fix'));
    });

    /**
     * The caret walks the table, so this has to flatten in exactly the order
     * the table paints — active before ended, and each group newest-first.
     *
     * A partition that flattened differently from the one on screen makes the
     * down arrow skip a row and come back to it, which is the failure this
     * selector exists to prevent.
     */
    it('walks each group newest-first, matching what the table paints', () => {
      act(() => {
        useHiveStore.getState().hydrateSessions([
          {
            id: 'old-oldest',
            project: 'nova-web',
            task: '',
            status: 'terminated',
            createdAt: 1,
            endedAt: 1_000,
          },
          {
            id: 'old-newest',
            project: 'nova-web',
            task: '',
            status: 'terminated',
            createdAt: 1,
            endedAt: 9_000,
          },
        ]);
      });

      const { result } = renderHook(() => ({
        nav: useNavOrder(),
        active: useActiveSessions(),
        agents: useFleetAgents(),
        ended: useEndedSessions(),
      }));
      const { nav, active, agents, ended } = result.current;

      // The three groups the table paints, in the order it paints them.
      expect(nav).toEqual([...active, ...agents, ...ended]);
      // Restored in oldest-first session-history order, walked newest-first.
      expect(nav.indexOf('old-newest')).toBeLessThan(nav.indexOf('old-oldest'));
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

      /*
        Seven still running, then the demo fleet's three agents, then the three
        that have ended. `hero-refresh` is first among the endings because it is
        the only one with a time on it — `stampLifecycle` stamped `endedAt` as
        it crossed into `terminated`, while the two fixture rows carry none and
        hold their fixture order below it. An absent time sorts last rather than
        first, so an unknown never claims to be the newest thing on the table.
      */
      expect(result.current.slice(10)).toEqual([
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

  describe('the Hatchery (HIVE-215)', () => {
    const shipper = (id: string, n: number, stage: string): LedgerEntry => ({
      id, ts: Date.now(), from: 'shipper', kind: 'post', body: 'stage', meta: { pr: n, repo: 'acme/nova-web', stage },
    });

    beforeEach(() => {
      act(() => {
        useHiveStore.setState({
          prSource: { kind: 'live', stale: false, repos: 1 },
          prs: [
            prRecord({ number: 1, findings: 0, checks: 'passing', branch: 'b1' }),
            prRecord({ number: 2, findings: 2, branch: 'b2' }),
            prRecord({ number: 3, findings: 0, state: 'draft', branch: 'b3' }),
            prRecord({ number: 4, findings: 0, branch: 'b4' }),
          ],
          ledger: [shipper('l1', 4, 'merge')],
        });
      });
    });

    it('usePrFlapCounts agrees with useHatchery, in rank order (HIVE-200)', () => {
      const rows = renderHook(() => useHatchery()).result.current;
      const { result } = renderHook(() => usePrFlapCounts());
      expect(result.current).toEqual(flapCountsOf(rows));
      expect(result.current.map((c) => [c.flap, c.count])).toEqual([
        ['SUMMONS', 1],
        ['HATCHING', 1],
        ['BURROWED', 1],
        ['LARVA', 1],
      ]);
      expect(result.current[0]?.tone).toBe('amber');
    });

    it('usePrFlapCounts is empty unless the source is live (HIVE-200)', () => {
      act(() => useHiveStore.setState({ prSource: { kind: 'loading' } }));
      expect(renderHook(() => usePrFlapCounts()).result.current).toEqual([]);
    });

    it('usePrFlapCounts holds its identity across terminal output (HIVE-200)', () => {
      const { result } = renderHook(() => usePrFlapCounts());
      const first = result.current;
      act(() =>
        useHiveStore.getState().appendEntityLines('hero-refresh', [{ text: 'more', color: 'ink' }]),
      );
      expect(result.current).toBe(first);
    });

    it('lists every swept PR with its status, in the Hatchery\'s order', () => {
      const { result } = renderHook(() => useHatchery());
      expect(result.current.map((row) => [row.pr.n, row.hatch.flap])).toEqual([
        [2, 'SUMMONS'],
        [4, 'HATCHING'],
        [1, 'BURROWED'],
        [3, 'LARVA'],
      ]);
    });

    it('reads an ask to the overmind naming a PR as SUMMONS', () => {
      act(() => {
        useHiveStore.setState((state) => ({
          ledger: [...state.ledger, { id: 'a1', ts: Date.now(), from: 'shipper', kind: 'ask', to: 'overmind', body: 'PR #1 waits on a review', meta: { pr: 1, repo: 'acme/nova-web' } }],
        }));
      });
      const { result } = renderHook(() => useHatchery());
      expect(result.current.find((row) => row.pr.n === 1)?.hatch.flap).toBe('SUMMONS');
    });

    it('returns an equal list when the ledger grows by an entry naming no PR', () => {
      const { result } = renderHook(() => useHatchery());
      const before = result.current;
      act(() => {
        useHiveStore.setState((state) => ({
          ledger: [...state.ledger, { id: 'z1', ts: Date.now(), from: 'sess-a', kind: 'post', body: 'hello' }],
        }));
      });
      expect(result.current).toEqual(before);
    });

    it('useHatcherySearch is null with no search, and never summons for others', () => {
      const { result } = renderHook(() => useHatcherySearch());
      expect(result.current).toBeNull();
      act(() => {
        useHiveStore.setState((state) => ({
          prSearch: { ...state.prSearch, results: [prRecord({ number: 9, findings: 3, mine: false })] },
        }));
      });
      expect(result.current?.map((row) => row.hatch.flap)).toEqual(['BURROWED']);
    });

    it('usePrNeedsYouCount counts SUMMONS over the sweep', () => {
      const { result } = renderHook(() => usePrNeedsYouCount());
      expect(result.current).toBe(1);
    });

    it.each([
      ['loading', { kind: 'loading' }],
      ['unconfigured', { kind: 'unconfigured', message: 'x', reason: 'not-installed' }],
      ['failed', { kind: 'failed', message: 'x' }],
    ] as const)('usePrNeedsYouCount is 0 while %s', (_name, prSource) => {
      act(() => useHiveStore.setState({ prSource }));
      const { result } = renderHook(() => usePrNeedsYouCount());
      expect(result.current).toBe(0);
    });

    it('usePrNeedsYouCount is 0 with no PRs', () => {
      act(() => useHiveStore.setState({ prs: [] }));
      const { result } = renderHook(() => usePrNeedsYouCount());
      expect(result.current).toBe(0);
    });
  });

  describe('usePrs', () => {
    it('carries updatedAt, mergedAt and mine through (HIVE-215)', () => {
      act(() => {
        useHiveStore.setState({
          prs: [prRecord({ number: 7, state: 'merged', mergedAt: '2026-08-09T11:32:00Z', mine: true })],
        });
      });

      const { result } = renderHook(() => usePrs());

      expect(result.current[0]).toMatchObject({
        n: 7,
        updatedAt: '2026-08-09T12:00:00Z',
        mergedAt: '2026-08-09T11:32:00Z',
        mine: true,
      });
    });

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
              mergedAt: null,
              mine: true,
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
              priority: null,
              assignee: null,
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
              mergedAt: null,
              mine: true,
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
              priority: null,
              assignee: null,
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
              mergedAt: null,
              mine: true,
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
              priority: null,
              assignee: null,
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
              mergedAt: null,
              mine: true,
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
        mergedAt: null,
        mine: true,
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
              priority: null,
              assignee: null,
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

  describe('useEchoes (HIVE-231)', () => {
    it('keeps the news, newest first, and none of what waits on you', () => {
      act(() => {
        useHiveStore.setState({ notifs: [], ledger: [], closedAsks: new Set() });
        useHiveStore.getState().hydrateNotifs([
          notif({ id: 'u', kind: 'app.update_available', action: { type: 'update.download' }, createdAt: 3 }),
          notif({ id: 'q', kind: 'agent.ask', action: { type: 'ask', thread: 'q' }, createdAt: 2 }),
          notif({ id: 'm', kind: 'pr.merged', action: { type: 'none' }, createdAt: 1 }),
        ]);
      });

      expect(renderHook(() => useEchoes()).result.current.map((n) => n.id)).toEqual(['u', 'm']);
    });
  });

  describe('useSummons and useSummonsCount (HIVE-214)', () => {
    const ask = (id: string, kind: 'agent.ask' | 'agent.permission' = 'agent.ask') =>
      notif({ id, kind, action: { type: 'ask', thread: id } });
    const blocked = (id: string, terminal: string) =>
      notif({ id, kind: 'session.blocked', action: { type: 'session', entityId: terminal } });
    const closing = (id: string, kind: 'answer' | 'done' | 'failed', thread: string): LedgerEntry =>
      ({ id, ts: 1, from: 'sess-a', kind, body: '', thread });

    beforeEach(() => {
      act(() => useHiveStore.setState({ notifs: [], ledger: [], closedAsks: new Set() }));
    });

    it('splits asks from sessions waiting on you, newest first, and ignores news', () => {
      act(() => {
        useHiveStore.getState().hydrateNotifs([
          { ...ask('q1'), createdAt: 3 },
          { ...blocked('b1', 'term-1'), createdAt: 2 },
          { ...ask('p1', 'agent.permission'), createdAt: 1 },
          notif({ id: 'i', kind: 'session.idle', action: { type: 'session', entityId: 'term-2' } }),
          notif({ id: 'm', kind: 'pr.merged', action: { type: 'none' } }),
        ]);
      });

      const { result } = renderHook(() => useSummons(null));
      expect(result.current.asks.map((n) => n.id)).toEqual(['q1', 'p1']);
      // A session that is yours again waits on you too (6 Oct 2026).
      expect(result.current.sessions.map((n) => n.id)).toEqual(['i', 'b1']);

      const count = renderHook(() => useSummonsCount(null));
      expect(count.result.current).toBe(4);
    });

    it('counts a session once after its input_needed row superseded its idle row', () => {
      const action = { type: 'session', entityId: 'term-2' } as const;
      act(() => {
        useHiveStore.getState().hydrateNotifs([
          notif({ id: 'i', kind: 'session.idle', action }),
          notif({ id: 'n', kind: 'session.input_needed', action }),
        ]);
        // What the hub announces when the notifier supersedes the idle row.
        useHiveStore.getState().applyDismiss('i');
      });

      const { result } = renderHook(() => useSummons(null));
      expect(result.current.sessions.map((n) => n.id)).toEqual(['n']);
      expect(renderHook(() => useSummonsCount(null)).result.current).toBe(1);
    });

    it.each(['answer', 'done', 'failed'] as const)('drops an ask closed by %s', (kind) => {
      act(() => {
        useHiveStore.getState().hydrateNotifs([ask('q1')]);
        useHiveStore.getState().hydrateLedger([closing('x1', kind, 'q1')]);
      });

      expect(renderHook(() => useSummonsCount(null)).result.current).toBe(0);
    });

    it('drops an ask the overmind expired', () => {
      act(() => {
        useHiveStore.getState().hydrateNotifs([ask('q1')]);
        useHiveStore.getState().hydrateLedger([
          { id: 'e1', ts: 1, from: 'overmind', kind: 'event', body: 'ask q1 expired', thread: 'q1', meta: { expired: 'q1' } },
        ]);
      });

      expect(renderHook(() => useSummons(null)).result.current.asks).toEqual([]);
    });

    it('keeps an ask whose ask entry is not in the ledger mirror', () => {
      act(() => {
        useHiveStore.getState().hydrateNotifs([ask('q-old')]);
        useHiveStore.getState().hydrateLedger([closing('x1', 'answer', 'q-other')]);
      });

      expect(renderHook(() => useSummonsCount(null)).result.current).toBe(1);
    });

    it('keeps an ask closed after its closing entry rolls out of the mirror', () => {
      act(() => {
        useHiveStore.getState().hydrateNotifs([ask('q1')]);
        useHiveStore.getState().ledgerAppend(closing('x1', 'answer', 'q1'));
      });
      expect(renderHook(() => useSummonsCount(null)).result.current).toBe(0);

      act(() => {
        for (let i = 0; i < LEDGER_MEMORY_CAP; i += 1) {
          useHiveStore.getState().ledgerAppend({ id: `y${String(i).padStart(4, '0')}`, ts: 1, from: 'a', kind: 'post', body: '' });
        }
      });

      expect(useHiveStore.getState().ledger.some((entry) => entry.id === 'x1')).toBe(false);
      expect(renderHook(() => useSummonsCount(null)).result.current).toBe(0);
    });

    it('a close older than the mirror still closes the ask, via the snapshot (HIVE-198)', () => {
      act(() => {
        useHiveStore.getState().hydrateNotifs([ask('a1')]);
        // The entries lack both the ask and its answer: they rolled out of main's tail.
        useHiveStore.getState().hydrateLedger([], ['a1']);
      });

      expect(renderHook(() => useSummonsCount(null)).result.current).toBe(0);
    });

    it('merges closed threads from the snapshot rather than replacing them (HIVE-198)', () => {
      act(() => {
        useHiveStore.getState().hydrateLedger([], ['a1']);
        useHiveStore.getState().hydrateLedger([], ['a2']);
      });

      expect([...useHiveStore.getState().closedAsks].sort()).toEqual(['a1', 'a2']);
    });

    it('leaves out the session on stage, and counts it for the dock', () => {
      act(() => {
        useHiveStore.getState().hydrateNotifs([blocked('b1', 'term-1'), blocked('b2', 'term-2')]);
      });

      expect(renderHook(() => useSummons('term-1')).result.current.sessions.map((n) => n.id)).toEqual(['b2']);
      expect(renderHook(() => useSummonsCount('term-1')).result.current).toBe(1);
      expect(renderHook(() => useSummonsCount(null)).result.current).toBe(2);
    });
  });

  describe('useCurrentRow (HIVE-198)', () => {
    it('resolves a terminal to the row currentRowFor names', () => {
      const row: Session = {
        kind: 'session',
        id: 'sess-row',
        terminalId: 'term-row',
        project: 'the-hive',
        status: 'idle',
        task: 'x',
        cost: '$0.00',
        lines: [],
      };
      act(() => useHiveStore.setState({ entities: { 'sess-row': row }, order: ['sess-row'] }));

      expect(currentRowFor('term-row')).toBe('sess-row');
      expect(renderHook(() => useCurrentRow('term-row')).result.current).toBe('sess-row');
    });
  });

  describe('useYoursAgain (HIVE-214)', () => {
    beforeEach(() => {
      act(() => useHiveStore.setState({ notifs: [] }));
    });

    it.each(['session.idle', 'session.input_needed'] as const)('is true on an unswept %s row', (kind) => {
      act(() => {
        useHiveStore.getState().hydrateNotifs([
          notif({ id: 'y', kind, action: { type: 'session', entityId: 'term-1' } }),
        ]);
      });

      const { result } = renderHook(() => useYoursAgain('term-1'));
      expect(result.current).toBe(true);

      act(() => {
        useHiveStore.getState().applyDismiss('y');
      });
      expect(result.current).toBe(false);
    });

    it('is false for another terminal', () => {
      act(() => {
        useHiveStore.getState().hydrateNotifs([
          notif({ id: 'y', kind: 'session.idle', action: { type: 'session', entityId: 'term-2' } }),
        ]);
      });

      expect(renderHook(() => useYoursAgain('term-1')).result.current).toBe(false);
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

  describe('useDelegateWord and useDelegateTitle (idle with agents)', () => {
    const agent = (name: string): AgentSummary => ({
      name,
      description: 'Ships.',
      icon: 'Robot',
      status: 'sleeping',
      wake: { on: [] },
      mcp: [],
      tools: [],
      rotateAfter: 50,
      runs: [],
    });
    const at = (id: string) => useHiveStore.getState().entities[id] as Session;
    const ask = (id: string, from: string, to: string): LedgerEntry => ({
      id,
      ts: Date.now(),
      from,
      to,
      kind: 'ask',
      body: 'ship it',
      meta: { pr: 106, repo: 'behiques/hivetty' },
    });

    beforeEach(() => {
      act(() => {
        useHiveStore.getState().hydrateAgents([agent('shipper'), agent('fixer')]);
        useHiveStore.getState().setSessionStatus('hero-refresh', 'idle');
      });
    });

    it('names the agent a quiet session asked, and who it brought in', () => {
      const party = terminalOf(at('hero-refresh'));
      act(() => useHiveStore.getState().ledgerAppend(ask('20261006-0001', party, 'shipper')));
      act(() => useHiveStore.getState().ledgerAppend(ask('20261006-0002', 'shipper', 'fixer')));

      expect(renderHook(() => useDelegateWord(at('hero-refresh'))).result.current).toBe('shipper');
      expect(renderHook(() => useDelegateTitle(at('hero-refresh'))).result.current).toBe('Waiting on shipper (with fixer)');
    });

    it('says nothing once the job closes, or while the session works', () => {
      const party = terminalOf(at('hero-refresh'));
      act(() => useHiveStore.getState().ledgerAppend(ask('20261006-0001', party, 'shipper')));
      act(() => useHiveStore.getState().setSessionStatus('hero-refresh', 'working'));
      expect(renderHook(() => useDelegateWord(at('hero-refresh'))).result.current).toBeNull();

      act(() => useHiveStore.getState().setSessionStatus('hero-refresh', 'idle'));
      act(() =>
        useHiveStore.getState().ledgerAppend({
          id: '20261006-0003',
          ts: Date.now(),
          from: 'shipper',
          kind: 'done',
          body: 'merged',
          thread: '20261006-0001',
        }),
      );
      expect(renderHook(() => useDelegateWord(at('hero-refresh'))).result.current).toBeNull();
    });

    it('does not count an ask to something that is not an agent', () => {
      const party = terminalOf(at('hero-refresh'));
      act(() => useHiveStore.getState().ledgerAppend(ask('20261006-0001', party, 'nova-web')));
      expect(renderHook(() => useDelegateWord(at('hero-refresh'))).result.current).toBeNull();
    });
  });

  describe('useAgentLive and useAgentLiveCount', () => {
    const summary = (
      name: string,
      over: Partial<AgentSummary> = {},
    ): AgentSummary => ({
      name,
      description: 'Watches.',
      icon: 'Robot',
      status: 'sleeping',
      wake: { on: [] },
      mcp: [],
      tools: [],
      rotateAfter: 50,
      runs: [],
      ...over,
    });

    it('reads the live runs and their count (HIVE-128)', () => {
      useHiveStore.getState().hydrateAgents([
        summary('watcher', { live: [{ run: 'a', kind: 'standing', trigger: 'interval', startedAt: 1 }] }),
      ]);

      expect(renderHook(() => useAgentLive('watcher')).result.current).toHaveLength(1);
      expect(renderHook(() => useAgentLiveCount('watcher')).result.current).toBe(1);
      expect(renderHook(() => useAgentLive('nobody')).result.current).toEqual([]);
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

  describe('list selectors', () => {
    it('usePrs returns the seeded PRs, in order', () => {
      const { result } = renderHook(() => usePrs());

      expect(result.current.map((pr) => pr.n)).toEqual([482, 219, 495, 31, 77]);
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
        useHiveStore.getState().reportPrsUnconfigured('no gh on this machine', 'not-installed');
      });
      const { prs, prSource } = useHiveStore.getState();
      expect(prs).toEqual([]);

      act(() => {
        useHiveStore.getState().reportPrsUnconfigured('no gh on this machine', 'not-installed');
      });

      expect(useHiveStore.getState().prs).toBe(prs);
      expect(useHiveStore.getState().prSource).toBe(prSource);
    });

    it('replaces the conclusion when its explanation changed', () => {
      act(() => {
        useHiveStore.getState().reportPrsUnconfigured('no gh on this machine', 'not-installed');
      });
      const before = useHiveStore.getState().prSource;

      act(() => {
        useHiveStore.getState().reportPrsUnconfigured('gh is not logged in', 'unauthenticated');
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
              mergedAt: null,
              mine: true,
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
              mergedAt: null,
              mine: true,
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
              mergedAt: null,
              mine: true,
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
              mergedAt: '2099-01-01T00:00:00Z',
              mine: true,
            } satisfies PrRecord,
          ],
        }));
      });

      const { result } = renderHook(() => useSessionPr('hero-refresh'));

      expect(result.current?.n).toBe(482);
    });

    /**
     * The fallback the column was empty without.
     *
     * The sweep holds open PRs plus 24 hours of merges, so a session that
     * raised and landed one last Tuesday matches nothing — and `—` is
     * indistinguishable from a branch that never had a PR, which is why it
     * never looked like a bug. `Session.lastPr` is what the app wrote down when
     * it *could* see the PR.
     */
    describe('the remembered PR', () => {
      const remember = (id: string) => {
        act(() => {
          useHiveStore.setState((state) => ({
            entities: {
              ...state.entities,
              [id]: {
                ...(state.entities[id] as Session),
                lastPr: {
                  number: 118,
                  repo: 'nova-web',
                  url: 'https://github.com/demo/nova-web/pull/118',
                },
              },
            },
          }));
        });
      };

      it('fills the cell when the live sweep has nothing on the branch', () => {
        remember('lead-form');

        const { result } = renderHook(() => useSessionPr('lead-form'));

        expect(result.current).toEqual({
          n: 118,
          url: 'https://github.com/demo/nova-web/pull/118',
        });
      });

      /**
       * **No state**, and that is the honest half. A state carried across the
       * gap would be a claim about GitHub that nothing keeps current — and
       * because state is rendered as a colour, it would be the most confident
       * thing in the cell. Both surfaces render a stateless PR neutral and say
       * "last seen" in the words a screen reader gets.
       */
      it('carries no state, so nothing can colour it as if it were live', () => {
        remember('lead-form');

        const { result } = renderHook(() => useSessionPr('lead-form'));

        expect(result.current).not.toHaveProperty('state');
      });

      it('never outranks a live match on the same branch', () => {
        remember('hero-refresh');

        const { result } = renderHook(() => useSessionPr('hero-refresh'));

        // The sweep can see #482 on this branch right now; #118 is a memory.
        expect(result.current).toMatchObject({ n: 482, state: 'open' });
      });

      /**
       * The case that motivates it, end to end: a worktree torn down by
       * `merge-pr` leaves the session observed back on the default branch, so
       * even a live PR has nothing to match against.
       */
      it('survives the branch going home to main after a worktree teardown', () => {
        remember('hero-refresh');
        act(() => {
          useHiveStore.setState((state) => ({
            entities: {
              ...state.entities,
              'hero-refresh': {
                ...(state.entities['hero-refresh'] as Session),
                branch: 'main',
              },
            },
          }));
        });

        const { result } = renderHook(() => useSessionPr('hero-refresh'));

        expect(result.current).toMatchObject({ n: 118 });
      });

      it('answers a row whose branch nobody ever observed', () => {
        remember('hero-refresh');
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

        expect(result.current).toMatchObject({ n: 118 });
      });
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

  /**
   * The fleet table's AGENTS group (HIVE-117).
   *
   * A second ordering beside `useAgentsByGroup`, because that one *groups* into
   * three headings the eye scans between and this one has a single list — so the
   * order has to carry the whole priority by itself.
   */
  describe('useFleetAgents', () => {
    const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
      name: 'slack-watcher',
      description: 'Watches.',
      icon: 'Robot',
      status: 'sleeping',
      wake: { on: [] },
      mcp: [],
      tools: [],
      rotateAfter: 50,
      runs: [],
      ...over,
    });

    it('ranks asking, working, failed, sleeping, then paused', () => {
      act(() => {
        useHiveStore.getState().hydrateAgents([
          agent({ name: 'e-paused', status: 'paused' }),
          agent({ name: 'd-sleeping', status: 'sleeping' }),
          agent({ name: 'c-failed', status: 'failed' }),
          agent({ name: 'b-working', status: 'working' }),
          agent({ name: 'a-asking', status: 'asking' }),
        ]);
      });

      const { result } = renderHook(() => useFleetAgents());

      /*
        `failed` sits above `sleeping` and below `working`: it is not doing
        anything, but it is the one resting state that wants a person to look.
      */
      expect(result.current).toEqual([
        'a-asking',
        'b-working',
        'c-failed',
        'd-sleeping',
        'e-paused',
      ]);
    });

    it('breaks a tie within sleeping by the wake that comes soonest', () => {
      const now = Date.now();
      act(() => {
        useHiveStore.getState().hydrateAgents([
          agent({ name: 'later', nextRunAt: now + 600_000 }),
          agent({ name: 'sooner', nextRunAt: now + 60_000 }),
        ]);
      });

      const { result } = renderHook(() => useFleetAgents());

      expect(result.current).toEqual(['sooner', 'later']);
    });

    /*
      A manual agent has no `nextRunAt`. It reaches the comparator as `0`, which
      is earlier than every real time — so without the guard the one agent that
      will never wake on its own sorts ahead of the one about to.
    */
    it('puts an agent with no scheduled wake last among the sleeping', () => {
      act(() => {
        useHiveStore.getState().hydrateAgents([
          agent({ name: 'manual' }),
          agent({ name: 'timed', nextRunAt: Date.now() + 60_000 }),
        ]);
      });

      const { result } = renderHook(() => useFleetAgents());

      expect(result.current).toEqual(['timed', 'manual']);
    });

    it('is stable by name when nothing else separates two rows', () => {
      act(() => {
        useHiveStore
          .getState()
          .hydrateAgents([agent({ name: 'zulu' }), agent({ name: 'alpha' })]);
      });

      const { result } = renderHook(() => useFleetAgents());

      expect(result.current).toEqual(['alpha', 'zulu']);
    });

    it('ignores a session sharing the map', () => {
      act(() => {
        useHiveStore.getState().hydrateAgents([agent()]);
      });

      const { result } = renderHook(() => useFleetAgents());

      expect(result.current).toEqual(['slack-watcher']);
    });
  });

  describe('useAskingAgentCount', () => {
    const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
      name: 'slack-watcher',
      description: 'Watches.',
      icon: 'Robot',
      status: 'sleeping',
      wake: { on: [] },
      mcp: [],
      tools: [],
      rotateAfter: 50,
      runs: [],
      ...over,
    });

    it('counts only the agents waiting on you', () => {
      act(() => {
        useHiveStore.getState().hydrateAgents([
          agent({ name: 'a', status: 'asking' }),
          agent({ name: 'b', status: 'asking' }),
          agent({ name: 'c', status: 'working' }),
        ]);
      });

      const { result } = renderHook(() => useAskingAgentCount());

      expect(result.current).toBe(2);
    });

    /*
      The count of agents is `useFleetAgents().length` by construction — both
      walk `agentOrder` with the same narrowing — so it is not a second
      selector. One truth per number on screen.
    */
    it('leaves the total to useFleetAgents', () => {
      act(() => {
        useHiveStore
          .getState()
          .hydrateAgents([agent({ name: 'a' }), agent({ name: 'b' })]);
      });

      const { result } = renderHook(() => useFleetAgents());

      expect(result.current).toHaveLength(2);
    });

    /*
      A separate selector rather than widening `useCounts()`, whose
      `Record<SessionStatus, number>` is what makes a sixth *session* status a
      compile error — the property HIVE-83 records paying for.
    */
    it('leaves the session counts alone', () => {
      act(() => {
        useHiveStore.getState().hydrateAgents([agent({ status: 'asking' })]);
      });

      const { result } = renderHook(() => useCounts());

      expect(result.current).not.toHaveProperty('asking');
      expect(result.current).not.toHaveProperty('agents');
    });
  });

  describe('useWorkingAgentCount (HIVE-196)', () => {
    const agent = (over: Partial<AgentSummary> = {}): AgentSummary => ({
      name: 'slack-watcher',
      description: 'Watches.',
      icon: 'Robot',
      status: 'sleeping',
      wake: { on: [] },
      mcp: [],
      tools: [],
      rotateAfter: 50,
      runs: [],
      ...over,
    });

    it('counts only the working agents', () => {
      act(() => {
        useHiveStore.getState().hydrateAgents([
          agent({ name: 'a', status: 'working' }),
          agent({ name: 'b', status: 'working' }),
          agent({ name: 'c', status: 'asking' }),
        ]);
      });

      const { result } = renderHook(() => useWorkingAgentCount());

      expect(result.current).toBe(2);
    });

    it('re-renders only when the count changes', () => {
      act(() => {
        useHiveStore.getState().hydrateAgents([agent({ name: 'a', status: 'working' })]);
      });
      let renders = 0;
      renderHook(() => {
        renders += 1;
        return useWorkingAgentCount();
      });
      const before = renders;

      act(() => useHiveStore.getState().appendEntityLines('hero-refresh', [{ text: 'more', color: 'ink' }]));
      expect(renders).toBe(before);

      act(() => {
        useHiveStore.getState().hydrateAgents([
          agent({ name: 'a', status: 'working' }),
          agent({ name: 'b', status: 'working' }),
        ]);
      });
      expect(renders).toBe(before + 1);
    });
  });

  /**
   * An agent's pull request comes from the **ledger**, not from a run summary:
   * a `RunSummary` records what a wake cost and how it ended, never what it
   * produced. A `done` entry's `meta.pr` is what the agent wrote down.
   */
  describe('useAgentPr', () => {
    const done = (over: Record<string, unknown>) => ({
      id: '20260830-100000-0001',
      ts: 1,
      from: 'slack-watcher',
      kind: 'done' as const,
      body: 'finished',
      ...over,
    });

    it('answers the most recent done that named one', () => {
      act(() => {
        useHiveStore
          .getState()
          .hydrateLedger([
            done({ id: '20260830-100000-0001', meta: { pr: 141 } }),
            done({ id: '20260830-110000-0001', meta: { pr: 152 } }),
          ]);
      });

      const { result } = renderHook(() => useAgentPr('slack-watcher'));

      expect(result.current?.n).toBe(152);
    });

    /*
      A `done` says an agent opened a pull request; it never says in which
      repository. The URL therefore comes from the sweep or not at all — a
      GitHub-wide search for the integer looks like a destination and is not.
    */
    it('carries no url when the PR sweep has not seen that number', () => {
      act(() => {
        useHiveStore.getState().hydrateLedger([done({ meta: { pr: 152 } })]);
      });

      const { result } = renderHook(() => useAgentPr('slack-watcher'));

      expect(result.current).toEqual({ n: 152 });
    });

    /*
      `meta` is whatever the agent handed `ledger_post`, so `#12` and `"12"` are
      both things a model will write and neither should reach the table as NaN.
    */
    it.each([
      [152, 152],
      ['152', 152],
      ['#152', 152],
      ['not-a-pr', undefined],
      [0, undefined],
      [-4, undefined],
      [1.5, undefined],
    ])('reads %s as %s', (written, expected) => {
      act(() => {
        useHiveStore.getState().hydrateLedger([done({ meta: { pr: written } })]);
      });

      const { result } = renderHook(() => useAgentPr('slack-watcher'));

      expect(result.current?.n).toBe(expected);
    });

    it('ignores another party’s done, and a done with no pr', () => {
      act(() => {
        useHiveStore.getState().hydrateLedger([
          done({ id: '20260830-100000-0001', from: 'sess-01', meta: { pr: 141 } }),
          done({ id: '20260830-110000-0001', meta: { ticket: 'HIVE-9' } }),
        ]);
      });

      const { result } = renderHook(() => useAgentPr('slack-watcher'));

      expect(result.current).toBeNull();
    });

    it('ignores an ask that happens to carry one', () => {
      act(() => {
        useHiveStore
          .getState()
          .hydrateLedger([done({ kind: 'ask', meta: { pr: 141 } })]);
      });

      const { result } = renderHook(() => useAgentPr('slack-watcher'));

      expect(result.current).toBeNull();
    });
  });
});

/**
 * The plan selectors (HIVE-179). Progress is derived, never stored, and
 * shallow-compared, so a tick on one session's plan re-renders nothing that
 * asked about another.
 */
describe('plan selectors (HIVE-179)', () => {
  const plan = (entityId: string, statuses: PlanTaskStatus[]): SessionPlan => ({
    entityId,
    source: 'task-tools',
    tasks: statuses.map((status, index) => ({
      id: String(index + 1),
      title: `Task ${String(index + 1)}`,
      status,
    })),
    allDone: false,
  });

  beforeEach(() => {
    useHiveStore.getState().reset();
  });

  it('usePlan returns the stored plan, and undefined without one', () => {
    const stored = plan('sess-01', ['pending']);
    act(() => useHiveStore.getState().setPlan('sess-01', stored));

    expect(renderHook(() => usePlan('sess-01')).result.current).toBe(stored);
    expect(renderHook(() => usePlan('sess-02')).result.current).toBeUndefined();
    expect(renderHook(() => usePlan(undefined)).result.current).toBeUndefined();
  });

  it('usePlanProgress derives done and total, and undefined without a plan', () => {
    act(() =>
      useHiveStore.getState().setPlan('sess-01', plan('sess-01', ['completed', 'in_progress', 'pending'])),
    );

    expect(renderHook(() => usePlanProgress('sess-01')).result.current).toEqual({ done: 1, total: 3 });
    expect(renderHook(() => usePlanProgress('sess-02')).result.current).toBeUndefined();
    expect(renderHook(() => usePlanProgress(undefined)).result.current).toBeUndefined();
  });

  it("re-renders only the session whose plan's counts changed", () => {
    let rendersA = 0;
    let rendersB = 0;
    renderHook(() => {
      rendersA += 1;
      return usePlanProgress('sess-01');
    });
    renderHook(() => {
      rendersB += 1;
      return usePlanProgress('sess-02');
    });
    act(() => useHiveStore.getState().setPlan('sess-01', plan('sess-01', ['pending'])));
    const beforeA = rendersA;
    const beforeB = rendersB;

    act(() => useHiveStore.getState().setPlan('sess-02', plan('sess-02', ['completed'])));

    expect(rendersB).toBe(beforeB + 1);
    expect(rendersA).toBe(beforeA);

    // A new object with the same counts is not a change to anyone reading progress.
    act(() => useHiveStore.getState().setPlan('sess-01', plan('sess-01', ['pending'])));

    expect(rendersA).toBe(beforeA);
  });
});

describe('agentWorksIn (HIVE-197)', () => {
  const agent = (lanes: (string | undefined)[]) =>
    ({
      kind: 'agent',
      live: lanes.map((lane, i) => ({ run: `r${String(i)}`, kind: 'task', trigger: 'ledger', startedAt: 1, lane })),
    }) as unknown as Agent;

  it('matches a repo lane’s name to the folder name, case-insensitively', () => {
    expect(agentWorksIn(agent(['repo:behiques/Incorpx-Server']), 'incorpx-server')).toBe(true);
  });
  it('ignores standing, thread and other repos', () => {
    expect(agentWorksIn(agent([undefined, 'standing', 'thread:20261002-1-1', 'repo:o/ai-sdk']), 'incorpx-server')).toBe(false);
  });
  it('repoDirName takes the last path segment, lowercased; null stays null', () => {
    expect(repoDirName('/Users/me/Projects/Incorpx-Server/')).toBe('incorpx-server');
    expect(repoDirName(null)).toBeNull();
  });
});

describe('fleetGroupsOf (HIVE-197)', () => {
  const NOW = new Date(2026, 9, 2, 15, 0).getTime();
  const TODAY = new Date(2026, 9, 2, 9, 0).getTime();
  const YESTERDAY = new Date(2026, 9, 1, 9, 0).getTime();
  const sess = (id: string, project: string, status: Session['status'], over: Partial<Session> = {}): Session => ({
    kind: 'session', id, project, branch: `b/${id}`, status, task: `task ${id}`, cost: '$0', lines: [], ...over,
  });
  const agent = (id: string, lane?: string) =>
    ({
      kind: 'agent', id, status: 'working',
      live: lane ? [{ run: 'r', kind: 'task', trigger: 'ledger', startedAt: 1, lane }] : [],
    }) as unknown as Agent;
  const entities: Record<string, Entity> = {
    a: sess('a', 'p1', 'working', { createdAt: 3 }),
    b: sess('b', 'p2', 'waiting', { createdAt: 2 }),
    c: sess('c', 'p1', 'done', { endedAt: TODAY }),
    d: sess('d', 'p1', 'terminated', { endedAt: YESTERDAY }),
    e: sess('e', 'p2', 'done', { endedAt: YESTERDAY - 1 }),
    builder: agent('builder', 'repo:o/p1'),
    slack: agent('slack'),
  };
  const state = { entities, order: ['a', 'b', 'c', 'd', 'e'], agentOrder: ['builder', 'slack'] };
  const view = (over: Partial<FleetView> = {}): FleetView => ({ project: null, filter: 'all', endedAll: false, ...over });

  it('unfiltered: every live session, every agent, today’s endings and the rest counted', () => {
    const g = fleetGroupsOf(state, view(), null, NOW);
    expect(g.live).toEqual(['a', 'b']);
    expect(new Set(g.agents)).toEqual(new Set(['builder', 'slack']));
    expect(g.ended).toEqual(['c']);
    expect(g.endedMore).toBe(2);
  });

  it('endedAll reveals every ending', () => {
    const g = fleetGroupsOf(state, view({ endedAll: true }), null, NOW);
    expect(g.ended).toEqual(['c', 'd', 'e']);
    expect(g.endedMore).toBe(0);
  });

  it('a project narrows all three groups and shows its endings whole', () => {
    const g = fleetGroupsOf(state, view({ project: 'p1' }), 'p1', NOW);
    expect(g.live).toEqual(['a']);
    expect(g.agents).toEqual(['builder']);
    expect(g.ended).toEqual(['c', 'd']);
    expect(g.endedMore).toBe(0);
  });

  it('a project with no folder has no agents working in it', () => {
    expect(fleetGroupsOf(state, view({ project: 'p1' }), null, NOW).agents).toEqual([]);
  });

  it('orders by recency and fleet rank, not by insertion order', () => {
    const shuffled = { entities, order: ['b', 'e', 'a', 'd', 'c'], agentOrder: ['slack', 'builder'] };
    const g = fleetGroupsOf(shuffled, view({ endedAll: true }), null, NOW);
    expect(g.live).toEqual(['a', 'b']);
    expect(g.agents).toEqual(['builder', 'slack']);
    expect(g.ended).toEqual(['c', 'd', 'e']);
  });

  it('Live hides Ended; Ended shows only Ended, whole', () => {
    const live = fleetGroupsOf(state, view({ filter: 'live' }), null, NOW);
    expect(live.ended).toEqual([]);
    expect(live.endedMore).toBe(0);
    expect(live.agents).toHaveLength(2);
    const ended = fleetGroupsOf(state, view({ filter: 'ended' }), null, NOW);
    expect(ended.live).toEqual([]);
    expect(ended.agents).toEqual([]);
    expect(ended.ended).toEqual(['c', 'd', 'e']);
  });
});

describe('fleet hooks (HIVE-197)', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    useUiStore.getState().reset();
    seedDemoFleet();
  });

  it('useFleetNavOrder is the whole fleet under All with Ended unfolded', () => {
    useUiStore.setState({ endedExpanded: true });
    const nav = renderHook(() => useNavOrder()).result.current;
    expect(renderHook(() => useFleetNavOrder()).result.current).toEqual(nav);
  });

  it('a project filter narrows the order to that project’s rows', () => {
    useUiStore.setState({ sessionsProject: 'nova-web' });
    const order = renderHook(() => useFleetNavOrder()).result.current;
    const live = renderHook(() => useFleetGroup('live')).result.current;
    expect(live.length).toBeGreaterThan(0);
    for (const id of live) expect((useHiveStore.getState().entities[id] as Session).project).toBe('nova-web');
    expect(order.slice(0, live.length)).toEqual(live);
  });

  it('the Ended filter leaves only ended rows', () => {
    useUiStore.setState({ sessionsFilter: 'ended' });
    expect(renderHook(() => useFleetGroup('live')).result.current).toEqual([]);
    expect(renderHook(() => useEndedMore()).result.current).toBe(0);
  });
});

describe('count hooks (HIVE-197)', () => {
  const NOW = new Date(2026, 9, 2, 15, 0).getTime();
  const sess = (id: string, project: string, status: Session['status'], over: Partial<Session> = {}): Session => ({
    kind: 'session', id, project, branch: `b/${id}`, status, task: `task ${id}`, cost: '$0', lines: [], ...over,
  });
  const term = (id: string, project: string, over: Partial<Terminal> = {}): Terminal => ({
    kind: 'terminal', id, project, cwd: `/repos/${project}`, status: 'prompt', createdAt: 1, lines: [], ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useHiveStore.getState().reset();
    useHiveStore.setState({
      entities: {
        a: sess('a', 'p1', 'working'),
        b: sess('b', 'p1', 'waiting'),
        c: sess('c', 'p2', 'idle'),
        d: sess('d', 'p1', 'done', { endedAt: NOW - 1000 }),
        e: sess('e', 'p2', 'done', { endedAt: NOW - 3 * 86_400_000 }),
        t1: term('t1', 'p1'),
        t2: term('t2', 'p1', { ended: { reason: 'lost', at: 1 } }),
      },
      order: ['a', 'b', 'c', 'd', 'e', 't1', 't2'],
      agentOrder: [],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('useProjectCounts splits needs you from the other live entries', () => {
    expect(renderHook(() => useProjectCounts('p1')).result.current).toEqual({ needs: 1, other: 2 });
    expect(renderHook(() => useProjectCounts('p3')).result.current).toEqual({ needs: 0, other: 0 });
  });

  it('useSessionsHeadCounts sums entries', () => {
    expect(renderHook(() => useSessionsHeadCounts()).result.current).toEqual({ live: 4, needs: 1 });
  });

  it('useOvermindHeadCounts counts sessions, unfiltered and filtered', () => {
    expect(renderHook(() => useOvermindHeadCounts(null)).result.current).toEqual({
      live: 3, projects: 2, needs: 1, ended: 2, endedToday: 1,
    });
    expect(renderHook(() => useOvermindHeadCounts('p1')).result.current).toEqual({
      live: 2, projects: 1, needs: 1, ended: 1, endedToday: 1,
    });
  });

  it('useAgentsWorkingIn names agents with a run in the project', () => {
    expect(renderHook(() => useAgentsWorkingIn(null)).result.current).toEqual([]);
  });
});

describe('comb selectors (HIVE-199)', () => {
  const NOW = new Date(2026, 9, 2, 15, 0).getTime();
  const sess = (id: string, project: string, status: Session['status'], over: Partial<Session> = {}): Session => ({
    kind: 'session', id, project, branch: `b/${id}`, status, task: `task ${id}`, cost: '$0', lines: [], ...over,
  });
  const term = (id: string, project: string, over: Partial<Terminal> = {}): Terminal => ({
    kind: 'terminal', id, project, cwd: `/repos/${project}`, status: 'prompt', createdAt: 1, lines: [], ...over,
  });
  const summary = (over: Partial<AgentSummary>): AgentSummary => ({
    name: 'x', description: '', icon: 'Robot', status: 'sleeping', wake: { on: [] }, mcp: [], tools: [], rotateAfter: 50, runs: [], ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useHiveStore.getState().reset();
    act(() => {
      useHiveStore.getState().hydrateAgents([
        summary({ name: 'asker', status: 'asking' }),
        summary({ name: 'broken', status: 'sleeping', invalid: 'bad frontmatter' }),
        summary({ name: 'quitter', status: 'failed', runs: [{ outcome: 'failed', reason: 'hit the 150-turn limit', startedAt: 1, endedAt: 2 } as never] }),
        summary({ name: 'resting', status: 'paused' }),
        summary({ name: 'runner', status: 'working' }),
      ]);
      useHiveStore.setState((s) => ({
        entities: {
          ...s.entities,
          a: sess('a', 'p1', 'working', { name: 'Alpha' }),
          b: sess('b', 'p1', 'waiting'),
          c: sess('c', 'p2', 'idle'),
          d: sess('d', 'p2', 'idle', { idleDetail: 'agents' }),
          e: sess('e', 'p1', 'done'),
          t1: term('t1', 'p1'),
          t2: term('t2', 'p1', { ended: { reason: 'lost', at: 1 } }),
        },
        order: ['a', 'b', 'c', 'd', 'e', 't1', 't2'],
        ledger: [{ id: '20261002-145000-0001', ts: NOW - 14 * 60_000, from: 'asker', to: 'overmind', kind: 'ask', ref: 'a1', body: 'Merge #305?\nIt is approved.' }],
      }));
      useHiveStore.getState().setPlan('a', {
        entityId: 'a', source: 'task-tools', allDone: false,
        tasks: [{ id: '1', title: 'x', status: 'completed' }, { id: '2', title: 'y', status: 'pending' }],
      });
    });
  });
  afterEach(() => vi.useRealTimers());

  it('maps sessions, terminals and agents to comb states, and drops what has ended', () => {
    const { result } = renderHook(() => useCombEntities());
    const by = Object.fromEntries(result.current.map((e) => [e.id, e]));
    expect(Object.keys(by).sort()).toEqual(['a', 'asker', 'b', 'broken', 'c', 'd', 'quitter', 'resting', 'runner', 't1']);
    expect(by.a).toMatchObject({ name: 'Alpha', kind: 'session', project: 'p1', state: 'morphing', done: 1, total: 2 });
    expect(by.b).toMatchObject({ name: 'b', state: 'summons' });
    expect(by.c).toMatchObject({ state: 'burrowed' });
    expect(by.d).toMatchObject({ state: 'morphing', idleDetail: 'agents' });
    expect(by.t1).toMatchObject({ kind: 'terminal', state: 'terminal', status: 'prompt' });
    expect(by.asker).toMatchObject({ kind: 'agent', project: 'swarm', state: 'summons', ask: 'Merge #305?', askedAt: NOW - 14 * 60_000 });
    expect(by.broken).toMatchObject({ state: 'failed', reason: 'bad frontmatter' });
    expect(by.quitter).toMatchObject({ state: 'failed', reason: 'hit the 150-turn limit' });
    expect(by.resting).toMatchObject({ state: 'burrowed', nextRun: 'paused' });
    expect(by.runner).toMatchObject({ state: 'morphing' });
  });

  it('does not re-render on a transcript line or an unrelated write', () => {
    let renders = 0;
    renderHook(() => { renders += 1; return useCombEntities(); });
    const before = renders;
    act(() => useHiveStore.getState().appendEntityLines('a', [{ text: 'more', color: 'ink' }]));
    act(() => useHiveStore.setState((s) => ({ entities: { ...s.entities, a: { ...(s.entities.a as Session), cost: '$9' } } })));
    expect(renders).toBe(before);
  });

  it('re-renders when a state changes', () => {
    const { result } = renderHook(() => useCombEntities());
    act(() => useHiveStore.getState().appendEntityLines('c', [], 'waiting'));
    expect(result.current.find((e) => e.id === 'c')!.state).toBe('summons');
  });

  it('summarises for the headline', () => {
    const { result } = renderHook(() => useCombSummary());
    expect(result.current).toEqual({ working: 3, failed: 2, resting: 3, projects: 2, agents: 5 });
  });

  describe('changed-file selectors (HIVE-201)', () => {
    const a = { path: 'src/a.ts', mark: 'M' as const, added: 2, removed: 1 };
    const b = { path: 'b.ts', mark: 'A' as const, added: 4, removed: 0 };

    it('count and mark derive from the list', () => {
      act(() => {
        useHiveStore.getState().setChangedFiles('s1', [a, b]);
      });
      expect(renderHook(() => useChangedFileCount('s1')).result.current).toBe(2);
      expect(renderHook(() => useChangedFileCount(undefined)).result.current).toBe(0);
      expect(renderHook(() => useChangedFileMark('s1', 'b.ts')).result.current).toBe('A');
      expect(renderHook(() => useChangedFileMark('s1', 'nope')).result.current).toBeUndefined();
      expect(renderHook(() => useChangedFileMark(undefined, 'b.ts')).result.current).toBeUndefined();
      expect(renderHook(() => useChangedFiles('s1')).result.current).toEqual([a, b]);
      expect(renderHook(() => useChangedFiles(undefined)).result.current).toBeUndefined();
    });
  });
});

/** The Work page's selectors (HIVE-203). */
describe('Work page selectors (HIVE-203)', () => {
  const entry = (id: string, ticket: string, from = 'builder') => ({
    id,
    ts: 1,
    from,
    kind: 'post' as const,
    body: 'x',
    meta: { ticket, stage: 'build' },
  });
  const sessionOn = (ticket: string): Session => {
    const id = useHiveStore.getState().order.find((key) => {
      const entity = useHiveStore.getState().entities[key];
      return entity?.kind === 'session' && entity.ticket === ticket;
    });
    return useHiveStore.getState().entities[id!] as Session;
  };
  const setSession = (session: Session) =>
    useHiveStore.setState((state) => ({ entities: { ...state.entities, [session.id]: session } }));

  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useHiveStore.setState({ prs: [], ledger: [] });
  });

  describe('useTicketGroups', () => {
    it('turns a ticket amber, and counts it, when a session on it waits', () => {
      setSession({ ...sessionOn('GRAC-3018'), status: 'working' });
      const { result } = renderHook(() => useTicketGroups());
      const rowOf = () =>
        result.current.groups.flatMap((group) => group.rows).find((row) => row.ticket.key === 'GRAC-3018');
      const before = result.current.needYou;
      expect(rowOf()?.tone).toBe('green');

      act(() => setSession({ ...sessionOn('GRAC-3018'), status: 'waiting' }));

      expect(rowOf()).toMatchObject({ tone: 'amber', fact: 'waiting on you' });
      expect(result.current.needYou).toBe(before + 1);
      expect(result.current.total).toBe(useHiveStore.getState().tickets.length);
      expect(result.current.groups.map((group) => group.category)).toEqual(['in-progress', 'done']);
    });
  });

  describe('useTicketProperties', () => {
    const tag = (title: string, priority: string | null = null) =>
      useHiveStore.setState((state) => ({
        tickets: state.tickets.map((ticket) =>
          ticket.key === 'GRAC-3018' ? { ...ticket, title, priority, assignee: null } : ticket,
        ),
      }));

    it('reads the tag priority over Jira, the side, the project, the agent and Unassigned', () => {
      tag('[BE][P4]-Hero', 'High');
      useHiveStore.setState({ ledger: [entry('20261002-100000-0001', 'GRAC-3018', 'fixer')] });
      const { result } = renderHook(() => useTicketProperties('GRAC-3018'));

      expect(result.current).toEqual({
        status: 'In Progress',
        priority: 'P4',
        side: 'BE',
        project: sessionOn('GRAC-3018').project,
        assignee: 'Unassigned',
        agent: 'fixer',
      });
    });

    it("uses Jira's priority without a tag, and has no side", () => {
      tag('Hero', 'High');
      const { result } = renderHook(() => useTicketProperties('GRAC-3018'));

      expect(result.current?.priority).toBe('High');
      expect(result.current).not.toHaveProperty('side');
      expect(result.current).not.toHaveProperty('agent');
    });

    it('has no project without a live session, and an epic once the slice holds a parent', () => {
      const { result } = renderHook(() => useTicketProperties('GRAC-2810'));
      expect(result.current).not.toHaveProperty('project');
      expect(result.current).not.toHaveProperty('priority');
      expect(result.current).not.toHaveProperty('epic');

      act(() =>
        useHiveStore.setState({
          ticketDetails: {
            'GRAC-2810': {
              key: 'GRAC-2810',
              detail: { description: [], parent: { key: 'GRAC-1', summary: 'Epic' } },
              problems: {},
            },
          },
        }),
      );

      expect(result.current?.epic).toBe('GRAC-1');
    });

    it('is undefined for an unknown ticket', () => {
      const { result } = renderHook(() => useTicketProperties('NOPE-1'));
      expect(result.current).toBeUndefined();
    });
  });

  describe('useTicketEvents', () => {
    it('merges the history with the tail, deduped and in id order, for this ticket only', () => {
      const a = entry('20261002-100000-0001', 'GRAC-3018');
      const b = entry('20261002-100000-0002', 'grac-3018');
      const c = entry('20261002-100000-0003', 'GRAC-3018');
      const other = entry('20261002-100000-0004', 'GRAC-3022');
      useHiveStore.setState({
        ledger: [c, b, other],
        ticketDetails: { 'GRAC-3018': { key: 'GRAC-3018', history: [a, b], problems: {} } },
      });
      const { result } = renderHook(() => useTicketEvents('GRAC-3018'));

      expect(result.current.map((event) => event.id)).toEqual([a.id, b.id, c.id]);
    });

    it("ignores another ticket's history", () => {
      useHiveStore.setState({
        ticketDetails: {
          'GRAC-3022': { key: 'GRAC-3022', history: [entry('20261002-100000-0001', 'GRAC-3022')], problems: {} },
        },
      });
      const { result } = renderHook(() => useTicketEvents('GRAC-3018'));

      expect(result.current).toEqual([]);
    });
  });

  describe('useNextTransition', () => {
    it('is undefined without transitions, and the forward one with them', () => {
      const { result } = renderHook(() => useNextTransition('GRAC-3018'));
      expect(result.current).toBeUndefined();

      const done = { id: '31', name: 'Finish', to: { name: 'Done', statusCategory: 'done' as const } };
      const back = { id: '11', name: 'Reopen', to: { name: 'To Do', statusCategory: 'todo' as const } };
      act(() => useHiveStore.setState({ ticketDetails: { 'GRAC-3018': { key: 'GRAC-3018', transitions: [back, done], problems: {} } } }));

      expect(result.current).toEqual(done);
    });
  });

  describe('useOpenTicket', () => {
    it('prefers the list, falls back to the issue the slice read, else nothing', () => {
      const issue = { key: 'HIVE-8', status: 'To Do', statusCategory: 'todo' as const, title: 'x', priority: null, assignee: null };
      useHiveStore.setState({ ticketDetails: { 'HIVE-8': { key: 'HIVE-8', issue, problems: {} } } });

      expect(renderHook(() => useOpenTicket('GRAC-3018')).result.current?.key).toBe('GRAC-3018');
      expect(renderHook(() => useOpenTicket('HIVE-8')).result.current).toEqual(issue);
      expect(renderHook(() => useOpenTicket('HIVE-9')).result.current).toBeUndefined();
      expect(renderHook(() => useOpenTicket(null)).result.current).toBeUndefined();
    });
  });
});

describe('the PR page selectors (HIVE-205)', () => {
  const slug = 'acme/server';
  const ledger: LedgerEntry[] = [
    { id: '1', ts: 1_000, from: 'builder', kind: 'ask', to: 'shipper', body: 'ship', meta: { pr: 1182, repo: slug, stage: 'intake' } },
    { id: '2', ts: 2_000, from: 'shipper', kind: 'claim', body: '', meta: { task: 'acme/server#1182' } },
    { id: '3', ts: 3_000, from: 'shipper', kind: 'post', body: 'findings', meta: { pr: 1182, repo: slug, stage: 'findings' } },
    { id: '4', ts: 3_000, from: 'shipper', kind: 'ask', to: 'fixer', body: 'acme/server#1182: three findings' },
    { id: '5', ts: 4_000, from: 'fixer', kind: 'post', body: 'On it: acme/server#1182 finding 2' },
    { id: '6', ts: 5_000, from: 'acr', kind: 'answer', body: 'done', meta: { review_url: 'https://github.com/acme/server/pull/1182#pullrequestreview-7' } },
  ];

  beforeEach(() => {
    useHiveStore.getState().reset();
    useHiveStore.setState({ ledger });
  });

  it('reads the track, the events, the opener and the holder’s post from the tail', () => {
    expect(renderHook(() => useShipTrack(slug, 1182)).result.current.current).toMatchObject({ stage: 'findings', holder: 'fixer' });
    expect(renderHook(() => usePrEvents(slug, 1182)).result.current.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(renderHook(() => usePrOpener(slug, 1182)).result.current).toBe('builder');
    expect(renderHook(() => useHolderPost(slug, 1182, 'fixer')).result.current?.id).toBe('5');
    expect(renderHook(() => useHolderPost(slug, 1182, null)).result.current).toBeNull();
    expect([...renderHook(() => useReviewUrls()).result.current]).toEqual(['https://github.com/acme/server/pull/1182#pullrequestreview-7']);
  });

  it('keeps the same answer until the ledger changes', () => {
    const { result, rerender } = renderHook(() => usePrEvents(slug, 1182));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('reads one detail entry and hands out the two actions', () => {
    useHiveStore.setState({ prDetails: { 'acme/server#1182': { key: 'acme/server#1182', state: 'loading' } } });
    expect(renderHook(() => usePrDetail('acme/server#1182')).result.current).toEqual({ key: 'acme/server#1182', state: 'loading' });
    expect(renderHook(() => useLoadPrDetail()).result.current).toBe(useHiveStore.getState().loadPrDetail);
    expect(renderHook(() => useCommentOnPr()).result.current).toBe(useHiveStore.getState().commentOnPr);
  });
});

describe('the Timeline selectors (HIVE-208)', () => {
  const slug = 'acme/server';
  const KEY = 'acme/server#1182';
  const T0 = Date.parse('2026-10-03T11:00:00Z');
  const MIN = 60_000;
  const pr = { owner: 'acme', repo: 'server', n: 1182, mine: true };
  const timeline: PrTimeline = {
    createdAt: new Date(T0).toISOString(), mergedAt: null, isDraft: false,
    commits: [], runs: [], reviews: [], comments: [], events: [],
  };
  const intake: LedgerEntry = { id: '20261003-110400-0001', ts: T0 + 4 * MIN, from: 'builder', kind: 'ask', to: 'shipper', body: 'ship', meta: { pr: 1182, repo: slug, stage: 'intake' } };
  const claim: LedgerEntry = { id: '20261003-110500-0001', ts: T0 + 5 * MIN, from: 'shipper', kind: 'claim', body: '', meta: { task: 'acme/server#1182' } };

  beforeEach(() => {
    useHiveStore.getState().reset();
  });

  it('is null before any read, and hands out the entry and the load action', () => {
    expect(renderHook(() => useTimelineModel(pr, T0 + 60 * MIN)).result.current).toBeNull();
    expect(renderHook(() => usePrTimelineEntry(KEY)).result.current).toBeUndefined();
    expect(renderHook(() => useLoadPrTimeline()).result.current).toBe(useHiveStore.getState().loadPrTimeline);
  });

  it('merges the history read on open with the live tail, and keeps the same model for the same now', () => {
    useHiveStore.setState({
      prTimelines: { [KEY]: { key: KEY, state: 'ok', timeline, history: [intake] } },
      ledger: [intake, claim],
    });
    const { result, rerender } = renderHook(() => useTimelineModel(pr, T0 + 60 * MIN));
    expect(result.current?.holds.map((h) => h.who)).toEqual(['builder', 'shipper']);
    expect(result.current?.holds[1]).toMatchObject({ from: T0 + 5 * MIN, to: T0 + 60 * MIN });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(renderHook(() => usePrTimelineEntry(KEY)).result.current?.timeline).toBe(timeline);
  });
});

describe('usePrsQuiet (HIVE-205)', () => {
  it('is true only for a live, empty sweep', () => {
    useHiveStore.setState({ prs: [], prSource: { kind: 'live', stale: false, repos: 2 } });
    expect(renderHook(() => usePrsQuiet()).result.current).toBe(true);
    useHiveStore.setState({ prs: [prRecord()] });
    expect(renderHook(() => usePrsQuiet()).result.current).toBe(false);
    for (const prSource of [
      { kind: 'loading' },
      { kind: 'unconfigured', message: 'x', reason: 'not-installed' },
      { kind: 'failed', message: 'x' },
    ] as const) {
      useHiveStore.setState({ prs: [], prSource });
      expect(renderHook(() => usePrsQuiet()).result.current).toBe(false);
    }
  });
});

describe('the Checks selectors (HIVE-206)', () => {
  const KEY = 'acme/nova-web#482';
  const run = (id: number, headSha: string, conclusion: string | null = 'success') => ({
    id, number: id, attempt: 1, status: 'completed', conclusion, headSha, event: 'push',
    workflowName: 'CI', createdAt: '2026-10-03T14:00:00Z', updatedAt: 'u', url: 'u' });
  const job = (id: number, runId: number, conclusion = 'success') => ({ id, runId, name: `job${String(id)}`, status: 'completed',
    conclusion, startedAt: null, completedAt: null, url: 'u', steps: [] });

  beforeEach(() => {
    useHiveStore.setState({ prChecks: { [KEY]: { key: KEY, state: 'ok', workflows: [],
      runs: [run(2, 'new', 'failure'), run(1, 'old')],
      jobs: { 2: [job(21, 2), job(22, 2, 'failure')], 1: [job(11, 1)] }, logs: {} } } });
  });

  it('folds the runs into pushes, oldest first', () => {
    const { result } = renderHook(() => usePushes(KEY));
    expect(result.current.map((p) => [p.sha, p.state])).toEqual([['old', 'passed'], ['new', 'failed']]);
  });

  it('lays out the newest push, or the one asked for', () => {
    expect(renderHook(() => useChecksGraph(KEY, null, new Set())).result.current?.nodes.map((n) => n.jobId)).toEqual([21, 22]);
    expect(renderHook(() => useChecksGraph(KEY, 'old', new Set())).result.current?.nodes.map((n) => n.jobId)).toEqual([11]);
    expect(renderHook(() => useChecksGraph('acme/x#1', null, new Set())).result.current).toBeNull();
  });

  it('shows the clicked job, else the failed one, else none', () => {
    expect(renderHook(() => useShownJob(KEY, null, null)).result.current?.id).toBe(22);
    expect(renderHook(() => useShownJob(KEY, null, 21)).result.current?.id).toBe(21);
    expect(renderHook(() => useShownJob(KEY, 'old', null)).result.current).toBeNull();
    expect(renderHook(() => useShownJob('acme/x#1', null, null)).result.current).toBeNull();
  });

  it('hands the entry and the three actions through', () => {
    expect(renderHook(() => usePrChecks(KEY)).result.current?.state).toBe('ok');
    expect(Object.keys(renderHook(() => usePrChecksActions()).result.current).sort()).toEqual(['loadJobLog', 'loadPrChecks', 'rerunFailed']);
  });
});

describe('useSessionPrRow (HIVE-209)', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
  });

  it("pairs the session's PR with its Hatchery row", () => {
    const { result } = renderHook(() => useSessionPrRow('hero-refresh'));
    expect(result.current?.pr.n).toBe(482);
    expect(result.current?.row?.pr.url).toBe('https://github.com/demo/nova-web/pull/482');
    expect(result.current?.row?.hatch.flap).toBeDefined();
  });

  it('is null with no PR, and a remembered PR has no row', () => {
    act(() => useHiveStore.setState({ prs: [] }));
    const { result, rerender } = renderHook(() => useSessionPrRow('hero-refresh'));
    expect(result.current).toBeNull();

    act(() =>
      useHiveStore.setState((state) => ({
        entities: {
          ...state.entities,
          'hero-refresh': {
            ...state.entities['hero-refresh'],
            lastPr: { number: 118, url: 'https://github.com/demo/nova-web/pull/118' },
          } as never,
        },
      })),
    );
    rerender();
    expect(result.current).toEqual({ pr: { n: 118, url: 'https://github.com/demo/nova-web/pull/118' }, row: null });
  });

  it('matches by URL, so the same number in another repo is not this row', () => {
    act(() =>
      useHiveStore.setState((state) => ({
        prs: [
          { ...state.prs[0]!, repo: 'other', url: 'https://github.com/demo/other/pull/482', branch: 'x' },
          ...state.prs,
        ],
      })),
    );
    const { result } = renderHook(() => useSessionPrRow('hero-refresh'));
    expect(result.current?.row?.pr.repo).toBe('nova-web');
  });

  it('is null for an id that is not a session', () => {
    const { result } = renderHook(() => useSessionPrRow('nope'));
    expect(result.current).toBeNull();
  });
});

describe('Home strip selectors (HIVE-200)', () => {
  beforeEach(() => {
    useHiveStore.getState().reset();
    seedDemoFleet();
    useUiStore.getState().reset();
  });

  describe('useAccountLimits', () => {
    const setMetrics = (metrics: Record<string, object>) =>
      act(() => useHiveStore.setState({ metrics: metrics as never }));

    it('is empty with no metrics', () => {
      setMetrics({});
      expect(renderHook(() => useAccountLimits()).result.current).toEqual({});
    });

    it('carries one window alone', () => {
      setMetrics({ a: { fiveHourPct: 38, fiveHourResetsAt: 1_900_000_000 } });
      expect(renderHook(() => useAccountLimits()).result.current).toEqual({
        fiveHourPct: 38,
        fiveHourResetsAt: 1_900_000_000,
      });
    });

    it('carries both windows', () => {
      setMetrics({
        a: {
          fiveHourPct: 38,
          fiveHourResetsAt: 1_900_000_000,
          sevenDayPct: 61,
          sevenDayResetsAt: 1_900_500_000,
        },
      });
      expect(renderHook(() => useAccountLimits()).result.current).toEqual({
        fiveHourPct: 38,
        fiveHourResetsAt: 1_900_000_000,
        sevenDayPct: 61,
        sevenDayResetsAt: 1_900_500_000,
      });
    });

    it('two sessions: the latest reset wins, then the highest percentage (D7)', () => {
      setMetrics({
        old: { fiveHourPct: 90, fiveHourResetsAt: 1_899_000_000 }, // an already-rolled window
        a: { fiveHourPct: 30, fiveHourResetsAt: 1_900_000_000 },
        b: { fiveHourPct: 38, fiveHourResetsAt: 1_900_000_000 },
        c: { fiveHourPct: 99 }, // no reset: ranks below every reading with one
      });
      expect(accountLimitsOf(useHiveStore.getState().metrics)).toEqual({
        fiveHourPct: 38,
        fiveHourResetsAt: 1_900_000_000,
      });
    });

    it('a pct with no reset still shows when nothing better exists', () => {
      expect(accountLimitsOf({ c: { sevenDayPct: 12 } } as never)).toEqual({ sevenDayPct: 12 });
    });

    it('holds its identity across terminal output', () => {
      setMetrics({ a: { fiveHourPct: 38, fiveHourResetsAt: 1_900_000_000 } });
      const { result } = renderHook(() => useAccountLimits());
      const before = result.current;
      act(() =>
        useHiveStore.getState().appendEntityLines('hero-refresh', [{ text: 'more', color: 'ink' }]),
      );
      expect(result.current).toBe(before);
    });
  });

  describe('useComingUp', () => {
    const agent = (id: string, nextRunAt?: number): Agent =>
      ({
        kind: 'agent',
        id,
        icon: 'Robot',
        sub: `${id} does its thing`,
        task: '',
        status: 'sleeping',
        wake: { on: [] },
        mcp: [],
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
      }) as unknown as Agent;
    const held = (id: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
      id,
      ts: 1,
      from: 'sess-1',
      to: 'builder',
      kind: 'ask',
      body: 'Build HIVE-214\nmore',
      meta: { after: 'acme/nova-web#589', ticket: 'HIVE-214' },
      ...extra,
    });
    const seed = (agents: Agent[], ledger: LedgerEntry[]) =>
      act(() =>
        useHiveStore.setState((s) => ({
          entities: { ...s.entities, ...Object.fromEntries(agents.map((a) => [a.id, a])) },
          agentOrder: agents.map((a) => a.id),
          ledger,
        })),
      );

    it('orders scheduled agents soonest first, then held asks', () => {
      seed([agent('slack', 2_000), agent('pr-patrol', 1_000), agent('fixer')], [held('h1')]);
      expect(renderHook(() => useComingUp()).result.current).toEqual([
        { id: 'pr-patrol', agent: 'pr-patrol', what: 'pr-patrol does its thing', at: 1_000 },
        { id: 'slack', agent: 'slack', what: 'slack does its thing', at: 2_000 },
        { id: 'h1', agent: 'builder', what: 'picks up HIVE-214 when nova-web#589 ships' },
      ]);
    });

    it('falls back to the ask body first line without meta.ticket', () => {
      seed([], [held('h1', { meta: { after: 'acme/nova-web#589' } })]);
      expect(renderHook(() => useComingUp()).result.current[0]?.what).toBe(
        'picks up Build HIVE-214 when nova-web#589 ships',
      );
    });

    it('drops a released ask', () => {
      seed(
        [],
        [
          held('h1'),
          {
            id: 'c1',
            ts: 2,
            from: 'shipper',
            kind: 'post',
            body: 'closed',
            meta: { stage: 'closed', repo: 'acme/nova-web', pr: 589 },
          },
        ],
      );
      expect(renderHook(() => useComingUp()).result.current).toEqual([]);
    });

    it('caps at five rows', () => {
      seed(
        [1, 2, 3, 4, 5, 6].map((n) => agent(`a${n}`, n)),
        [],
      );
      expect(renderHook(() => useComingUp()).result.current).toHaveLength(5);
    });

    it('holds its identity across terminal output', () => {
      seed([agent('slack', 2_000)], []);
      const { result } = renderHook(() => useComingUp());
      const before = result.current;
      act(() =>
        useHiveStore.getState().appendEntityLines('hero-refresh', [{ text: 'more', color: 'ink' }]),
      );
      expect(result.current).toBe(before);
    });
  });

  describe('useWhileAway', () => {
    const SINCE = Date.parse('2026-10-03T13:10:00Z');
    const before = '2026-10-03T12:00:00Z';
    const after = '2026-10-03T14:00:00Z';
    const run = (id: string, ts: number, outcome: string): LedgerEntry => ({
      id,
      ts,
      from: 'acr',
      kind: 'event',
      body: `run.ended — ${outcome}`,
      meta: { run: id, outcome },
    });
    const closed = (pr: number): LedgerEntry => ({
      id: `c${pr}`,
      ts: SINCE + 1,
      from: 'shipper',
      kind: 'post',
      body: 'closed',
      meta: { stage: 'closed', repo: 'acme/nova-web', pr },
    });

    beforeEach(() => {
      act(() =>
        useHiveStore.setState({
          prs: [
            prRecord({ number: 302, state: 'merged', mergedAt: after, updatedAt: after, branch: 'm1' }),
            prRecord({ number: 303, state: 'merged', mergedAt: after, updatedAt: after, branch: 'm2' }),
            prRecord({ number: 290, state: 'merged', mergedAt: before, updatedAt: before, branch: 'm0' }),
          ],
          notifs: [
            notif({ kind: 'session.goal', title: 'pty-resize goal done', createdAt: SINCE + 5 }),
            notif({ kind: 'session.goal', title: 'old goal', createdAt: SINCE - 5 }),
          ],
          ledger: [
            run('r0', SINCE - 1, 'done'),
            run('r1', SINCE + 1, 'done'),
            run('r2', SINCE + 2, 'failed'),
            closed(302),
            closed(303),
          ],
          tickets: [],
        }),
      );
    });

    it('counts what happened after since and nothing before it', () => {
      const { result } = renderHook(() => useWhileAway(SINCE));
      expect(result.current.hatched).toEqual({ numbers: [302, 303], by: 'shipper' });
      expect(result.current.goals).toEqual(['pty-resize goal done']);
      expect(result.current.runs).toEqual({ total: 2, failed: 1 });
    });

    it('counts the Echoes after since and nothing before it', () => {
      const echo = (kind: NotificationKind, title: string, at: number, body = '') =>
        notif({ kind, title, body, createdAt: at, action: { type: 'none' } });
      const notifs = [
        echo('pr.checks_failed', 'Checks failed on #301', SINCE - 5),
        echo('pr.checks_failed', 'Checks failed on #305', SINCE + 5),
        echo('pr.checks_failed', 'Checks failed on #306', SINCE + 6),
        echo('pr.approved', 'old approval', SINCE - 5),
        echo('pr.approved', '#305 approved', SINCE + 5),
        echo('clone.done', 'Clone finished', SINCE - 5, 'The repository is ready.'),
        echo('clone.done', 'Clone finished', SINCE + 5, 'The repository is ready.'),
        echo('clone.done', 'Clone failed', SINCE + 6, 'fatal: repository not found'),
      ];
      const away = whileAwayOf({ prs: [], notifs, ledger: [], readyKeys: [] }, SINCE);
      expect(away.checksFailed).toEqual({ total: 2, first: 'Checks failed on #305' });
      expect(away.approved).toEqual({ total: 1, first: '#305 approved' });
      expect(away.clones).toEqual([
        { failed: false, detail: '' },
        { failed: true, detail: 'fatal: repository not found' },
      ]);
    });

    it('draws none of the other Echoes, so a merged PR is counted once', () => {
      act(() =>
        useHiveStore.setState((s) => ({
          notifs: [
            ...s.notifs,
            ...(['pr.merged', 'agent.done', 'agent.failed', 'app.update_available', 'app.update_ready'] as const).map(
              (kind) => notif({ kind, title: '#302 merged', createdAt: SINCE + 5, action: { type: 'none' } }),
            ),
          ],
        })),
      );
      const { result } = renderHook(() => useWhileAway(SINCE));
      expect(result.current.hatched.numbers).toEqual([302, 303]);
      expect(result.current.goals).toEqual(['pty-resize goal done']);
      expect(result.current.checksFailed).toEqual({ total: 0 });
      expect(result.current.approved).toEqual({ total: 0 });
      expect(result.current.clones).toEqual([]);
    });

    it('counts a run cut off by its budget or its turns as failed', () => {
      const ledger = [run('r1', SINCE + 1, 'budget'), run('r2', SINCE + 2, 'turns'), run('r3', SINCE + 3, 'asking')];
      expect(whileAwayOf({ prs: [], notifs: [], ledger, readyKeys: [] }, SINCE).runs).toEqual({ total: 3, failed: 2 });
    });

    it('names no merging party when no closed post covers every PR', () => {
      act(() => useHiveStore.setState((s) => ({ ledger: s.ledger.filter((e) => e.id !== 'c303') })));
      expect(renderHook(() => useWhileAway(SINCE)).result.current.hatched).toEqual({
        numbers: [302, 303],
      });
    });

    it('names ready tickets with no session, the first two keys and the total', () => {
      expect(
        whileAwayOf({ prs: [], notifs: [], ledger: [], readyKeys: ['A-1', 'B-2', 'C-3'] }, SINCE).ready,
      ).toEqual({ keys: ['A-1', 'B-2'], total: 3 });
    });

    it('reads todo tickets with no live session from the store', () => {
      const ticket = (key: string) => ({
        key,
        status: 'To Do',
        statusCategory: 'todo' as const,
        title: key,
        priority: null,
        assignee: null,
      });
      // GRAC-3018 has a fixture session in seedDemoFleet; a fresh todo key has none.
      act(() => useHiveStore.setState({ tickets: [ticket('NEW-1'), ticket('GRAC-3018')] }));
      expect(renderHook(() => useWhileAway(SINCE)).result.current.ready).toEqual({
        keys: ['NEW-1'],
        total: 1,
      });
    });

    it('holds its identity across terminal output', () => {
      const { result } = renderHook(() => useWhileAway(SINCE));
      const first = result.current;
      act(() =>
        useHiveStore.getState().appendEntityLines('hero-refresh', [{ text: 'more', color: 'ink' }]),
      );
      expect(result.current).toBe(first);
    });
  });
});

describe('listed (HIVE-211): no list without items', () => {
  const jiraIssue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
    key: 'HIVE-1',
    summary: 'A real ticket',
    status: 'In Progress',
    statusCategory: 'in-progress',
    issueType: 'Story',
    priority: 'Medium',
    assignee: 'Yunid Bauza',
    updated: '2026-08-07T00:00:00.000-0400',
    url: 'https://behiques.atlassian.net/browse/HIVE-1',
    ...over,
  });

  beforeEach(() => useHiveStore.getState().reset());
  afterEach(() => resetProjectConfig());

  it('Work is listed while loading and with tickets, not when unconfigured, failed or empty', () => {
    const { result, rerender } = renderHook(() => useWorkListed());
    expect(result.current).toBe(true); // loading: the skeleton is the message
    act(() => useHiveStore.setState({ ticketSource: { kind: 'unconfigured' } }));
    rerender();
    expect(result.current).toBe(false);
    act(() => useHiveStore.setState({ ticketSource: { kind: 'failed', message: 'x' } }));
    rerender();
    expect(result.current).toBe(false);
    act(() =>
      useHiveStore.setState({ ticketSource: { kind: 'live', stale: false, capped: false }, tickets: [] }),
    );
    rerender();
    expect(result.current).toBe(false);
    act(() => useHiveStore.getState().hydrateTickets([jiraIssue()], false));
    rerender();
    expect(result.current).toBe(true);
  });

  it('PRs are listed while loading and with PRs only', () => {
    const { result, rerender } = renderHook(() => usePrsListed());
    expect(result.current).toBe(true);
    act(() => useHiveStore.setState({ prSource: { kind: 'unconfigured', message: 'm', reason: 'unauthenticated' } }));
    rerender();
    expect(result.current).toBe(false);
    act(() => useHiveStore.setState({ prSource: { kind: 'failed', message: 'x' } }));
    rerender();
    expect(result.current).toBe(false);
    act(() => useHiveStore.setState({ prSource: { kind: 'live', stale: false, repos: 1 }, prs: [] }));
    rerender();
    expect(result.current).toBe(false);
    act(() => useHiveStore.setState({ prs: [prRecord()] }));
    rerender();
    expect(result.current).toBe(true);
  });

  it('Agents are listed once one agent exists', () => {
    const { result, rerender } = renderHook(() => useAgentsListed());
    expect(result.current).toBe(false);
    act(() => {
      seedDemoFleet();
    });
    rerender();
    expect(result.current).toBe(true);
  });

  it('Sessions are listed once one project is configured', () => {
    setProjectConfigForTest(emptySnapshot('/tmp/hive/config.json'));
    const { result, rerender } = renderHook(() => useSessionsListed());
    expect(result.current).toBe(false);
    act(() => seedDemoProjectConfig());
    rerender();
    expect(result.current).toBe(true);
  });
});
