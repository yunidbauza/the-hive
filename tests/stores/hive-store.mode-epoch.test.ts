import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GhResult, PrsSnapshot } from '@shared/github-contract';
import { CH } from '@shared/ipc-contract';
import type { JiraStatus } from '@shared/jira-contract';
import { useHiveStore } from '@stores/hive-store';

import { prRecord } from '@tests/support/prs';

/**
 * The mode epoch (HIVE-152).
 *
 * A sweep asks one machine and answers about it some seconds later. Nothing in
 * `refreshPrs`/`refreshTickets` used to record *which* machine it had asked, so
 * a sweep that started before a mode switch installed the departed machine's
 * answer into the newly attached view — and `hydratePrs` **replaces** rather
 * than merges, deliberately, so the overwrite was total.
 *
 * Every case here drives a genuinely deferred sweep across a real
 * `applyModeChange` and resolves it afterwards. A test that resolves the sweep
 * before the switch proves nothing: the whole bug lives in the window between
 * the request going out and its answer coming back, so the resolve has to
 * happen on the far side of the switch or there is no race to catch.
 */

const readPullRequests = vi.fn<() => Promise<GhResult<PrsSnapshot> | null>>();
const searchPullRequests = vi.fn();

vi.mock('@/lib/github', () => ({
  readPullRequests: () => readPullRequests(),
  searchPullRequests: (term: string, projectId?: string) =>
    searchPullRequests(term, projectId),
}));

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

/**
 * The IPC half of `hydratePrs`, and the reason this story is not merely
 * cosmetic: a late sweep does not only paint the departed fleet's PRs, it
 * writes them onto the attached machine's sessions and tells main. That write
 * is the one harm here the next sweep does not undo.
 */
const noteSessionPr = vi.fn();

vi.mock('@lib/session-history', () => ({
  noteSessionPr: (request: unknown) => noteSessionPr(request),
  noteSessionTicket: vi.fn(),
  readSessionHistory: vi.fn(),
}));

const state = () => useHiveStore.getState();

/** A promise this test resolves by hand, which is the whole point. */
const deferred = <T>() => {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
};

const prsOk = (prs: PrsSnapshot['prs'], repos: number): GhResult<PrsSnapshot> => ({
  ok: true,
  value: { prs, repos },
});

const jiraStatus = (): JiraStatus => ({
  site: 'behiques.atlassian.net',
  email: 'me@example.com',
  siteSource: 'config',
  emailSource: 'config',
  credential: { kind: 'stored', email: 'me@example.com' },
  encryptionAvailable: true,
});

const issue = (key: string) => ({
  key,
  summary: `about ${key}`,
  status: 'In Progress',
  statusCategory: 'in-progress' as const,
  issueType: 'Story',
  priority: null,
  assignee: null,
  updated: '2026-09-09T00:00:00.000-0400',
  url: `https://behiques.atlassian.net/browse/${key}`,
});

/** `isDesktop()` feature-detects `window.hive`; every sweep below needs it. */
const asDesktop = (): void => {
  window.hive = {} as NonNullable<Window['hive']>;
};

/** Attach to the other machine, seeding the PR list it sent with its snapshot. */
const attachWithPrs = (prs: PrsSnapshot['prs'], repos = 1): void => {
  state().applyModeChange({
    to: 'remote',
    snapshot: { [CH.githubPrs]: prsOk(prs, repos) },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  state().reset();
  asDesktop();
  readJiraStatus.mockResolvedValue(jiraStatus());
});

describe('a PR sweep that outlives the mode switch it started under', () => {
  it('cannot replace the attached machine’s PRs with the departed one’s', async () => {
    const gh = deferred<GhResult<PrsSnapshot>>();
    readPullRequests.mockReturnValue(gh.promise);

    // Out over the local machine.
    const sweep = state().refreshPrs();
    attachWithPrs([prRecord({ number: 2, repo: 'attached-repo' })]);

    // ...and answers about the local machine, after the window is showing the
    // remote one.
    gh.settle(prsOk([prRecord({ number: 1, repo: 'departed-repo' })], 9));
    await sweep;

    expect(state().prs.map((pr) => pr.repo)).toEqual(['attached-repo']);
    expect(state().prSource).toEqual({ kind: 'live', stale: false, repos: 1 });
  });

  /**
   * The harm the ticket's own severity note understates. `hydratePrs` computes
   * what the sweep taught the fleet and fires `noteSessionPr` per change,
   * fire-and-forget over IPC. A stale hydrate therefore *writes* the departed
   * machine's PR onto a session on the machine now attached — and session ids
   * collide across machines by construction, so it lands on a real row.
   */
  it('cannot write the departed machine’s PR onto an attached session', async () => {
    const gh = deferred<GhResult<PrsSnapshot>>();
    readPullRequests.mockReturnValue(gh.promise);

    const sweep = state().refreshPrs();

    /*
      The attached machine must own a session the stale PR would *resolve*
      against, or this test passes for the wrong reason: `clearModeEntities`
      empties `entities`, so a switch to `local` leaves `learnSessionPrs`
      nothing to iterate and `noteSessionPr` stays silent whether the epoch
      guard is there or not. Seeding the snapshot with a session on the same
      branch is what makes the write possible, and therefore what makes its
      absence mean something. Ids and branches colliding across machines is
      the norm here, not a contrivance — `nextSpawnId` mints `sess-01`
      everywhere, and a PR branch is a repo fact both machines can check out.
    */
    state().applyModeChange({
      to: 'remote',
      snapshot: {
        [CH.sessionHistory]: [
          {
            id: 'sess-01',
            project: 'nova-web',
            task: '',
            status: 'working',
            createdAt: 1,
            live: true,
            branch: 'feat/hero-refresh',
          },
        ],
      },
    });
    expect(state().entities['sess-01']).toBeDefined();

    gh.settle(prsOk([prRecord()], 1));
    await sweep;

    expect(noteSessionPr).not.toHaveBeenCalled();
    expect(state().entities['sess-01']).not.toMatchObject({
      lastPr: { number: 482 },
    });
  });

  /**
   * Four of the sweep's six exits are failure and unconfigured reports, and
   * guarding only `hydratePrs` would leave every one of them open. A late
   * failure is not a wrong list, it is a "may be out of date" banner over a
   * list that is not out of date at all.
   */
  it('cannot mark the attached machine’s fresh list stale', async () => {
    const gh = deferred<GhResult<PrsSnapshot>>();
    readPullRequests.mockReturnValue(gh.promise);

    const sweep = state().refreshPrs();
    attachWithPrs([prRecord({ number: 2, repo: 'attached-repo' })]);

    gh.settle({ ok: false, error: { kind: 'timeout', message: 'gh timed out' } });
    await sweep;

    expect(state().prSource).toEqual({ kind: 'live', stale: false, repos: 1 });
  });

  /**
   * The other failure shape: the departed machine has no `gh`, the attached
   * one plainly does — it just sent a snapshot full of PRs.
   */
  it('cannot claim the attached machine is unconfigured', async () => {
    const gh = deferred<GhResult<PrsSnapshot>>();
    readPullRequests.mockReturnValue(gh.promise);

    const sweep = state().refreshPrs();
    attachWithPrs([prRecord({ number: 2, repo: 'attached-repo' })]);

    gh.settle({
      ok: false,
      error: { kind: 'not-installed', message: 'gh is not installed' },
    });
    await sweep;

    expect(state().prSource).toEqual({ kind: 'live', stale: false, repos: 1 });
    expect(state().prs.map((pr) => pr.repo)).toEqual(['attached-repo']);
  });
});

/**
 * The ticket sweep suspends **twice** — once on the status read, once on the
 * search — and a switch can land in either window. The two need separate cases
 * or one guard covers for the other: with the status read still out, the first
 * guard retires the sweep before the search is ever issued, so a test written
 * that way stays green with the *second* guard deleted. `startedSearching`
 * below is what puts the switch in the second window on purpose.
 */
describe('a ticket sweep that outlives the mode switch it started under', () => {
  /** Resolve the status read and wait until the sweep is genuinely on the search. */
  const startedSearching = async () => {
    await vi.waitFor(() => {
      expect(searchJiraIssues).toHaveBeenCalled();
    });
  };

  it('cannot replace the attached machine’s tickets with the departed one’s', async () => {
    const jira = deferred<unknown>();
    searchJiraIssues.mockReturnValue(jira.promise);

    const sweep = state().refreshTickets();
    await startedSearching();
    state().applyModeChange({ to: 'local' });

    jira.settle({ ok: true, value: { issues: [issue('OLD-1')], capped: false } });
    await sweep;

    expect(state().tickets).toEqual([]);
  });

  it('cannot mark the attached machine’s tickets stale', async () => {
    const jira = deferred<unknown>();
    searchJiraIssues.mockReturnValue(jira.promise);

    const sweep = state().refreshTickets();
    await startedSearching();
    state().applyModeChange({ to: 'local' });

    jira.settle({ ok: false, error: { message: 'jira timed out' } });
    await sweep;

    expect(state().ticketSource).toEqual({ kind: 'loading' });
  });

  /**
   * The status read is the sweep's *first* hop, so a switch during it retires
   * the sweep before it ever reaches Jira. Guarding only after the search
   * would let this one through.
   */
  it('is retired at the first hop, not just the last', async () => {
    const jira = deferred<JiraStatus | null>();
    readJiraStatus.mockReturnValue(jira.promise);

    const sweep = state().refreshTickets();
    state().applyModeChange({ to: 'local' });

    jira.settle(null);
    await sweep;

    // `null` from the status read is a `reportTicketFailure` call the epoch
    // must have swallowed, and the search below it must never have run.
    expect(state().ticketSource).toEqual({ kind: 'loading' });
    expect(searchJiraIssues).not.toHaveBeenCalled();
  });
});

/**
 * The dedupe handle, which the epoch changes the rules for.
 *
 * `clearModeEntities` drops both handles so the attached view starts its own
 * sweep instead of waiting out a poll interval for one whose answer is already
 * condemned. That is only safe because the epoch has disarmed the condemned
 * sweep first — and it introduces a second-order hazard of its own, below.
 */
describe('the in-flight handle across a switch', () => {
  it('lets the attached machine sweep immediately instead of joining the condemned one', async () => {
    const first = deferred<GhResult<PrsSnapshot>>();
    const second = deferred<GhResult<PrsSnapshot>>();
    readPullRequests.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const condemned = state().refreshPrs();
    state().applyModeChange({ to: 'local' });

    // Not a join: a second `gh` really goes out for the machine now on screen.
    const fresh = state().refreshPrs();
    expect(readPullRequests).toHaveBeenCalledTimes(2);

    first.settle(prsOk([prRecord({ repo: 'departed-repo' })], 9));
    second.settle(prsOk([prRecord({ number: 7, repo: 'attached-repo' })], 3));
    await Promise.all([condemned, fresh]);

    expect(state().prs.map((pr) => pr.repo)).toEqual(['attached-repo']);
    expect(state().prSource).toEqual({ kind: 'live', stale: false, repos: 3 });
  });

  /**
   * The second-order hazard, and the reason `finally` is identity-checked.
   *
   * The condemned sweep settles *after* the fresh one has installed its own
   * handle. An unconditional `inFlightPrSweep = null` in `finally` erases that
   * handle while the fresh sweep is still out, so the next caller starts a
   * third `gh` concurrently — reintroducing by the back door exactly the
   * double-sweep the dedupe exists to prevent. Asserting the call count after
   * the condemned one has settled is what catches it; asserting only the final
   * `prs` would not, because both sweeps agree about the attached machine.
   */
  it('does not let the condemned sweep erase the fresh sweep’s handle when it settles', async () => {
    const condemnedGh = deferred<GhResult<PrsSnapshot>>();
    const freshGh = deferred<GhResult<PrsSnapshot>>();
    readPullRequests
      .mockReturnValueOnce(condemnedGh.promise)
      .mockReturnValueOnce(freshGh.promise);

    const condemned = state().refreshPrs();
    state().applyModeChange({ to: 'local' });
    const fresh = state().refreshPrs();

    // The condemned sweep settles while the fresh one is still out.
    condemnedGh.settle(prsOk([prRecord({ repo: 'departed-repo' })], 9));
    await condemned;

    // A caller arriving now must *join* the fresh sweep, not start a third.
    const joined = state().refreshPrs();
    expect(readPullRequests).toHaveBeenCalledTimes(2);

    freshGh.settle(prsOk([prRecord({ number: 7, repo: 'attached-repo' })], 3));
    await Promise.all([fresh, joined]);

    expect(state().prs.map((pr) => pr.repo)).toEqual(['attached-repo']);
  });
});

/**
 * The search path, one layer down from the sweeps.
 *
 * `searchPrs`/`searchTickets` already carried monotonic tickets against a
 * narrower race — two searches overtaking each other — but nothing bumped them
 * on a mode switch, so the identical cross-machine bug lived here too.
 */
describe('a search across the mode switch', () => {
  it('cannot land the departed machine’s results in the attached view', async () => {
    const hits = deferred<unknown>();
    searchPullRequests.mockReturnValue(hits.promise);

    const search = state().searchPrs('hero', undefined);
    state().applyModeChange({ to: 'local' });

    hits.settle({ ok: true, value: [prRecord({ repo: 'departed-repo' })] });
    await search;

    expect(state().prSearch.results).toBeNull();
    expect(state().prSearch.term).toBe('');
  });

  /**
   * Retiring the request is only half of it. Results that already *landed* are
   * sitting on screen at the instant of the switch, and they are a list of the
   * departed machine's PRs under a term the user typed about that machine —
   * Ruling 22's argument for `metrics`, unchanged.
   */
  it('clears results that had already landed before the switch', async () => {
    searchPullRequests.mockResolvedValue({
      ok: true,
      value: [prRecord({ repo: 'departed-repo' })],
    });

    await state().searchPrs('hero', undefined);
    expect(state().prSearch.results).toHaveLength(1);

    state().applyModeChange({ to: 'local' });

    expect(state().prSearch.results).toBeNull();
    expect(state().prSearch.term).toBe('');
  });
});
