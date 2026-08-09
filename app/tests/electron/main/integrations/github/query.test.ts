// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildPrQuery,
  buildPrVariables,
  repoAlias,
} from '../../../../../electron/main/integrations/github/query';

/**
 * The document, and the promise that repository names never enter it.
 *
 * That promise is the security-relevant part of this module, so it is asserted
 * directly rather than inferred from the shape of the code: a name that reached
 * the query text would be concatenated input in a place that is supposed to
 * take only bound variables.
 */
describe('buildPrQuery', () => {
  it('declares two bound parameters per repository', () => {
    const query = buildPrQuery(2);

    expect(query).toContain('$owner0: String!, $name0: String!');
    expect(query).toContain('$owner1: String!, $name1: String!');
    expect(query).toContain('r0: repository(owner: $owner0, name: $name0)');
    expect(query).toContain('r1: repository(owner: $owner1, name: $name1)');
  });

  it('asks who the token belongs to in the same round trip', () => {
    expect(buildPrQuery(1)).toContain('viewer { login }');
  });

  it('asks for the fields the badges are made of', () => {
    const query = buildPrQuery(1);

    expect(query).toContain('reviewThreads(first: 100)');
    expect(query).toContain('statusCheckRollup');
    expect(query).toContain('reviewDecision');
    expect(query).toContain('isDraft');
    expect(query).toContain('mergedAt');
  });

  /**
   * Two connections, not `states: [OPEN, MERGED]`. A combined one orders across
   * both states, so a busy repository's merged PRs would push the user's open
   * ones off the first page — and those are the point of the panel.
   */
  it('pages open and merged separately', () => {
    const query = buildPrQuery(1);

    expect(query).toContain('open: pullRequests(states: [OPEN], first: 50');
    expect(query).toContain('merged: pullRequests(states: [MERGED], first: 20');
  });

  /** `query () {` is a syntax error, so zero repositories takes no signature. */
  it('emits no parameter list for zero repositories', () => {
    expect(buildPrQuery(0)).toContain('query {');
    expect(buildPrQuery(0)).not.toContain('$owner0');
  });
});

describe('buildPrVariables', () => {
  it('binds each repository to its numbered parameters', () => {
    const variables = buildPrVariables([
      { owner: 'acme', name: 'apfm-web' },
      { owner: 'other', name: 'referral-api' },
    ]);

    expect(variables).toEqual({
      owner0: 'acme',
      name0: 'apfm-web',
      owner1: 'other',
      name1: 'referral-api',
    });
  });

  /**
   * The guarantee, stated as a test.
   *
   * A repository whose name is full of GraphQL syntax still travels as data:
   * the query text is built from a *count*, so there is nowhere for the name to
   * land except a variable.
   */
  it('keeps a hostile repository name out of the query text', () => {
    const hostile = { owner: 'acme', name: 'x") { id } evil(name: "y' };

    const query = buildPrQuery(1);
    const variables = buildPrVariables([hostile]);

    expect(query).not.toContain('evil');
    expect(variables.name0).toBe(hostile.name);
  });
});

describe('repoAlias', () => {
  it('is derived from the index alone', () => {
    expect(repoAlias(0)).toBe('r0');
    expect(repoAlias(7)).toBe('r7');
  });
});
