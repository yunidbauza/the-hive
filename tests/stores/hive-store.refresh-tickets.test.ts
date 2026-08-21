import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useHiveStore } from '@stores/hive-store';
import type { JiraStatus } from '@shared/jira-contract';

/**
 * `refreshTickets` (HIVE-69).
 *
 * The orchestration between "what is configured" and "what the panel shows".
 * `lib/jira` is mocked because what is under test is the *decision tree* — which
 * of the three actions each answer produces — and the verbs themselves have
 * their own suite.
 */

const readJiraStatus = vi.fn<() => Promise<JiraStatus | null>>();
const searchJiraIssues = vi.fn();

vi.mock('@/lib/jira', () => ({
  readJiraStatus: () => readJiraStatus(),
  searchJiraIssues: (request?: unknown) => searchJiraIssues(request),
  saveJiraToken: () => Promise.resolve(null),
  clearJiraToken: () => Promise.resolve(null),
  testJiraConnection: () => Promise.resolve(null),
  readJiraIssue: () => Promise.resolve(null),
}));

const status = (over: Partial<JiraStatus> = {}): JiraStatus => ({
  site: 'behiques.atlassian.net',
  email: 'me@example.com',
  siteSource: 'config',
  emailSource: 'config',
  credential: { kind: 'stored', email: 'me@example.com' },
  encryptionAvailable: true,
  ...over,
});

const issue = {
  key: 'HIVE-1',
  summary: 'A real ticket',
  status: 'In Progress',
  statusCategory: 'in-progress' as const,
  issueType: 'Story',
  priority: null,
  assignee: null,
  updated: '2026-08-07T00:00:00.000-0400',
  url: 'https://behiques.atlassian.net/browse/HIVE-1',
};

const state = () => useHiveStore.getState();

/** `isDesktop()` feature-detects `window.hive`. */
const asDesktop = (): void => {
  window.hive = {} as NonNullable<Window['hive']>;
};

beforeEach(() => {
  vi.clearAllMocks();
  state().reset();
  readJiraStatus.mockResolvedValue(status());
  searchJiraIssues.mockResolvedValue({
    ok: true,
    value: { issues: [issue], capped: false },
  });
});

afterEach(() => {
  delete window.hive;
});

describe('the browser target', () => {
  /**
   * A browser has no bridge, so it has no Jira — which is a configuration
   * answer, not a failure and not a demo.
   *
   * This used to assert the opposite: the read returned early and left the
   * eight seeded tickets in place, because in the browser they *were* the data.
   * With no seed, an early return would strand the panel on `loading` forever,
   * spinning for a read that is never going to happen.
   */
  it('settles on unconfigured without asking', async () => {
    await state().refreshTickets();

    expect(readJiraStatus).not.toHaveBeenCalled();
    expect(state().ticketSource).toEqual({ kind: 'unconfigured' });
    expect(state().tickets).toEqual([]);
  });
});

describe('on desktop', () => {
  beforeEach(asDesktop);

  it('hydrates from a successful search', async () => {
    await state().refreshTickets();

    expect(state().tickets.map((t) => t.key)).toEqual(['HIVE-1']);
    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: false,
      capped: false,
    });
  });

  /**
   * A settled `live` result does not flash back to the skeleton on reopen.
   *
   * The guard keyed on `tickets.length === 0` at first, which reads a successful
   * read that matched nothing as "nothing yet". Reopening the WORK tab then
   * replaced "No issues matched your query." — a real answer — with three
   * pulsing placeholders for the length of a round trip. It keys on the source
   * now, so `live` stays `live` while the next read is in flight.
   */
  it('stays live across a refresh that returns nothing', async () => {
    searchJiraIssues.mockResolvedValue({
      ok: true,
      value: { issues: [], capped: false },
    });
    await state().refreshTickets();
    expect(state().tickets).toEqual([]);
    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: false,
      capped: false,
    });

    // The reopen. An empty live list must not be mistaken for "not read yet".
    const refresh = state().refreshTickets();
    expect(state().ticketSource).not.toEqual({ kind: 'loading' });
    await refresh;
  });

  it('sends no jql — the override is applied in main', async () => {
    await state().refreshTickets();

    // Passing it from here would mean the store holding a setting and racing a
    // hand-edit of the file, for a value main has in front of it anyway.
    expect(searchJiraIssues).toHaveBeenCalledTimes(1);
    expect(searchJiraIssues.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('carries capped through to the source', async () => {
    searchJiraIssues.mockResolvedValue({
      ok: true,
      value: { issues: [issue], capped: true },
    });

    await state().refreshTickets();

    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: false,
      capped: true,
    });
  });

  for (const [label, over] of [
    ['no site', { site: null }],
    ['no email', { email: null }],
    ['no credential', { credential: { kind: 'none' as const } }],
    [
      'no keyring and no env token',
      { credential: { kind: 'unavailable' as const, reason: 'no keyring' } },
    ],
  ] as [string, Partial<JiraStatus>][]) {
    it(`reports unconfigured with ${label}, without searching`, async () => {
      readJiraStatus.mockResolvedValue(status(over));

      await state().refreshTickets();

      expect(searchJiraIssues).not.toHaveBeenCalled();
      expect(state().ticketSource).toEqual({ kind: 'unconfigured' });
    });
  }

  it('accepts an environment credential as configured', async () => {
    readJiraStatus.mockResolvedValue(
      status({ credential: { kind: 'env', variable: 'JIRA_API_KEY' } }),
    );

    await state().refreshTickets();

    expect(state().ticketSource).toMatchObject({ kind: 'live' });
  });

  it("reports Jira's own message when the search is refused", async () => {
    searchJiraIssues.mockResolvedValue({
      ok: false,
      error: { kind: 'bad-query', message: "Jira could not parse that." },
    });

    await state().refreshTickets();

    expect(state().ticketSource).toEqual({
      kind: 'failed',
      message: "Jira could not parse that.",
    });
  });

  it('reports a broken channel distinctly from a Jira refusal', async () => {
    readJiraStatus.mockResolvedValue(null);

    await state().refreshTickets();

    expect(state().ticketSource).toEqual({
      kind: 'failed',
      message: 'The app could not reach its own main process.',
    });
  });

  it('reports a broken channel on the search hop too', async () => {
    searchJiraIssues.mockResolvedValue(null);

    await state().refreshTickets();

    expect(state().ticketSource).toMatchObject({ kind: 'failed' });
  });

  it('keeps the last good tickets when a later refresh fails', async () => {
    await state().refreshTickets();
    expect(state().tickets).toHaveLength(1);

    searchJiraIssues.mockResolvedValue({
      ok: false,
      error: { kind: 'offline', message: 'Could not reach Jira.' },
    });
    await state().refreshTickets();

    // Staleness over emptiness, end to end.
    expect(state().tickets).toHaveLength(1);
    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: true,
      capped: false,
    });
  });

  it('never throws, whatever the verbs answer', async () => {
    readJiraStatus.mockResolvedValue(null);
    await expect(state().refreshTickets()).resolves.toBeUndefined();
  });
});

/**
 * The poller's sweeps (HIVE-81 review).
 *
 * `refreshTickets` ran once on mount when it was written. It now runs every
 * minute for the life of the app, and two of its habits only became bugs when
 * that changed.
 */
describe('a repeated sweep', () => {
  beforeEach(asDesktop);

  /**
   * On a machine with no Jira configured, or any machine during an outage, the
   * source is `unconfigured`/`failed` and *stays* that way. Re-announcing
   * `loading` on each sweep put three pulsing skeleton rows over the panel's
   * explanation once a minute, forever. `refreshPrs` never does this; the two
   * now agree that `loading` means "the first read, with nothing to show yet".
   */
  it('does not re-enter loading over an unconfigured answer', async () => {
    readJiraStatus.mockResolvedValue(status({ site: null }));
    await state().refreshTickets();
    expect(state().ticketSource).toEqual({ kind: 'unconfigured' });

    const sweep = state().refreshTickets();
    expect(state().ticketSource).toEqual({ kind: 'unconfigured' });
    await sweep;
  });

  it('does not re-enter loading over a failure', async () => {
    searchJiraIssues.mockResolvedValue({
      ok: false,
      error: { kind: 'offline', message: 'Could not reach Jira.' },
    });
    await state().refreshTickets();
    expect(state().ticketSource).toMatchObject({ kind: 'failed' });

    const sweep = state().refreshTickets();
    // The retry button lives inside the `failed` branch. A skeleton here is the
    // button vanishing from under the cursor for the length of a round trip.
    expect(state().ticketSource).toMatchObject({ kind: 'failed' });
    await sweep;
  });

  /**
   * `usePoller` dedups its own ticks; the WORK panel's "Try again" calls this
   * action directly and used to sail past that. Two concurrent Jira searches,
   * and if the retry answered first while the older sweep then failed,
   * `reportTicketFailure` marked the just-installed fresh list stale — a "may
   * be out of date" banner over data a second old. `refreshPrs` shares its
   * promise for exactly this reason.
   */
  it('shares one sweep between a tick and a retry', async () => {
    let settle: ((value: unknown) => void) | undefined;
    searchJiraIssues.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );

    const tick = state().refreshTickets();
    const retry = state().refreshTickets();
    await Promise.resolve();
    await Promise.resolve();

    settle?.({ ok: true, value: { issues: [issue], capped: false } });
    await Promise.all([tick, retry]);

    expect(readJiraStatus).toHaveBeenCalledTimes(1);
    expect(searchJiraIssues).toHaveBeenCalledTimes(1);
    expect(state().ticketSource).toEqual({
      kind: 'live',
      stale: false,
      capped: false,
    });
  });

  it('starts a fresh sweep once the shared one has settled', async () => {
    await state().refreshTickets();
    await state().refreshTickets();

    expect(searchJiraIssues).toHaveBeenCalledTimes(2);
  });

  /**
   * A sweep from the previous state must not install its answer into the new
   * one — the same reason `reset` drops `inFlightPrSweep`.
   */
  it('drops the in-flight handle on reset', async () => {
    const first = state().refreshTickets();
    state().reset();
    await first;

    asDesktop();
    await state().refreshTickets();

    expect(searchJiraIssues).toHaveBeenCalledTimes(2);
  });
});
