// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  collectPrs,
  countFindings,
  readViewerLogin,
  toChecks,
  toPrRecord,
  toState,
} from '../../../../../electron/main/integrations/github/mapping';
import type { RepoRef } from '../../../../../electron/main/integrations/github/query';

/**
 * GitHub's GraphQL payload to named fields.
 *
 * A table, against recorded shapes. The module is pure — no I/O, and the clock
 * arrives as an argument — which is the whole reason the branchiest part of the
 * integration can be tested without a network.
 */

const REPO: RepoRef = { owner: 'acme', name: 'apfm-web' };

/** `2026-08-09T12:00:00Z`, as epoch ms. The "now" every case is relative to. */
const NOW = Date.parse('2026-08-09T12:00:00Z');

const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 482,
  title: 'Hero: semantic token refactor',
  url: 'https://github.com/acme/apfm-web/pull/482',
  isDraft: false,
  state: 'OPEN',
  reviewDecision: null,
  headRefName: 'feat/hero-refresh',
  updatedAt: '2026-08-09T11:00:00Z',
  mergedAt: null,
  author: { login: 'octocat' },
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
    expect(toPrRecord(node(), REPO)).toEqual({
      number: 482,
      title: 'Hero: semantic token refactor',
      url: 'https://github.com/acme/apfm-web/pull/482',
      repo: 'apfm-web',
      owner: 'acme',
      branch: 'feat/hero-refresh',
      state: 'open',
      findings: 0,
      checks: 'passing',
      updatedAt: '2026-08-09T11:00:00Z',
    });
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
  ])('answers null for a node with %s', (_label, over) => {
    expect(toPrRecord(node(over), REPO)).toBeNull();
  });

  it('answers null for something that is not a node at all', () => {
    expect(toPrRecord(null, REPO)).toBeNull();
    expect(toPrRecord([1, 2], REPO)).toBeNull();
  });
});

describe('collectPrs', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    viewer: { login: 'octocat' },
    r0: {
      name: 'apfm-web',
      owner: { login: 'acme' },
      open: { nodes: [node()] },
      merged: { nodes: [] },
      ...over,
    },
  });

  it('reads a repository block by its alias', () => {
    const prs = collectPrs(payload(), [REPO], 'octocat', NOW);

    expect(prs.map((pr) => pr.number)).toEqual([482]);
  });

  /** "Mine" is the whole rule the user chose. Somebody else's PR is not shown. */
  it('drops PRs authored by anyone else', () => {
    const prs = collectPrs(
      payload({ open: { nodes: [node({ author: { login: 'someone' } })] } }),
      [REPO],
      'octocat',
      NOW,
    );

    expect(prs).toEqual([]);
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
      [REPO],
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
      [REPO],
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
      [REPO],
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
      [REPO],
      'octocat',
      NOW,
    );

    expect(prs.map((pr) => pr.number)).toEqual([2, 1, 3]);
  });

  /**
   * Partial data survives. GraphQL answers one inaccessible repository with a
   * `null` block and real data for the rest; losing the rest would be the wrong
   * trade.
   */
  it('skips a repository block that came back null', () => {
    const second: RepoRef = { owner: 'acme', name: 'referral-api' };
    const prs = collectPrs(
      { ...payload(), r1: null },
      [REPO, second],
      'octocat',
      NOW,
    );

    expect(prs.map((pr) => pr.number)).toEqual([482]);
  });

  it('answers an empty list for a payload it cannot read', () => {
    expect(collectPrs(null, [REPO], 'octocat', NOW)).toEqual([]);
  });
});
