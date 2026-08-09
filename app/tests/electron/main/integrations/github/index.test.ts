// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGithub } from '../../../../../electron/main/integrations/github';
import type { RunAsync } from '../../../../../electron/main/integrations/github/run';
import {
  emptySnapshot,
  type ConfigSnapshot,
  type ProjectConfig,
} from '../../../../../electron/shared/config-contract';

/**
 * Composition: find `gh`, name the repositories, sweep, answer.
 *
 * The runner is injected, so no `gh` is executed. The **search** is real,
 * because "found" has to mean an executable file that is actually there — the
 * same thing `gh.test.ts` proves for the status verb.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-github-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Put a real, executable `gh` on a real directory and return that directory. */
function withGh(): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'gh');
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return dir;
}

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

const config = (projects: ProjectConfig[]): ConfigSnapshot => ({
  ...emptySnapshot('/tmp/hive/config.json'),
  projects,
});

const SWEEP = JSON.stringify({
  data: {
    viewer: { login: 'octocat' },
    r0: {
      name: 'apfm-web',
      owner: { login: 'acme' },
      open: {
        nodes: [
          {
            number: 482,
            title: 'Hero: semantic token refactor',
            url: 'https://github.com/acme/apfm-web/pull/482',
            isDraft: false,
            state: 'OPEN',
            reviewDecision: 'APPROVED',
            headRefName: 'feat/hero-refresh',
            updatedAt: '2026-08-09T11:00:00Z',
            mergedAt: null,
            author: { login: 'octocat' },
            reviewThreads: { nodes: [{ isResolved: false }] },
            commits: {
              nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }],
            },
          },
        ],
      },
      merged: { nodes: [] },
    },
  },
});

/** Answers `repo view` with a name and `api graphql` with a sweep. */
const runner = (): RunAsync => (_file, args) => {
  if (args[0] === 'repo') {
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ nameWithOwner: 'acme/apfm-web' }),
      stderr: '',
      timedOut: false,
    });
  }

  return Promise.resolve({ code: 0, stdout: SWEEP, stderr: '', timedOut: false });
};

describe('createGithub', () => {
  it('answers with the PRs and how many repositories were swept', async () => {
    const github = createGithub({
      config: () => config([project()]),
      env: () => ({ PATH: withGh() }),
      run: runner(),
      now: () => Date.parse('2026-08-09T12:00:00Z'),
    });

    const result = await github.prs();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repos).toBe(1);
    expect(result.value.prs).toHaveLength(1);
    // The three badge inputs, end to end: approved, one finding, CI running.
    expect(result.value.prs[0]).toMatchObject({
      state: 'approved',
      findings: 1,
      checks: 'running',
    });
  });

  /**
   * Configuration, not failure. The panel explains this rather than apologising
   * for it — see `PrSource` for which kinds land on which side.
   */
  it('reports a machine with no gh as not-installed', async () => {
    const github = createGithub({
      config: () => config([project()]),
      env: () => ({ PATH: dir }),
      run: runner(),
      now: () => Date.now(),
    });

    const result = await github.prs();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not-installed');
  });

  it('reports no-repos when nothing configured is a GitHub repository', async () => {
    const github = createGithub({
      config: () => config([project({ isRepo: false })]),
      env: () => ({ PATH: withGh() }),
      run: runner(),
      now: () => Date.now(),
    });

    const result = await github.prs();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no-repos');
  });

  /**
   * The config is read per call, not captured. Projects are added and removed
   * while the app runs, and a poller holding a snapshot from launch would keep
   * sweeping a repository the user had removed.
   */
  it('picks up a project added after the first sweep', async () => {
    let projects: ProjectConfig[] = [];
    const github = createGithub({
      config: () => config(projects),
      env: () => ({ PATH: withGh() }),
      run: runner(),
      now: () => Date.parse('2026-08-09T12:00:00Z'),
    });

    await expect(github.prs()).resolves.toMatchObject({ ok: false });

    projects = [project()];

    const result = await github.prs();
    expect(result.ok).toBe(true);
  });

  /**
   * `gh` is re-resolved every read against the `PATH` a session would use,
   * which the settings pane can change while the app is running. Resolving once
   * at startup would keep reporting "not installed" after the user fixed
   * exactly the thing the message told them to fix.
   */
  it('finds a gh that appeared after a failed read', async () => {
    let path = '/nowhere';
    const github = createGithub({
      config: () => config([project()]),
      env: () => ({ PATH: path }),
      run: runner(),
      now: () => Date.parse('2026-08-09T12:00:00Z'),
    });

    await expect(github.prs()).resolves.toMatchObject({ ok: false });

    path = withGh();

    await expect(github.prs()).resolves.toMatchObject({ ok: true });
  });

  /** The directory→repository memo survives between sweeps. */
  it('does not re-ask which repository a project is on every sweep', async () => {
    const run = vi.fn<RunAsync>(runner());
    const github = createGithub({
      config: () => config([project()]),
      env: () => ({ PATH: withGh() }),
      run,
      now: () => Date.parse('2026-08-09T12:00:00Z'),
    });

    await github.prs();
    await github.prs();

    const repoViews = run.mock.calls.filter(([, args]) => args[0] === 'repo');
    expect(repoViews).toHaveLength(1);
  });
});
