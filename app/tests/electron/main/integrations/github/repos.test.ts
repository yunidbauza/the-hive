// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '../../../../../electron/shared/config-contract';
import { createRepoResolver } from '../../../../../electron/main/integrations/github/repos';
import type { RunAsync } from '../../../../../electron/main/integrations/github/run';

/**
 * Directories to repository names.
 *
 * The runner is injected, so nothing here executes `gh`. What is under test is
 * how its answer is read, which projects are worth asking about, and — the part
 * that matters most at a poll a minute — that the answer is asked for once.
 */

const project = (over: Partial<ProjectConfig> = {}): ProjectConfig => ({
  id: 'apfm-web',
  name: 'apfm-web',
  path: '/repos/apfm-web',
  icon: 'ph-cube',
  origin: 'local',
  status: 'ok',
  isRepo: true,
  ...over,
});

const answering = (
  byPath: Record<string, string>,
): { run: RunAsync; calls: string[] } => {
  const calls: string[] = [];

  const run: RunAsync = (_file, _args, options) => {
    const cwd = options?.cwd ?? '';
    calls.push(cwd);

    const nameWithOwner = byPath[cwd];
    if (nameWithOwner === undefined) {
      return Promise.resolve({ code: 1, stdout: '', stderr: 'no remote', timedOut: false });
    }

    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ nameWithOwner }),
      stderr: '',
      timedOut: false,
    });
  };

  return { run, calls };
};

describe('createRepoResolver', () => {
  it('asks gh what repository a project directory is', async () => {
    const { run, calls } = answering({ '/repos/apfm-web': 'acme/apfm-web' });
    const resolver = createRepoResolver('/usr/bin/gh', run);

    await expect(resolver.resolve([project()])).resolves.toEqual({
      repos: [{ owner: 'acme', name: 'apfm-web' }],
      failure: null,
    });
    expect(calls).toEqual(['/repos/apfm-web']);
  });

  it('runs it in the project directory, with a constant argv', async () => {
    const run = vi.fn<RunAsync>().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ nameWithOwner: 'acme/apfm-web' }),
      stderr: '',
      timedOut: false,
    });

    await createRepoResolver('/usr/bin/gh', run).resolve([project()]);

    expect(run).toHaveBeenCalledWith(
      '/usr/bin/gh',
      ['repo', 'view', '--json', 'nameWithOwner'],
      { cwd: '/repos/apfm-web' },
    );
  });

  /**
   * The memo is the reason this is a factory and not a function. Without it the
   * poller would spawn a `gh` per project per minute to re-learn a constant.
   */
  it('asks once per directory, however many sweeps', async () => {
    const { run, calls } = answering({ '/repos/apfm-web': 'acme/apfm-web' });
    const resolver = createRepoResolver('/usr/bin/gh', run);

    await resolver.resolve([project()]);
    await resolver.resolve([project()]);
    await resolver.resolve([project()]);

    expect(calls).toEqual(['/repos/apfm-web']);
  });

  /**
   * A *definitive* negative is cached — a scratch folder with no GitHub remote
   * stays one, and re-asking once a minute would be spending a process to
   * re-learn a permanent fact about a directory.
   */
  it('does not re-ask a directory that has no GitHub remote', async () => {
    const calls: string[] = [];
    const run: RunAsync = (_file, _args, options) => {
      calls.push(options?.cwd ?? '');
      return Promise.resolve({
        code: 1,
        stdout: '',
        stderr: 'no git remotes found for current directory',
        timedOut: false,
      });
    };
    const resolver = createRepoResolver('/usr/bin/gh', run);

    await expect(resolver.resolve([project()])).resolves.toEqual({
      repos: [],
      failure: null,
    });
    await resolver.resolve([project()]);

    expect(calls).toEqual(['/repos/apfm-web']);
  });

  /**
   * The bug this guards, and it is the worst one this module could have.
   *
   * `gh repo view` is a network call that needs credentials. An app launched
   * offline, or before `gh auth login`, fails for every project — and caching
   * that would make the panel say "no configured project is a GitHub
   * repository" every minute *forever*, still saying it after the user logs in,
   * with only a restart to clear it. A transient failure is never remembered.
   */
  it('retries after a failure, and picks the repository up once it works', async () => {
    let loggedIn = false;
    const calls: string[] = [];

    const run: RunAsync = (_file, _args, options) => {
      calls.push(options?.cwd ?? '');
      if (!loggedIn) {
        return Promise.resolve({
          code: 1,
          stdout: '',
          stderr: 'To get started with GitHub CLI, please run: gh auth login',
          timedOut: false,
        });
      }
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ nameWithOwner: 'acme/apfm-web' }),
        stderr: '',
        timedOut: false,
      });
    };

    const resolver = createRepoResolver('/usr/bin/gh', run);

    const first = await resolver.resolve([project()]);
    expect(first.repos).toEqual([]);
    expect(first.failure?.kind).toBe('unauthenticated');

    loggedIn = true;

    const second = await resolver.resolve([project()]);
    expect(second.repos).toEqual([{ owner: 'acme', name: 'apfm-web' }]);
    expect(second.failure).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['being offline', 'dial tcp: lookup api.github.com: no such host', 'offline'],
    ['a timeout', '', 'timeout'],
  ] as const)('reports %s rather than caching it', async (_label, stderr, kind) => {
    const run: RunAsync = () =>
      Promise.resolve({
        code: -1,
        stdout: '',
        stderr,
        timedOut: kind === 'timeout',
      });

    const resolver = createRepoResolver('/usr/bin/gh', run);
    const result = await resolver.resolve([project()]);

    expect(result.repos).toEqual([]);
    expect(result.failure?.kind).toBe(kind);
  });

  /** The first reason wins — they are almost always the same reason. */
  it('reports one failure for several unreachable projects', async () => {
    const run: RunAsync = () =>
      Promise.resolve({
        code: 1,
        stdout: '',
        stderr: 'gh auth login',
        timedOut: false,
      });

    const result = await createRepoResolver('/usr/bin/gh', run).resolve([
      project(),
      project({ id: 'other', path: '/repos/other' }),
    ]);

    expect(result.failure?.kind).toBe('unauthenticated');
  });

  /** A repository that resolved is not lost because a later one failed. */
  it('keeps the repositories it did resolve', async () => {
    const run: RunAsync = (_file, _args, options) =>
      options?.cwd === '/repos/apfm-web'
        ? Promise.resolve({
            code: 0,
            stdout: JSON.stringify({ nameWithOwner: 'acme/apfm-web' }),
            stderr: '',
            timedOut: false,
          })
        : Promise.resolve({
            code: 1,
            stdout: '',
            stderr: 'gh auth login',
            timedOut: false,
          });

    const result = await createRepoResolver('/usr/bin/gh', run).resolve([
      project(),
      project({ id: 'other', path: '/repos/other' }),
    ]);

    expect(result.repos).toEqual([{ owner: 'acme', name: 'apfm-web' }]);
    expect(result.failure?.kind).toBe('unauthenticated');
  });

  /**
   * Two projects, one repository — a worktree and its checkout, which is how
   * this app is developed. Asking twice would show every PR twice.
   */
  it('dedupes repositories, case-insensitively', async () => {
    const { run } = answering({
      '/repos/apfm-web': 'acme/apfm-web',
      '/repos/apfm-web-worktree': 'Acme/APFM-Web',
    });

    const repos = await createRepoResolver('/usr/bin/gh', run).resolve([
      project(),
      project({ id: 'wt', path: '/repos/apfm-web-worktree' }),
    ]);

    expect(repos.repos).toEqual([{ owner: 'acme', name: 'apfm-web' }]);
  });

  it.each([
    ['an unresolved path', project({ path: null })],
    ['a directory that is not a git repo', project({ isRepo: false })],
    ['an entry the config marked unusable', project({ status: 'missing' })],
  ])('never asks about %s', async (_label, entry) => {
    const { run, calls } = answering({ '/repos/apfm-web': 'acme/apfm-web' });

    await expect(
      createRepoResolver('/usr/bin/gh', run).resolve([entry]),
    ).resolves.toEqual({ repos: [], failure: null });
    expect(calls).toEqual([]);
  });

  it.each([
    ['output that is not JSON', 'not json at all'],
    ['JSON without the field', '{"other":"value"}'],
    ['a name in the wrong shape', '{"nameWithOwner":"acme/one/two"}'],
    ['an empty name', '{"nameWithOwner":"   "}'],
  ])('answers nothing for %s', async (_label, stdout) => {
    const run: RunAsync = () =>
      Promise.resolve({ code: 0, stdout, stderr: '', timedOut: false });

    await expect(
      createRepoResolver('/usr/bin/gh', run).resolve([project()]),
    ).resolves.toEqual({ repos: [], failure: null });
  });

  /**
   * A `gh` that cannot be executed is cached as "not a repository" rather than
   * retried: re-running a broken binary once a minute is how a poller becomes
   * the problem it was meant to report on.
   */
  it('survives a runner that rejects', async () => {
    const run: RunAsync = () => Promise.reject(new Error('ENOENT'));

    const result = await createRepoResolver('/usr/bin/gh', run).resolve([
      project(),
    ]);

    expect(result.repos).toEqual([]);
    expect(result.failure?.kind).toBe('not-installed');
  });
});
