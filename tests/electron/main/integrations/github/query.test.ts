// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildPrQuery,
  buildPrVariables,
  repoQualifiers,
  type RepoRef,
} from '../../../../../electron/main/integrations/github/query';

/**
 * The document, the author filter, and the promise that a repository name can
 * only ever be data.
 *
 * That promise is the security-relevant part of this module, so it is asserted
 * directly rather than inferred from the shape of the code — and it now has two
 * halves, because a name travels through two languages: GraphQL, where it is a
 * bound variable, and GitHub's search expression, where it is a `repo:`
 * qualifier and has to be vetted instead.
 */
describe('buildPrQuery', () => {
  /**
   * The whole point of the change. `Repository.pullRequests` has no author
   * argument, so a query built on it can only filter after GitHub has already
   * chosen the page — which is how a user's own PRs went missing from a busy
   * repository.
   */
  it('asks GitHub for the viewer’s own pull requests', () => {
    const { open, merged } = buildPrVariables(['repo:acme/apfm-web']);

    expect(open).toContain('author:@me');
    expect(merged).toContain('author:@me');
    expect(buildPrQuery()).toContain('search(query: $open, type: ISSUE');
    expect(buildPrQuery()).toContain('search(query: $merged, type: ISSUE');
  });

  /**
   * The document no longer varies with the configuration at all. There is no
   * per-repo aliasing left to generate, so there is nowhere for a config value
   * to land even by accident.
   */
  it('is a constant, whatever the configuration is', () => {
    expect(buildPrQuery()).toBe(buildPrQuery());
    expect(buildPrQuery()).toContain('query($open: String!, $merged: String!)');
  });

  it('asks who the token belongs to in the same round trip', () => {
    expect(buildPrQuery()).toContain('viewer { login }');
  });

  it('asks for the fields the badges are made of', () => {
    const query = buildPrQuery();

    expect(query).toContain('reviewThreads(first: 100)');
    expect(query).toContain('statusCheckRollup');
    expect(query).toContain('reviewDecision');
    expect(query).toContain('isDraft');
    expect(query).toContain('mergedAt');
  });

  /**
   * A search result is not addressed by repository the way an aliased block was
   * — the nodes arrive in one flat list — so each has to say where it came from.
   */
  it('asks each node which repository it came from', () => {
    expect(buildPrQuery()).toContain('repository { name owner { login } }');
  });

  /**
   * Two searches, not one. A single connection ordered by `updated-desc` across
   * both states would let a busy week of merges push the user's open PRs off
   * the page, and those are the point of the panel.
   */
  it('pages open and merged separately', () => {
    const query = buildPrQuery();
    const { open, merged } = buildPrVariables(['repo:acme/apfm-web']);

    expect(query).toContain('open: search(query: $open, type: ISSUE, first: 100)');
    expect(query).toContain(
      'merged: search(query: $merged, type: ISSUE, first: 100)',
    );
    expect(open).toContain('is:open');
    expect(merged).toContain('is:merged');
  });

  /** Search defaults to relevance, which is not a thing a PR panel means. */
  it('orders both searches by when they were last updated', () => {
    const { open, merged } = buildPrVariables(['repo:acme/apfm-web']);

    expect(open).toContain('sort:updated-desc');
    expect(merged).toContain('sort:updated-desc');
  });

  /**
   * The twenty-four hour merged window belongs to `mapping.ts`, where it is
   * applied to `mergedAt`. An `updated:` qualifier here would answer a different
   * question — "was this touched recently" — and drop a PR for being quiet.
   */
  it('puts no date qualifier in either expression', () => {
    const { open, merged } = buildPrVariables(['repo:acme/apfm-web']);

    expect(open).not.toContain('updated:');
    expect(merged).not.toContain('updated:');
    expect(open).not.toContain('created:');
    expect(merged).not.toContain('created:');
  });
});

describe('repoQualifiers', () => {
  it('scopes the search to each configured repository', () => {
    expect(
      repoQualifiers([
        { owner: 'acme', name: 'apfm-web' },
        { owner: 'other', name: 'referral-api' },
      ]),
    ).toEqual(['repo:acme/apfm-web', 'repo:other/referral-api']);
  });

  /**
   * The guarantee, restated for the language a name now actually enters.
   *
   * A name cannot reach the GraphQL document — that is structural, the document
   * is a constant. What it *can* reach is the search expression, where a space
   * would end the `repo:` qualifier and start another one. So a name outside the
   * character set GitHub itself permits is dropped rather than escaped: a
   * repository missing from the sweep shows fewer PRs, where a mis-escaped one
   * could widen the search to show anybody's.
   */
  it.each([
    ['a smuggled qualifier', { owner: 'acme', name: 'web is:public' }],
    ['a smuggled author', { owner: 'acme', name: 'web author:someone' }],
    ['a slash', { owner: 'acme', name: 'web/extra' }],
    ['a quote', { owner: 'acme', name: 'web"' }],
    ['a hostile owner', { owner: 'acme is:public', name: 'apfm-web' }],
    ['an empty name', { owner: 'acme', name: '' }],
  ])('drops a repository with %s', (_label, repo: RepoRef) => {
    expect(repoQualifiers([repo])).toEqual([]);
  });

  /** The full set GitHub permits, so no real repository is dropped. */
  it('keeps dots, dashes and underscores', () => {
    expect(
      repoQualifiers([{ owner: 'a-cme_1', name: 'web.js_2-x' }]),
    ).toEqual(['repo:a-cme_1/web.js_2-x']);
  });

  /**
   * The empty list is load-bearing, and `client.ts` is the one that acts on it:
   * an `author:@me` search with no `repo:` scope is a valid query that answers
   * with the user's PRs from every repository they have ever touched.
   */
  it('answers empty when nothing is safe to ask about', () => {
    expect(repoQualifiers([])).toEqual([]);
    expect(repoQualifiers([{ owner: 'a b', name: 'c d' }])).toEqual([]);
  });
});

describe('buildPrVariables', () => {
  it('binds both expressions, scoped to every repository', () => {
    const variables = buildPrVariables([
      'repo:acme/apfm-web',
      'repo:other/referral-api',
    ]);

    expect(variables).toEqual({
      open: 'is:pr author:@me is:open repo:acme/apfm-web repo:other/referral-api sort:updated-desc',
      merged:
        'is:pr author:@me is:merged repo:acme/apfm-web repo:other/referral-api sort:updated-desc',
    });
  });

  /**
   * Repeated `repo:` qualifiers are OR-ed by GitHub's search, which is what lets
   * one round trip cover every configured project — verified against the real
   * API, not only asserted here.
   */
  it('lists every repository in one expression', () => {
    const { open } = buildPrVariables([
      'repo:a/one',
      'repo:b/two',
      'repo:c/three',
    ]);

    expect(open).toContain('repo:a/one repo:b/two repo:c/three');
  });
});
