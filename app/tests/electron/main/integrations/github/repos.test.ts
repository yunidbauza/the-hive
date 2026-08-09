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

    await expect(resolver.resolve([project()])).resolves.toEqual([
      { owner: 'acme', name: 'apfm-web' },
    ]);
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

  /** The negative answer is cached too — a scratch folder stays a scratch folder. */
  it('does not re-ask a directory that is not a GitHub repository', async () => {
    const { run, calls } = answering({});
    const resolver = createRepoResolver('/usr/bin/gh', run);

    await expect(resolver.resolve([project()])).resolves.toEqual([]);
    await resolver.resolve([project()]);

    expect(calls).toEqual(['/repos/apfm-web']);
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

    expect(repos).toEqual([{ owner: 'acme', name: 'apfm-web' }]);
  });

  it.each([
    ['an unresolved path', project({ path: null })],
    ['a directory that is not a git repo', project({ isRepo: false })],
    ['an entry the config marked unusable', project({ status: 'missing' })],
  ])('never asks about %s', async (_label, entry) => {
    const { run, calls } = answering({ '/repos/apfm-web': 'acme/apfm-web' });

    await expect(
      createRepoResolver('/usr/bin/gh', run).resolve([entry]),
    ).resolves.toEqual([]);
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
    ).resolves.toEqual([]);
  });

  /**
   * A `gh` that cannot be executed is cached as "not a repository" rather than
   * retried: re-running a broken binary once a minute is how a poller becomes
   * the problem it was meant to report on.
   */
  it('survives a runner that rejects', async () => {
    const run: RunAsync = () => Promise.reject(new Error('ENOENT'));

    await expect(
      createRepoResolver('/usr/bin/gh', run).resolve([project()]),
    ).resolves.toEqual([]);
  });
});
