import { beforeEach, describe, expect, it } from 'vitest';

import { isAgent, isSession } from '@/types/entity';
import type { AgentSummary } from '@shared/agent-contract';
import type { GhResult, PrsSnapshot } from '@shared/github-contract';
import { CH } from '@shared/ipc-contract';
import type { LedgerEntry } from '@shared/ledger-contract';
import type { SessionPlan } from '@shared/plan-contract';
import type { SessionHistoryEntry } from '@shared/session-history-contract';
import { useHiveStore } from '@stores/hive-store';

import { notif } from '../support/notifications';
import { prRecord } from '../support/prs';

/**
 * `applyAttachSnapshot` and `clearModeEntities` (HIVE-144).
 *
 * The trap this file is built around: a merge test seeded from an empty store
 * cannot tell merge from replace, because both behaviours produce the same
 * result when there is nothing already there to keep or drop. Every merge
 * case below seeds a pre-existing item the snapshot does *not* mention, and
 * asserts on what happens to *that* item — the thing a replace would lose and
 * a merge would not. Every replace case does the mirror: seeds a pre-existing
 * item, applies a snapshot that omits it, and asserts it is gone.
 */

const state = () => useHiveStore.getState();

const sessionRecord = (
  overrides: Partial<SessionHistoryEntry> = {},
): SessionHistoryEntry => ({
  id: 'sess-01',
  project: 'nova-web',
  task: '',
  status: 'working',
  createdAt: 1,
  ...overrides,
});

const agentSummary = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  name: 'watcher',
  description: 'watches things',
  icon: 'ph-robot',
  status: 'sleeping',
  wake: { on: [] },
  mcp: [],
  tools: [],
  rotateAfter: 50,
  runs: [],
  ...overrides,
});

const ledgerEntry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: '20260830-140000-0001',
  ts: 1,
  from: 'watcher',
  to: 'overmind',
  kind: 'post',
  body: 'hello',
  ...overrides,
});

const prsOk = (prs: PrsSnapshot['prs'], repos: number): GhResult<PrsSnapshot> => ({
  ok: true,
  value: { prs, repos },
});

beforeEach(() => {
  state().reset();
});

describe('applyAttachSnapshot', () => {
  it('merges sessions, so a live entity is not dropped', () => {
    state().hydrateSessions([sessionRecord({ id: 'sess-old' })]);

    state().applyAttachSnapshot({
      [CH.sessionHistory]: [sessionRecord({ id: 'sess-new' })],
    });

    expect(state().entities['sess-old']).toBeDefined();
    expect(state().entities['sess-new']).toBeDefined();
    expect(state().order).toEqual(expect.arrayContaining(['sess-old', 'sess-new']));
  });

  it('unions the ledger tail by id', () => {
    state().hydrateLedger([ledgerEntry({ id: '20260830-140000-0001' })]);

    state().applyAttachSnapshot({
      [CH.ledgerList]: {
        entries: [ledgerEntry({ id: '20260830-140000-0002' })],
        openAsks: [],
        claims: {},
      },
    });

    const ids = state().ledger.map((entry) => entry.id);
    expect(ids).toContain('20260830-140000-0001');
    expect(ids).toContain('20260830-140000-0002');
  });

  it('unions notifications by id', () => {
    state().hydrateNotifs([notif({ id: 'old-notif' })]);

    state().applyAttachSnapshot({
      [CH.notificationsList]: [notif({ id: 'new-notif' })],
    });

    const ids = state().notifs.map((entry) => entry.id);
    expect(ids).toContain('old-notif');
    expect(ids).toContain('new-notif');
  });

  it('replaces agents, because the server snapshot is authoritative', () => {
    state().hydrateAgents([agentSummary({ name: 'old-agent' })]);

    state().applyAttachSnapshot({
      [CH.agentsList]: {
        agents: [agentSummary({ name: 'new-agent' })],
        agentsRoot: '/agents',
      },
    });

    expect(state().entities['old-agent']).toBeUndefined();
    expect(state().entities['new-agent']).toBeDefined();
    expect(state().agentOrder).toEqual(['new-agent']);
  });

  it('replaces PRs for the same reason', () => {
    state().hydratePrs([prRecord({ number: 1, repo: 'old-repo' })], 1);

    state().applyAttachSnapshot({
      [CH.githubPrs]: prsOk([prRecord({ number: 2, repo: 'new-repo' })], 2),
    });

    expect(state().prs.some((pr) => pr.repo === 'old-repo')).toBe(false);
    expect(state().prs.some((pr) => pr.repo === 'new-repo')).toBe(true);
  });

  it('ignores a channel it has no action for rather than throwing', () => {
    // A newer server may send a channel this client does not know.
    expect(() =>
      state().applyAttachSnapshot({ 'some:future': 1 } as never),
    ).not.toThrow();
  });

  it("ignores config:get too — no action in this store hydrates from it", () => {
    const before = {
      entities: state().entities,
      notifs: state().notifs,
      ledger: state().ledger,
      prs: state().prs,
    };

    expect(() =>
      state().applyAttachSnapshot({ [CH.configGet]: { theme: 'dark' } }),
    ).not.toThrow();

    expect(state().entities).toBe(before.entities);
    expect(state().notifs).toBe(before.notifs);
    expect(state().ledger).toBe(before.ledger);
    expect(state().prs).toBe(before.prs);
  });
});

describe('clearModeEntities', () => {
  it("drops the departing mode's sessions", () => {
    state().hydrateSessions([sessionRecord({ id: 'sess-01' })]);
    state().hydrateAgents([agentSummary({ name: 'watcher' })]);
    state().hydrateNotifs([notif({ id: 'n1' })]);
    state().hydrateLedger([ledgerEntry()]);
    state().hydratePrs([prRecord({ number: 1 })], 1);

    state().clearModeEntities();

    expect(state().entities).toEqual({});
    expect(state().order).toEqual([]);
    expect(state().agentOrder).toEqual([]);
    expect(state().notifs).toEqual([]);
    expect(state().ledger).toEqual([]);
    expect(state().prs).toEqual([]);
  });

  /**
   * `metrics` is `Record<sessionId, SessionMetrics>`, and session ids are
   * **not unique across machines**: `nextSpawnId` mints `sess-01`, `sess-02`,
   * … from the same base-36 counter everywhere, so the mode being left and
   * the mode being joined can and do produce the same id. `useSessionMetrics`
   * is a bare id lookup with no check on which mode an entity came from, so a
   * metrics entry surviving the switch would render the *departed* session's
   * model, effort and usage against the *newly attached* session wearing the
   * same id — a wrong number shown with confidence, which is the exact
   * failure Ruling 22 exists to prevent.
   */
  it('clears metrics too, so a session id reused by the joined mode does not inherit a stale value', () => {
    state().hydrateSessions([sessionRecord({ id: 'sess-01' })]);
    state().setSessionMetrics('sess-01', { model: 'stale-local-model', effort: 'low' });

    state().clearModeEntities();
    // The joined mode mints the identical id — this is the collision, not an
    // edge case.
    state().applyAttachSnapshot({
      [CH.sessionHistory]: [sessionRecord({ id: 'sess-01' })],
    });

    expect(state().metrics['sess-01']).toBeUndefined();
  });

  /**
   * `hydratePrs` sets `prs` and `prSource` together as one fact — the source
   * a list of PRs came from. Deleting the `prSource` line from
   * `clearModeEntities` leaves the whole rest of this suite green, which is
   * exactly why it needs its own assertion rather than resting on the
   * reasoning in the doc comment above the action.
   */
  it('resets prSource along with the PRs it describes', () => {
    state().hydratePrs([prRecord({ number: 1 })], 1);
    expect(state().prSource).toEqual({ kind: 'live', stale: false, repos: 1 });

    state().clearModeEntities();

    expect(state().prSource).toEqual({ kind: 'loading' });
  });

  /**
   * `staleTitles` is module state, not a `HiveState` field, but it is keyed
   * by `terminalOf(entity)` — the same not-unique-across-machines id
   * `metrics` is keyed by. `clearSession` stashes the retired row's name
   * there so a repaint of the same title on the *successor* is not mistaken
   * for a real rename; `renameSession` is the only reader, and it suppresses
   * a title that matches the stashed one exactly. Left uncleared, a stashed
   * title for the departed mode's terminal would suppress a genuine rename
   * on the newly attached terminal wearing the same id.
   */
  it('clears staleTitles too, so a reused terminal id can be renamed instead of having a departed title silently suppressed', () => {
    const nameOf = (id: string) => {
      const entity = state().entities[id];
      return entity && isSession(entity) ? entity.name : undefined;
    };

    // A named, live row — `clearSession` refuses an already-ended one.
    state().hydrateSessions([sessionRecord({ id: 'sess-01', live: true })]);
    state().renameSession('sess-01', 'db-migration', 'agent');
    expect(nameOf('sess-01')).toBe('db-migration');

    // Retiring the row stashes its name as `sess-01`'s stale title, for
    // whichever successor terminal `sess-01` becomes.
    state().clearSession('sess-01');

    state().clearModeEntities();
    // The joined mode mints the identical terminal id — the same collision
    // `metrics` has, not a hypothetical.
    state().applyAttachSnapshot({
      [CH.sessionHistory]: [sessionRecord({ id: 'sess-01', live: true })],
    });

    // The exact same title arrives again, this time genuinely — the new
    // session's own first-prompt name, which happens to coincide.
    state().renameSession('sess-01', 'db-migration', 'agent');

    expect(nameOf('sess-01')).toBe('db-migration');
  });

  /**
   * This used to assert `tickets` survived a switch too, alongside the
   * transcript, on the premise that both modes read the same Jira query.
   *
   * That premise was wrong (HIVE-152). `CH.jiraStatus` and `CH.jiraSearch` are
   * `'call'` channels and neither appears in `PROCESS_LOCAL`, so while
   * attached, the site, the account and the JQL are all the **served**
   * machine's. The list under the WORK badge belongs to whichever machine
   * answered, exactly as `prs` does — and it survived only by accident, because
   * the in-flight sweep replaced it within seconds. The epoch now discards that
   * answer, so leaving it would strand the departed machine's issues under a
   * `live` label for a whole poll interval.
   *
   * The console transcript really is purely local, and still is.
   */
  it('leaves the console transcript untouched, which really is purely local', () => {
    const orchLinesBefore = state().orchLines;

    state().clearModeEntities();

    expect(state().orchLines).toBe(orchLinesBefore);
  });

  it('drops the tickets and their source, which belong to whichever machine answered', () => {
    state().hydrateTickets(
      [
        {
          key: 'OLD-1',
          summary: 'from the departed machine',
          status: 'In Progress',
          statusCategory: 'in-progress',
          issueType: 'Story',
          priority: null,
          assignee: null,
          updated: '2026-09-09T00:00:00.000-0400',
          url: 'https://behiques.atlassian.net/browse/OLD-1',
        },
      ],
      false,
    );
    expect(state().ticketSource).toEqual({ kind: 'live', stale: false, capped: false });

    state().clearModeEntities();

    expect(state().tickets).toEqual([]);
    expect(state().ticketSource).toEqual({ kind: 'loading' });
  });
});

describe('clearModeEntities and applyAttachSnapshot as inverses (Ruling 22)', () => {
  it('clear-then-apply leaves the store holding the snapshot and nothing from before', () => {
    // The mode being left.
    state().hydrateSessions([sessionRecord({ id: 'old-sess' })]);
    state().hydrateAgents([agentSummary({ name: 'old-agent' })]);
    state().hydrateNotifs([notif({ id: 'old-notif' })]);
    state().hydrateLedger([ledgerEntry({ id: '20260830-140000-0001' })]);
    state().hydratePrs([prRecord({ number: 1, repo: 'old-repo' })], 1);

    state().clearModeEntities();
    state().applyAttachSnapshot({
      [CH.sessionHistory]: [sessionRecord({ id: 'new-sess' })],
      [CH.agentsList]: { agents: [agentSummary({ name: 'new-agent' })], agentsRoot: '/x' },
      [CH.notificationsList]: [notif({ id: 'new-notif' })],
      [CH.ledgerList]: {
        entries: [ledgerEntry({ id: '20260830-140000-0002' })],
        openAsks: [],
        claims: {},
      },
      [CH.githubPrs]: prsOk([prRecord({ number: 2, repo: 'new-repo' })], 1),
    });

    const sessions = Object.values(state().entities).filter(isSession);
    const agents = Object.values(state().entities).filter(isAgent);

    expect(sessions.map((s) => s.id)).toEqual(['new-sess']);
    expect(agents.map((a) => a.id)).toEqual(['new-agent']);
    expect(state().notifs.map((n) => n.id)).toEqual(['new-notif']);
    expect(state().ledger.map((e) => e.id)).toEqual(['20260830-140000-0002']);
    expect(state().prs.map((pr) => pr.repo)).toEqual(['new-repo']);
  });
});

/**
 * `applyModeChange` — the action a real switch calls (HIVE-144 review, I1).
 *
 * The two actions above had no production caller at all: the whole attach-
 * snapshot path was computed by the server on every accept, sent, parsed and
 * dropped, and nothing cleared entities across a mode switch. This is the
 * seam that fixed it, and these cases ask the two things the pair alone
 * cannot be asked — that the **order** is clear-then-seed, and that the
 * **local** arm clears too.
 */
describe('applyModeChange', () => {
  it('clears the departed fleet and seeds the snapshot, in that order', () => {
    state().hydrateSessions([sessionRecord({ id: 'sess-01', project: 'departed' })]);
    state().hydrateAgents([agentSummary({ name: 'old-agent' })]);

    state().applyModeChange({
      to: 'remote',
      snapshot: {
        [CH.sessionHistory]: [sessionRecord({ id: 'sess-01', project: 'attached' })],
      },
    });

    const sessions = Object.values(state().entities).filter(isSession);
    // One row, from the snapshot — not two, and not the departed one that a
    // seed running before the clear would have wiped. `sess-01` on both sides
    // is the point: `nextSpawnId` mints it identically on every machine.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.project).toBe('attached');
    // The agent the snapshot does not mention is gone, which a seed with no
    // clear in front of it would have left standing.
    expect(Object.values(state().entities).filter(isAgent)).toEqual([]);
  });

  /**
   * The half the review called worse. Coming back to this machine has to
   * clear as well, or the server's fleet lingers on a window that is no
   * longer showing that machine — and `useSessionMetrics(id)` is a bare id
   * lookup, so the departed mode's numbers render against a local session
   * wearing the same id.
   */
  it('clears on the way back to local, where there is no snapshot to seed', () => {
    state().hydrateSessions([sessionRecord({ id: 'sess-01' })]);
    state().hydrateAgents([agentSummary({ name: 'remote-agent' })]);
    state().hydrateNotifs([notif({ id: 'remote-notif' })]);

    state().applyModeChange({ to: 'local' });

    expect(state().entities).toEqual({});
    expect(state().order).toEqual([]);
    expect(state().agentOrder).toEqual([]);
    expect(state().notifs).toEqual([]);
  });
});

/**
 * The plans slice (HIVE-179). Main owns every rule — rank, grace, the drop on
 * every ending — and the store only mirrors it. Keyed by entity id, so it is
 * cleared on a mode switch for the reason `metrics` is.
 */
describe('plans (HIVE-179)', () => {
  const plan = (entityId: string, title = 'Alpha'): SessionPlan => ({
    entityId,
    source: 'task-tools',
    tasks: [{ id: '1', title, status: 'pending' }],
    allDone: false,
  });

  it('setPlan stores a plan and null removes it', () => {
    state().setPlan('sess-01', plan('sess-01'));

    expect(state().plans['sess-01']).toEqual(plan('sess-01'));

    state().setPlan('sess-01', null);

    expect('sess-01' in state().plans).toBe(false);
  });

  it('setPlan null for a session with no plan changes nothing', () => {
    const before = state().plans;

    state().setPlan('sess-09', null);

    expect(state().plans).toBe(before);
  });

  it('hydratePlans merges rather than replaces', () => {
    state().setPlan('sess-01', plan('sess-01'));

    state().hydratePlans([plan('sess-02')]);

    expect(Object.keys(state().plans).sort()).toEqual(['sess-01', 'sess-02']);
  });

  it('applyAttachSnapshot hydrates CH.plansList, merging', () => {
    state().setPlan('sess-old', plan('sess-old'));

    state().applyAttachSnapshot({ [CH.plansList]: { plans: [plan('sess-01')] } });

    expect(state().plans['sess-01']).toEqual(plan('sess-01'));
    expect(state().plans['sess-old']).toEqual(plan('sess-old'));
  });

  it('clearModeEntities clears plans, so a reused session id does not inherit one', () => {
    state().setPlan('sess-01', plan('sess-01', 'stale'));

    state().clearModeEntities();

    expect(state().plans).toEqual({});
  });

  it('reset clears plans', () => {
    state().setPlan('sess-01', plan('sess-01'));

    state().reset();

    expect(state().plans).toEqual({});
  });
});
