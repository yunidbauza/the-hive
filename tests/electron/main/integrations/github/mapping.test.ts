// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  collectPrs,
  collectSearchPrs,
  countFindings,
  readViewerLogin,
  toChecks,
  toPrRecord,
  toState,
} from '../../../../../electron/main/integrations/github/mapping';

/**
 * GitHub's GraphQL payload to named fields.
 *
 * A table, against recorded shapes. The module is pure — no I/O, and the clock
 * arrives as an argument — which is the whole reason the branchiest part of the
 * integration can be tested without a network.
 */

/** `2026-08-09T12:00:00Z`, as epoch ms. The "now" every case is relative to. */
const NOW = Date.parse('2026-08-09T12:00:00Z');

const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 482,
  title: 'Hero: semantic token refactor',
  url: 'https://github.com/acme/nova-web/pull/482',
  isDraft: false,
  state: 'OPEN',
  reviewDecision: null,
  headRefName: 'feat/hero-refresh',
  updatedAt: '2026-08-09T11:00:00Z',
  mergedAt: null,
  author: { login: 'octocat' },
  repository: { name: 'nova-web', owner: { login: 'acme' } },
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  ...over,
});

describe('readViewerLogin', () => {
  it('reads the account the token belongs to', () => {
    expect(readViewerLogin({ viewer: { login: 'octocat' } })).toBe('octocat');
  });

  it.each([undefined, null, {}, { viewer: null }, { viewer: { login: '  ' } }])(
    'answers null for %s',
    (payload) => {
      expect(readViewerLogin(payload)).toBeNull();
    },
  );
});

describe('toState', () => {
  it('reads a merged PR as merged, whatever else it says', () => {
    expect(toState(node({ state: 'MERGED', isDraft: true }))).toBe('merged');
  });

  /**
   * Draft beats approved. A draft cannot be merged, so showing "approved" on
   * one would name the wrong blocker.
   */
  it('reads a draft as draft even when approved', () => {
    expect(toState(node({ isDraft: true, reviewDecision: 'APPROVED' }))).toBe(
      'draft',
    );
  });

  it('reads an approved PR as approved', () => {
    expect(toState(node({ reviewDecision: 'APPROVED' }))).toBe('approved');
  });

  it.each([null, 'REVIEW_REQUIRED', 'CHANGES_REQUESTED'])(
    'reads reviewDecision %s as open',
    (reviewDecision) => {
      expect(toState(node({ reviewDecision }))).toBe('open');
    },
  );

  it('reads an unreadable node as open rather than throwing', () => {
    expect(toState('not a node')).toBe('open');
  });
});

describe('countFindings', () => {
  it('counts only the unresolved threads', () => {
    const raw = node({
      reviewThreads: {
        nodes: [
          { isResolved: false },
          { isResolved: true },
          { isResolved: false },
        ],
      },
    });

    expect(countFindings(raw)).toBe(2);
  });

  /**
   * Outdated threads count. GitHub marks a thread outdated when the code under
   * it moves, which is what happens when an agent pushes a fix *without*
   * resolving the conversation — exactly the case the badge exists to catch.
   */
  it('counts an outdated but unresolved thread', () => {
    const raw = node({
      reviewThreads: { nodes: [{ isResolved: false, isOutdated: true }] },
    });

    expect(countFindings(raw)).toBe(1);
  });

  it.each([
    ['no threads', node({ reviewThreads: { nodes: [] } })],
    ['a null connection', node({ reviewThreads: null })],
    ['a missing field', node({ reviewThreads: undefined })],
  ])('answers 0 for %s', (_label, raw) => {
    expect(countFindings(raw)).toBe(0);
  });
});

describe('toChecks', () => {
  const withRollup = (state: string | null) =>
    node({
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: state === null ? null : { state },
            },
          },
        ],
      },
    });

  it.each([
    ['SUCCESS', 'passing'],
    ['PENDING', 'running'],
    ['EXPECTED', 'running'],
    ['FAILURE', 'failing'],
    ['ERROR', 'failing'],
  ] as const)('reads %s as %s', (rollup, expected) => {
    expect(toChecks(withRollup(rollup))).toBe(expected);
  });

  /**
   * No rollup is `passing`, which is the state that produces **no badge**.
   *
   * That is a reading, not a shrug: `statusCheckRollup` is null for every PR in
   * a repository without CI, and mapping those to `running` would pin a
   * permanent "checks running" pill on them that could never resolve.
   */
  it('reads a repository with no checks as passing', () => {
    expect(toChecks(withRollup(null))).toBe('passing');
    expect(toChecks(node({ commits: { nodes: [] } }))).toBe('passing');
  });
});

describe('toPrRecord', () => {
  it('maps the named fields and nothing else', () => {
    expect(toPrRecord(node())).toEqual({
      number: 482,
      title: 'Hero: semantic token refactor',
      url: 'https://github.com/acme/nova-web/pull/482',
      repo: 'nova-web',
      owner: 'acme',
      branch: 'feat/hero-refresh',
      state: 'open',
      findings: 0,
      checks: 'passing',
      updatedAt: '2026-08-09T11:00:00Z',
    });
  });

  /**
   * The repository comes off the node now, because search answers with one flat
   * list spanning every repo in the expression — there is no index left that
   * says where a result came from. A node that cannot say is one this app has
   * nowhere to put.
   */
  it('takes the repository from the node itself', () => {
    const record = toPrRecord(
      node({ repository: { name: 'referral-api', owner: { login: 'other' } } }),
    );

    expect(record).toMatchObject({ repo: 'referral-api', owner: 'other' });
  });

  /**
   * A PR it cannot read costs itself and nothing else. A sweep of forty where
   * the ninth has no branch renders thirty-nine rows, not an error.
   */
  it.each([
    ['no number', { number: undefined }],
    ['a fractional number', { number: 4.5 }],
    ['no title', { title: '' }],
    ['no url', { url: null }],
    ['no branch', { headRefName: undefined }],
    ['no updatedAt', { updatedAt: '   ' }],
    ['no repository', { repository: undefined }],
    ['a null repository', { repository: null }],
    ['a repository with no name', { repository: { owner: { login: 'acme' } } }],
    ['a repository with no owner', { repository: { name: 'nova-web' } }],
  ])('answers null for a node with %s', (_label, over) => {
    expect(toPrRecord(node(over))).toBeNull();
  });

  /**
   * A search over `type: ISSUE` also answers with issues, which the inline
   * `... on PullRequest` fragment leaves as bare `{}`. That is a routine
   * outcome here rather than a corruption.
   */
  it('answers null for something that is not a pull request', () => {
    expect(toPrRecord({})).toBeNull();
    expect(toPrRecord(null)).toBeNull();
    expect(toPrRecord([1, 2])).toBeNull();
  });
});

describe('collectPrs', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    viewer: { login: 'octocat' },
    open: { nodes: [node()] },
    merged: { nodes: [] },
    ...over,
  });

  it('reads both search connections', () => {
    const prs = collectPrs(payload(), 'octocat', NOW);

    expect(prs.map((pr) => pr.number)).toEqual([482]);
  });

  /**
   * The search already asked for `author:@me`, so this is the second of two
   * independent mechanisms rather than the one that defines the list. It is kept
   * because it costs a comparison and it is what would catch a search expression
   * that failed to scope the way it was meant to.
   */
  it('drops PRs authored by anyone else', () => {
    const prs = collectPrs(
      payload({ open: { nodes: [node({ author: { login: 'someone' } })] } }),
      'octocat',
      NOW,
    );

    expect(prs).toEqual([]);
  });

  /**
   * The nodes now span every repository in one list, so the records have to come
   * out attributed individually.
   */
  it('attributes each node to its own repository', () => {
    const prs = collectPrs(
      payload({
        open: {
          nodes: [
            node({ number: 1, updatedAt: '2026-08-09T09:00:00Z' }),
            node({
              number: 2,
              updatedAt: '2026-08-09T11:30:00Z',
              repository: { name: 'referral-api', owner: { login: 'other' } },
            }),
          ],
        },
      }),
      'octocat',
      NOW,
    );

    expect(prs.map((pr) => [pr.number, pr.repo])).toEqual([
      [2, 'referral-api'],
      [1, 'nova-web'],
    ]);
  });

  it('keeps a PR merged inside the 24h window', () => {
    const prs = collectPrs(
      payload({
        open: { nodes: [] },
        merged: {
          nodes: [
            node({
              number: 77,
              state: 'MERGED',
              mergedAt: '2026-08-09T02:00:00Z',
            }),
          ],
        },
      }),
      'octocat',
      NOW,
    );

    expect(prs.map((pr) => pr.number)).toEqual([77]);
    expect(prs[0].state).toBe('merged');
  });

  it('drops a PR merged before the window', () => {
    const prs = collectPrs(
      payload({
        open: { nodes: [] },
        merged: {
          nodes: [
            node({
              number: 77,
              state: 'MERGED',
              mergedAt: '2026-08-07T02:00:00Z',
            }),
          ],
        },
      }),
      'octocat',
      NOW,
    );

    expect(prs).toEqual([]);
  });

  it('drops a merged PR with an unreadable mergedAt', () => {
    const prs = collectPrs(
      payload({
        open: { nodes: [] },
        merged: {
          nodes: [node({ state: 'MERGED', mergedAt: 'the day before' })],
        },
      }),
      'octocat',
      NOW,
    );

    expect(prs).toEqual([]);
  });

  /**
   * Live work first, then what landed — each group newest first. Sorting by
   * time alone would let a PR merged five minutes ago sit above one waiting on
   * the user right now.
   */
  it('orders live work above merged, each newest first', () => {
    const prs = collectPrs(
      payload({
        open: {
          nodes: [
            node({ number: 1, updatedAt: '2026-08-09T09:00:00Z' }),
            node({ number: 2, updatedAt: '2026-08-09T11:30:00Z' }),
          ],
        },
        merged: {
          nodes: [
            node({
              number: 3,
              state: 'MERGED',
              updatedAt: '2026-08-09T11:59:00Z',
              mergedAt: '2026-08-09T11:59:00Z',
            }),
          ],
        },
      }),
      'octocat',
      NOW,
    );

    expect(prs.map((pr) => pr.number)).toEqual([2, 1, 3]);
  });

  /**
   * Partial data survives. GraphQL answers a field it could not resolve with
   * `null` and an error beside it, while the sibling field carries real nodes;
   * losing the half that answered would be the wrong trade.
   */
  it('keeps the connection that answered when its sibling did not', () => {
    const prs = collectPrs(payload({ merged: null }), 'octocat', NOW);

    expect(prs.map((pr) => pr.number)).toEqual([482]);
  });

  it.each([
    ['a missing connection', { open: undefined }],
    ['a connection with no nodes array', { open: { nodes: null } }],
  ])('contributes nothing for %s', (_label, over) => {
    const prs = collectPrs(payload(over), 'octocat', NOW);

    expect(prs).toEqual([]);
  });

  it('answers an empty list for a payload it cannot read', () => {
    expect(collectPrs(null, 'octocat', NOW)).toEqual([]);
  });
});

/**
 * The search reading of the same payload.
 *
 * Every test here is about a filter that is deliberately **absent**, because
 * each one would silently discard exactly what the user asked for.
 */
describe('collectSearchPrs', () => {
  const NODE = {
    number: 482,
    title: 'carapace plates',
    url: 'https://github.com/acme/nova-web/pull/482',
    isDraft: false,
    state: 'OPEN',
    reviewDecision: null,
    headRefName: 'feat/plates',
    updatedAt: '2026-08-10T10:00:00Z',
    mergedAt: null,
    author: { login: 'someone-else' },
    repository: { name: 'nova-web', owner: { login: 'acme' } },
    reviewThreads: { nodes: [] },
    commits: { nodes: [] },
  };

  it('keeps a PR written by someone else', () => {
    const prs = collectSearchPrs({ open: { nodes: [NODE] }, merged: { nodes: [] } });

    // The author check `collectPrs` applies would discard every result a search
    // exists to find.
    expect(prs.map((pr) => pr.number)).toEqual([482]);
  });

  it('keeps a merged PR however old it is', () => {
    const ancient = {
      ...NODE,
      number: 12,
      state: 'MERGED',
      mergedAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    };

    const prs = collectSearchPrs({ open: { nodes: [] }, merged: { nodes: [ancient] } });

    // The sweep's twenty-four hour window is about a *standing list*. A search
    // is a question, and hiding the answer would look like a broken search.
    expect(prs.map((pr) => pr.number)).toEqual([12]);
  });

  it('stacks open above merged, newest first within each', () => {
    const prs = collectSearchPrs({
      open: {
        nodes: [
          { ...NODE, number: 1, updatedAt: '2026-08-09T09:00:00Z' },
          { ...NODE, number: 2, updatedAt: '2026-08-10T09:00:00Z' },
        ],
      },
      merged: {
        nodes: [
          {
            ...NODE,
            number: 3,
            state: 'MERGED',
            mergedAt: '2026-08-10T08:00:00Z',
          },
        ],
      },
    });

    expect(prs.map((pr) => pr.number)).toEqual([2, 1, 3]);
  });

  it('answers empty for a payload with nothing in it', () => {
    expect(collectSearchPrs(null)).toEqual([]);
    expect(collectSearchPrs({})).toEqual([]);
  });
});
