import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_NOTIFICATIONS,
  type ConfigSnapshot,
  type ProjectStatus,
} from '@shared/config-contract';

import {
  loadProjectConfig,
  projectAccess,
  projectConfigSnapshot,
  reloadProjectConfig,
  renameProjectInConfig,
  reorderProjectsInConfig,
  repointProjectInConfig,
  resetProjectConfig,
  setProjectConfigForTest,
  subscribeProjectConfig,
} from '@lib/project-config';

/**
 * The renderer's view of the workspace config (story 090).
 *
 * The single most important assertion in this file is that a *missing*
 * snapshot leaves every project spawnable. That is what keeps the browser demo
 * whole, and it is the deviation from story 090's description that the
 * reconciliation resolved deliberately — see the story's UPDATED SPECS note.
 */

const CONFIG_PATH = '/home/dev/.hive/config.json';

function snapshot(
  projects: { id: string; status: ProjectStatus }[] = [],
  overrides: Partial<ConfigSnapshot> = {},
): ConfigSnapshot {
  return {
    configPath: CONFIG_PATH,
    templateWritten: false,
    shell: '/bin/zsh',
    claudeCommand: 'claude',
    projects: projects.map(({ id, status }) => ({
      id,
      name: id,
      path: status === 'ok' ? `/repos/${id}` : null,
      icon: 'ph-folder',
      origin: 'local' as const,
      status,
      isRepo: true,
    })),
    notifications: { ...DEFAULT_NOTIFICATIONS },
    errors: [],
    ...overrides,
  };
}

function withBridge(
  get: () => Promise<ConfigSnapshot>,
  reload: () => Promise<ConfigSnapshot> = get,
) {
  (window as { hive?: unknown }).hive = { config: { get, reload } };
}

beforeEach(() => {
  resetProjectConfig();
});

afterEach(() => {
  resetProjectConfig();
  delete (window as { hive?: unknown }).hive;
});

describe('projectAccess with no snapshot', () => {
  it('leaves every project spawnable, which is what keeps the browser demo whole', () => {
    expect(projectConfigSnapshot()).toBeNull();

    expect(projectAccess('apfm-web')).toEqual({
      spawnable: true,
      reason: null,
      invalid: false,
    });
    expect(projectAccess('anything-at-all').spawnable).toBe(true);
  });
});

describe('projectAccess with a snapshot', () => {
  it('allows a mapped, resolvable project', () => {
    setProjectConfigForTest(snapshot([{ id: 'apfm-web', status: 'ok' }]));

    expect(projectAccess('apfm-web')).toEqual({
      spawnable: true,
      reason: null,
      invalid: false,
    });
  });

  it('refuses a project the config never mentions, and names the file to edit', () => {
    setProjectConfigForTest(snapshot([{ id: 'apfm-web', status: 'ok' }]));

    const access = projectAccess('referral-api');

    expect(access.spawnable).toBe(false);
    // Muted, not amber: not mapped is a thing the user has not done yet.
    expect(access.invalid).toBe(false);
    expect(access.reason).toContain(CONFIG_PATH);
  });

  it.each([
    ['missing', 'does not exist'],
    ['not-a-directory', 'not a directory'],
    ['not-absolute', 'not absolute'],
    ['duplicate-id', 'already claimed'],
  ] as const)(
    'refuses a %s entry and carries the reason verbatim',
    (status, expected) => {
      setProjectConfigForTest(snapshot([{ id: 'apfm-web', status }]));

      const access = projectAccess('apfm-web');

      expect(access.spawnable).toBe(false);
      // Amber, not muted: the entry exists and is wrong.
      expect(access.invalid).toBe(true);
      expect(access.reason).toContain(expected);
      expect(access.reason).toContain(status);
      expect(access.reason).toContain(CONFIG_PATH);
    },
  );
});

describe('loadProjectConfig', () => {
  it('is a no-op without a bridge — the browser demo has nothing to ask', async () => {
    await loadProjectConfig();

    expect(projectConfigSnapshot()).toBeNull();
  });

  it('stores what the bridge returns and notifies subscribers', async () => {
    const listener = vi.fn();
    subscribeProjectConfig(listener);
    const expected = snapshot([{ id: 'apfm-web', status: 'ok' }]);
    withBridge(() => Promise.resolve(expected));

    await loadProjectConfig();

    expect(projectConfigSnapshot()).toBe(expected);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('re-reads on reload, which is what makes an edit visible without a restart', async () => {
    const first = snapshot([{ id: 'apfm-web', status: 'missing' }]);
    const second = snapshot([{ id: 'apfm-web', status: 'ok' }]);
    withBridge(
      () => Promise.resolve(first),
      () => Promise.resolve(second),
    );

    await loadProjectConfig();
    expect(projectAccess('apfm-web').spawnable).toBe(false);

    await reloadProjectConfig();
    expect(projectAccess('apfm-web').spawnable).toBe(true);
  });

  it('stays permissive when the channel itself fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setProjectConfigForTest(snapshot([{ id: 'apfm-web', status: 'missing' }]));
    withBridge(() => Promise.reject(new Error('channel gone')));

    await reloadProjectConfig();

    // A broken IPC hop is not something the user can fix by editing their
    // config, so it must not lock the app.
    expect(projectConfigSnapshot()).toBeNull();
    expect(projectAccess('apfm-web').spawnable).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it('stops notifying a listener that unsubscribed', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProjectConfig(listener);
    withBridge(() => Promise.resolve(snapshot()));

    unsubscribe();
    await loadProjectConfig();

    expect(listener).not.toHaveBeenCalled();
  });
});

/**
 * Story 103's mutating verbs.
 *
 * The assertion that matters is the same one story 101 established: the verb
 * returns a snapshot and `read` installs it, so the renderer can never render a
 * list the write already invalidated. No reload follows any of them.
 */
describe('managing projects', () => {
  /** A bridge whose three story-103 verbs all answer with `next`. */
  function withManageBridge(next: ConfigSnapshot) {
    const verbs = {
      renameProject: vi.fn().mockResolvedValue(next),
      repointProject: vi.fn().mockResolvedValue(next),
      reorderProjects: vi.fn().mockResolvedValue(next),
    };
    (window as { hive?: unknown }).hive = { config: verbs };
    return verbs;
  }

  it('installs the snapshot a rename returns and notifies subscribers', async () => {
    const next = snapshot([{ id: 'a', status: 'ok' }]);
    const verbs = withManageBridge(next);
    const seen = vi.fn();
    subscribeProjectConfig(seen);

    await renameProjectInConfig({ id: 'a', name: 'A' });

    expect(verbs.renameProject).toHaveBeenCalledWith({ id: 'a', name: 'A' });
    expect(projectConfigSnapshot()).toBe(next);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('installs the snapshot a re-point returns', async () => {
    const next = snapshot([{ id: 'a', status: 'ok' }]);
    const verbs = withManageBridge(next);

    await repointProjectInConfig({ id: 'a', path: '~/moved' });

    expect(verbs.repointProject).toHaveBeenCalledWith({
      id: 'a',
      path: '~/moved',
    });
    expect(projectConfigSnapshot()).toBe(next);
  });

  it('installs the snapshot a reorder returns', async () => {
    const next = snapshot([
      { id: 'b', status: 'ok' },
      { id: 'a', status: 'ok' },
    ]);
    const verbs = withManageBridge(next);

    await reorderProjectsInConfig({ ids: ['b', 'a'] });

    expect(verbs.reorderProjects).toHaveBeenCalledWith({ ids: ['b', 'a'] });
    expect(projectConfigSnapshot()?.projects.map((p) => p.id)).toEqual([
      'b',
      'a',
    ]);
  });

  /**
   * A rejected write must not look like an empty config.
   *
   * Story 103's guards throw, and `handle` does not catch, so a bad payload
   * rejects the invoke — reachable without malice from a config holding two
   * entries with the same id. Clearing the snapshot there emptied the settings
   * list and, worse, reopened `projectAccess` for every project, because a
   * missing snapshot is permissive by design.
   */
  it('keeps the last good snapshot when a mutation is rejected', async () => {
    const good = snapshot([{ id: 'alpha', status: 'ok' }]);
    setProjectConfigForTest(good);
    (window as { hive?: unknown }).hive = {
      config: {
        reorderProjects: vi.fn().mockRejectedValue(new Error('malformed id')),
      },
    };

    await reorderProjectsInConfig({ ids: ['alpha', 'alpha'] });

    expect(projectConfigSnapshot()).toBe(good);
    // The spawn gate stays closed for a project the config never declared.
    expect(projectAccess('ghost-project').spawnable).toBe(false);
  });

  /** The browser demo has no bridge; story 083's rule is to feature-detect it. */
  it('is a no-op with no bridge, like every other verb', async () => {
    await expect(
      reorderProjectsInConfig({ ids: [] }),
    ).resolves.toBeUndefined();
    expect(projectConfigSnapshot()).toBeNull();
  });
});
