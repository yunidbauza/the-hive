import { beforeEach, describe, expect, it } from 'vitest';

import { isAgent, isSession } from '@/types/entity';
import type { AgentSummary } from '@shared/agent-contract';
import type { GhResult, PrsSnapshot } from '@shared/github-contract';
import { CH } from '@shared/ipc-contract';
import type { LedgerEntry } from '@shared/ledger-contract';
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

  it('leaves a purely local concern untouched: tickets, metrics and the console transcript', () => {
    // A session has to exist for `setSessionMetrics` to accept a report —
    // `hydrateSessions` first, then the store's own writer for the slice, so
    // this is a real entry rather than an empty default a buggy clear could
    // coincidentally match.
    state().hydrateSessions([sessionRecord({ id: 'sess-01' })]);
    state().setSessionMetrics('sess-01', { model: 'Opus 4.5', effort: 'high' });
    const ticketsBefore = state().tickets;
    const metricsBefore = state().metrics;
    const orchLinesBefore = state().orchLines;

    state().clearModeEntities();

    expect(state().tickets).toBe(ticketsBefore);
    expect(state().metrics).toBe(metricsBefore);
    expect(state().metrics['sess-01']).toEqual({ model: 'Opus 4.5', effort: 'high' });
    expect(state().orchLines).toBe(orchLinesBefore);
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
