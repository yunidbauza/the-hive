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
  reviewThreads: { nodes: [{ isResolved: false }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...over,
});

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: {
      viewer: { login: 'octocat' },
      r0: {
        name: 'apfm-web',
        owner: { login: 'acme' },
        open: { nodes: [prNode()] },
        merged: { nodes: [] },
      },
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
    expect(args).toContain('owner0=acme');
    expect(args).toContain('name0=apfm-web');

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
   * `viewer` is what "mine" means. Without it the sweep cannot filter by
   * author, and showing everybody's PRs would be the wrong way to fail.
   */
  it('fails rather than guessing when the viewer is unreadable', async () => {
    const stdout = JSON.stringify({ data: { r0: null } });

    const result = await createGithubClient(
      '/usr/bin/gh',
      answering({ stdout }),
    ).sweep(REPOS, NOW);

    expect(result.ok).toBe(false);
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
