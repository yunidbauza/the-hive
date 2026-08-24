import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_JIRA,
  DEFAULT_NOTIFICATIONS,
  type ConfigSnapshot,
  type ProjectStatus,
} from '@shared/config-contract';

import {
  loadProjectConfig,
  projectAccess,
  readAppInfo,
  projectConfigSnapshot,
  reloadProjectConfig,
  renameProjectInConfig,
  reorderProjectsInConfig,
  repointProjectInConfig,
  readNotificationDelivery,
  resetConfigToTemplate,
  resetProjectConfig,
  resolveProjectRef,
  revealConfigFile,
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

/**
 * One declared project. `key` and `name` default off the id, because most
 * assertions here are about paths and access and do not care what a project is
 * called — the resolver's own tests are the ones that set them (HIVE-94).
 */
type Declared = {
  id: string;
  status: ProjectStatus;
  key?: string;
  name?: string;
};

function snapshot(
  projects: Declared[] = [],
  overrides: Partial<ConfigSnapshot> = {},
): ConfigSnapshot {
  return {
    configPath: CONFIG_PATH,
    templateWritten: false,
    shell: '/bin/zsh',
    claudeCommand: 'claude',
    projects: projects.map(({ id, status, key, name }) => ({
      id,
      key: key ?? id.slice(0, 2),
      name: name ?? id,
      path: status === 'ok' ? `/repos/${id}` : null,
      icon: 'ph-folder',
      origin: 'local' as const,
      status,
      isRepo: true,
    })),
    env: {},
    notifications: { ...DEFAULT_NOTIFICATIONS },
    jira: { ...DEFAULT_JIRA },
    subscriptionAuth: true,
  sessionMetrics: true,
  importLoginEnv: true,
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

/**
 * Story 107's three calls.
 *
 * Two of them write nothing and so deliberately do *not* go through `mutate`;
 * the third does, which is what keeps a refused reset from emptying the UI's
 * project list over a write that never happened.
 */
describe('story 107 verbs', () => {
  beforeEach(() => {
    // Both read paths log a failed channel. Silenced so a deliberate rejection
    // does not print a stack into a passing run.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The verb the Notifications pane polls.
   *
   * It exists *because* it is polled: the same two facts are on
   * `integrations.status()`, and that handler executes `gh`. Asking the wrong
   * one on a four-second timer would spawn a subprocess every tick to read a
   * variable — so which channel this reaches is the whole point of the
   * function, and worth an assertion rather than a comment.
   */
  it('readNotificationDelivery asks the cheap channel, not integrations', async () => {
    const delivery = vi
      .fn()
      .mockResolvedValue({ supported: true, refused: 'UNErrorDomain error 1.' });
    const status = vi.fn();
    (window as { hive?: unknown }).hive = {
      notifications: { delivery },
      integrations: { status },
    };

    await expect(readNotificationDelivery()).resolves.toEqual({
      supported: true,
      refused: 'UNErrorDomain error 1.',
    });
    expect(delivery).toHaveBeenCalledWith();
    expect(status).not.toHaveBeenCalled();
  });

  it('readNotificationDelivery answers null with no bridge and on a failed channel', async () => {
    // The browser demo: no bridge, and so no OS to have an opinion.
    await expect(readNotificationDelivery()).resolves.toBeNull();

    (window as { hive?: unknown }).hive = {
      notifications: {
        delivery: vi.fn().mockRejectedValue(new Error('channel gone')),
      },
    };
    await expect(readNotificationDelivery()).resolves.toBeNull();
  });

  it('revealConfigFile calls through, passing nothing', async () => {
    const revealConfig = vi.fn().mockResolvedValue(undefined);
    (window as { hive?: unknown }).hive = { config: { revealConfig } };

    await revealConfigFile();

    expect(revealConfig).toHaveBeenCalledWith();
  });

  it('revealConfigFile swallows a failed channel and a missing bridge alike', async () => {
    await expect(revealConfigFile()).resolves.toBeUndefined();

    (window as { hive?: unknown }).hive = {
      config: { revealConfig: vi.fn().mockRejectedValue(new Error('no window')) },
    };
    await expect(revealConfigFile()).resolves.toBeUndefined();
  });

  it('resetConfigToTemplate installs the snapshot main returns', async () => {
    const next = snapshot();
    (window as { hive?: unknown }).hive = {
      config: { resetConfig: vi.fn().mockResolvedValue(next) },
    };

    await resetConfigToTemplate();

    expect(projectConfigSnapshot()).toBe(next);
  });

  it('resetConfigToTemplate keeps the last good snapshot when refused', async () => {
    const good = snapshot([{ id: 'alpha', status: 'ok' }]);
    setProjectConfigForTest(good);
    (window as { hive?: unknown }).hive = {
      config: { resetConfig: vi.fn().mockRejectedValue(new Error('refused')) },
    };

    await resetConfigToTemplate();

    expect(projectConfigSnapshot()).toBe(good);
  });

  it('resetConfigToTemplate is a no-op with no bridge', async () => {
    await expect(resetConfigToTemplate()).resolves.toBeUndefined();
    expect(projectConfigSnapshot()).toBeNull();
  });

  it('readAppInfo returns what the bridge answers', async () => {
    const info = {
      version: '0.1.0',
      electron: '38.0.0',
      chrome: '140.0.0',
      node: '22.0.0',
      platform: 'darwin',
      logPath: '/Users/dev/Library/Logs/The Hive',
    };
    (window as { hive?: unknown }).hive = {
      appInfo: vi.fn().mockResolvedValue(info),
    };

    await expect(readAppInfo()).resolves.toBe(info);
  });

  it('readAppInfo answers null rather than inventing versions', async () => {
    // No bridge: the browser demo.
    await expect(readAppInfo()).resolves.toBeNull();

    (window as { hive?: unknown }).hive = {
      appInfo: vi.fn().mockRejectedValue(new Error('channel gone')),
    };
    await expect(readAppInfo()).resolves.toBeNull();
  });
});

/**
 * Resolving what a human typed to exactly one project (HIVE-94).
 *
 * The console's `spawn` and the picker's search both come through here, so this
 * is the one place that answers "does this name a project?". The rules it
 * enforces are about *safety* as much as convenience — see the exactness tests.
 */
describe('resolveProjectRef', () => {
  const projects = () =>
    snapshot([
      { id: 'the-hive', status: 'ok', key: 'hive', name: 'The Hive' },
      { id: 'incorpx-server', status: 'ok', key: 'is', name: 'IncorpX Server' },
    ]).projects;

  it('matches a key, an id and a name', () => {
    expect(resolveProjectRef('hive', projects())).toMatchObject({
      kind: 'match',
      matched: 'key',
      project: { id: 'the-hive' },
    });
    expect(resolveProjectRef('the-hive', projects())).toMatchObject({
      kind: 'match',
      matched: 'id',
      project: { id: 'the-hive' },
    });
    expect(resolveProjectRef('The Hive', projects())).toMatchObject({
      kind: 'match',
      matched: 'name',
      project: { id: 'the-hive' },
    });
  });

  it('is case-insensitive, and tolerates surrounding whitespace', () => {
    // Keys and ids are lowercase by construction; a user reading `The Hive` off
    // the Projects pane should not have to reproduce its capitals.
    expect(resolveProjectRef('HIVE', projects())).toMatchObject({
      project: { id: 'the-hive' },
    });
    expect(resolveProjectRef('  the-HIVE  ', projects())).toMatchObject({
      project: { id: 'the-hive' },
    });
  });

  /**
   * Exact, never a prefix — the safety property this function exists for.
   *
   * A spawn lands in a folder and starts an agent in it, so a prefix match
   * turns a typo into work done in the wrong repository, discovered later and
   * by then already done. Refusing costs a retype.
   */
  it.each(['incorp', 'hiv', 'the-hive-2', 'server'])(
    'refuses %s rather than guessing',
    (input) => {
      expect(resolveProjectRef(input, projects()).kind).toBe('none');
    },
  );

  it('reports nothing for empty input and for an empty list', () => {
    expect(resolveProjectRef('', projects()).kind).toBe('none');
    expect(resolveProjectRef('   ', projects()).kind).toBe('none');
    expect(resolveProjectRef('hive', []).kind).toBe('none');
  });

  /**
   * Two projects with the same display name refuse rather than race.
   *
   * Display names are never uniqueness-checked — two folders both called `api`,
   * a monorepo split, a pair of worktrees — so returning the first would start
   * an agent in whichever sat earlier in the file. That is the "wrong
   * repository, discovered later" failure the exactness rule exists to prevent,
   * arriving by a different door.
   */
  it('reports ambiguity instead of picking the first match', () => {
    const twins = snapshot([
      { id: 'client-api', status: 'ok', key: 'ca', name: 'api' },
      { id: 'server-api', status: 'ok', key: 'sa', name: 'api' },
    ]).projects;

    const result = resolveProjectRef('API', twins);

    expect(result.kind).toBe('ambiguous');
    expect(result).toMatchObject({ matched: 'name' });
    expect(
      result.kind === 'ambiguous'
        ? result.projects.map((project) => project.id)
        : [],
    ).toEqual(['client-api', 'server-api']);
  });

  /*
    An unambiguous field still answers even when a later one is ambiguous: the
    key is exactly the way out of the ambiguity above, so it must not be
    poisoned by it.
  */
  it('still resolves a unique key when the names collide', () => {
    const twins = snapshot([
      { id: 'client-api', status: 'ok', key: 'ca', name: 'api' },
      { id: 'server-api', status: 'ok', key: 'sa', name: 'api' },
    ]).projects;

    expect(resolveProjectRef('sa', twins)).toMatchObject({
      kind: 'match',
      project: { id: 'server-api' },
    });
  });

  /*
    Key first, then id, then name. The order matters only when two *different*
    projects answer — a display name equal to another project's id is entirely
    possible — and the older, stable handle wins.
  */
  it('prefers a key over an id, and an id over a name', () => {
    const overlapping = snapshot([
      { id: 'alpha', status: 'ok', key: 'al', name: 'beta' },
      { id: 'beta', status: 'ok', key: 'be', name: 'al' },
    ]).projects;

    expect(resolveProjectRef('al', overlapping)).toMatchObject({
      kind: 'match',
      matched: 'key',
      project: { id: 'alpha' },
    });
    expect(resolveProjectRef('beta', overlapping)).toMatchObject({
      kind: 'match',
      matched: 'id',
      project: { id: 'beta' },
    });
  });

  it('resolves a project whose directory is unusable', () => {
    /*
      Two different questions: "which project is this?" and "can it host a
      PTY?". This answers only the first — `projectAccess` owns the second.
      Conflating them would make an unmapped project unnameable, so the console
      could not even explain why it was refusing.
    */
    const missing = snapshot([
      { id: 'gone', status: 'missing', key: 'go' },
    ]).projects;

    expect(resolveProjectRef('go', missing)).toMatchObject({
      project: { id: 'gone' },
    });
  });
});
