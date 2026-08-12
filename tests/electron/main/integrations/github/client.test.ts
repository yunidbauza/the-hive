// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createGithubClient } from '../../../../../electron/main/integrations/github/client';
import type { RepoRef } from '../../../../../electron/main/integrations/github/query';
import type { RunAsync } from '../../../../../electron/main/integrations/github/run';

/**
 * The sweep, and how a failure is told apart from an answer.
 *
 * The interesting rule here is that **the payload beats the exit code**: `gh`
 * exits non-zero whenever GraphQL reports any error, including the very common
 * case where it also returns perfectly good data for the repositories that were
 * readable.
 */

const REPOS: RepoRef[] = [{ owner: 'acme', name: 'apfm-web' }];
const NOW = Date.parse('2026-08-09T12:00:00Z');

const prNode = (over: Record<string, unknown> = {}) => ({
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
  repository: { name: 'apfm-web', owner: { login: 'acme' } },
  reviewThreads: { nodes: [{ isResolved: false }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...over,
});

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: {
      viewer: { login: 'octocat' },
      open: { nodes: [prNode()] },
      merged: { nodes: [] },
      ...over,
    },
  });

const answering = (
  result: Partial<{ code: number; stdout: string; stderr: string; timedOut: boolean }>,
): RunAsync =>
  () =>
    Promise.resolve({
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...result,
    });

describe('createGithubClient', () => {
  it('reads the PRs out of a successful sweep', async () => {
    const client = createGithubClient('/usr/bin/gh', answering({ stdout: body() }));

    const result = await client.sweep(REPOS, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({
      number: 482,
      repo: 'apfm-web',
      owner: 'acme',
      findings: 1,
      checks: 'passing',
    });
  });

  it('passes the repositories as variables, never in the query', async () => {
    const run = vi.fn<RunAsync>().mockResolvedValue({
      code: 0,
      stdout: body(),
      stderr: '',
      timedOut: false,
    });

    await createGithubClient('/usr/bin/gh', run).sweep(REPOS, NOW);

    const [file, args] = run.mock.calls[0];
    expect(file).toBe('/usr/bin/gh');
    expect(args.slice(0, 3)).toEqual(['api', 'graphql', '-f']);
    expect(args).toContain(
      'open=is:pr author:@me is:open repo:acme/apfm-web sort:updated-desc',
    );
    expect(args).toContain(
      'merged=is:pr author:@me is:merged repo:acme/apfm-web sort:updated-desc',
    );

    const query = args.find((arg) => arg.startsWith('query='));
    expect(query).toBeDefined();
    expect(query).not.toContain('apfm-web');
  });

  /** Nothing to sweep is a configuration answer, and never a request. */
  it('refuses to call gh with no repositories', async () => {
    const run = vi.fn<RunAsync>();

    const result = await createGithubClient('/usr/bin/gh', run).sweep([], NOW);

    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'no-repos',
        message: 'No configured project is a GitHub repository.',
      },
    });
  });

  /**
   * The dangerous half of the same rule, and the reason the guard counts
   * qualifiers rather than repositories.
   *
   * A repository whose name cannot safely become a `repo:` qualifier is dropped,
   * so a config full of them leaves a non-empty repository list and an *empty
   * scope*. `is:pr author:@me sort:updated-desc` with no `repo:` is not an
   * error — it is a valid search that answers with the user's pull requests from
   * every repository they have ever touched. Sending it would quietly fill the
   * panel with work from projects the user never configured.
   */
  it('refuses to call gh when no repository can be scoped safely', async () => {
    const run = vi.fn<RunAsync>();

    const result = await createGithubClient('/usr/bin/gh', run).sweep(
      [{ owner: 'acme', name: 'web is:public' }],
      NOW,
    );

    expect(run).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-repos');
    // Not "none of your projects is a GitHub repository" — they resolved fine.
    expect(result.error.message).toContain('GitHub search');
  });

  /**
   * The case this shape exists for: one repository of several is inaccessible,
   * so GraphQL answers with an error *and* the data for the rest, and `gh`
   * exits 1. Reading the exit code first would throw the rest away.
   */
  it('keeps partial data when gh exits non-zero', async () => {
    const stdout = JSON.stringify({
      data: JSON.parse(body()).data,
      errors: [{ message: 'Could not resolve to a Repository named other/gone.' }],
    });

    const result = await createGithubClient(
      '/usr/bin/gh',
      answering({ code: 1, stdout }),
    ).sweep(REPOS, NOW);

    expect(result.ok).toBe(true);
  });

  it.each([
    ['timeout', { timedOut: true, code: -1 }, 'timeout'],
    ['a rate limit', { code: 1, stderr: 'API rate limit exceeded' }, 'rate-limited'],
    ['no network', { code: 1, stderr: 'dial tcp: lookup api.github.com' }, 'offline'],
    ['bad credentials', { code: 1, stderr: 'HTTP 401: Bad credentials' }, 'unauthenticated'],
    ['something else', { code: 1, stderr: 'weird' }, 'unknown'],
  ] as const)('classifies %s', async (_label, over, kind) => {
    const result = await createGithubClient(
      '/usr/bin/gh',
      answering(over),
    ).sweep(REPOS, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe(kind);
  });

  /**
   * `viewer` is the sentinel for "this request genuinely succeeded". Both
   * searches answering empty is a legitimate outcome for a user with no open
   * work, and indistinguishable from a failure without it.
   */
  it('fails rather than guessing when the viewer is unreadable', async () => {
    const stdout = JSON.stringify({ data: { open: null, merged: null } });

    const result = await createGithubClient(
      '/usr/bin/gh',
      answering({ stdout }),
    ).sweep(REPOS, NOW);

    expect(result.ok).toBe(false);
  });

  /**
   * The failure `viewer` alone cannot see.
   *
   * `viewer` is a top-level field that resolves independently of the two
   * searches, so a response where both connections failed still carries a good
   * login. Reading that as a successful empty sweep would install a *live, not
   * stale* empty list and put "No open pull requests of yours" on the panel with
   * total confidence — the exact failure this integration was rewritten to stop.
   */
  it('fails when both searches came back null, however good the viewer is', async () => {
    const stdout = JSON.stringify({
      data: { viewer: { login: 'octocat' }, open: null, merged: null },
      errors: [{ message: 'Something went wrong while executing your query.' }],
    });

    const result = await createGithubClient(
      '/usr/bin/gh',
      answering({ code: 1, stdout, stderr: 'timeout' }),
    ).sweep(REPOS, NOW);

    expect(result.ok).toBe(false);
  });

  /** An empty connection is not a missing one — a quiet user is not a failure. */
  it('reads two empty searches as a successful empty sweep', async () => {
    const stdout = JSON.stringify({
      data: {
        viewer: { login: 'octocat' },
        open: { nodes: [] },
        merged: { nodes: [] },
      },
    });

    const result = await createGithubClient(
      '/usr/bin/gh',
      answering({ stdout }),
    ).sweep(REPOS, NOW);

    expect(result).toEqual({ ok: true, value: [] });
  });

  /** One search surviving is the partial-data case, and it is kept. */
  it('keeps the search that answered when the other came back null', async () => {
    const result = await createGithubClient(
      '/usr/bin/gh',
      answering({ code: 1, stdout: body({ merged: null }) }),
    ).sweep(REPOS, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it('reports a gh that could not be executed', async () => {
    const run: RunAsync = () => Promise.reject(new Error('ENOENT'));

    const result = await createGithubClient('/usr/bin/gh', run).sweep(REPOS, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-installed');
  });

  /** No `stdout` or `stderr` ever escapes — a URL there could carry a token. */
  it('never returns raw command output', async () => {
    const result = await createGithubClient(
      '/usr/bin/gh',
      answering({ code: 1, stderr: 'https://x:ghp_secret@api.github.com failed' }),
    ).sweep(REPOS, NOW);

    expect(JSON.stringify(result)).not.toContain('ghp_secret');
  });
});
