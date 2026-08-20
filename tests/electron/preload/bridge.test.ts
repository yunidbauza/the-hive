// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_CONFIG_KEYS,
  BRIDGE_INTEGRATIONS_KEYS,
  BRIDGE_JIRA_KEYS,
  BRIDGE_UPDATES_KEYS,
  BRIDGE_FS_KEYS,
  BRIDGE_GITHUB_KEYS,
  BRIDGE_KEYS,
  BRIDGE_NOTIFICATIONS_KEYS,
  BRIDGE_PTY_KEYS,
  BRIDGE_THEME_KEYS,
  BRIDGE_UI_KEYS,
  CH,
} from '../../../electron/shared/ipc-contract';

/**
 * The bridge's *surface* (story 082).
 *
 * The single most valuable assertion here is the key-set test: its failure
 * means someone widened what a web page can do to this machine, and that is
 * exactly the change that should never happen by accident.
 */

type Listener = (event: unknown, payload: unknown) => void;

const listeners = new Map<string, Listener[]>();
let exposed: Record<string, unknown> = {};

const ipcRendererMock = {
  invoke: vi.fn(() => Promise.resolve('invoked')),
  send: vi.fn(),
  on: vi.fn((channel: string, listener: Listener) => {
    listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
  }),
  removeListener: vi.fn((channel: string, listener: Listener) => {
    const current = listeners.get(channel) ?? [];
    const at = current.indexOf(listener);
    if (at !== -1) current.splice(at, 1);
  }),
  setMaxListeners: vi.fn(),
};

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_key: string, value: Record<string, unknown>) => {
      exposed = value;
    }),
  },
  ipcRenderer: ipcRendererMock,
}));

beforeEach(async () => {
  listeners.clear();
  exposed = {};
  vi.clearAllMocks();
  vi.resetModules();
  await import('../../../electron/preload/index');
});

const pty = () => exposed.pty as Record<string, (...args: unknown[]) => unknown>;
const config = () =>
  exposed.config as Record<string, (...args: unknown[]) => unknown>;
const integrations = () =>
  exposed.integrations as Record<string, (...args: unknown[]) => unknown>;
const notifications = () =>
  exposed.notifications as Record<string, (...args: unknown[]) => unknown>;
const jira = () =>
  exposed.jira as Record<string, (...args: unknown[]) => unknown>;
const github = () =>
  exposed.github as Record<string, (...args: unknown[]) => unknown>;
const fs = () =>
  exposed.fs as Record<string, (...args: unknown[]) => unknown>;
const updates = () =>
  exposed.updates as Record<string, (...args: unknown[]) => unknown>;
const theme = () =>
  exposed.theme as Record<string, (...args: unknown[]) => unknown>;
const ui = () =>
  exposed.ui as Record<string, (...args: unknown[]) => unknown>;

describe('exposed surface', () => {
  it('exposes exactly the documented verbs — widening this is the alarm', () => {
    expect(Object.keys(exposed).sort()).toEqual([...BRIDGE_KEYS].sort());
    expect(Object.keys(pty()).sort()).toEqual([...BRIDGE_PTY_KEYS].sort());
    expect(Object.keys(config()).sort()).toEqual([...BRIDGE_CONFIG_KEYS].sort());
    expect(Object.keys(integrations()).sort()).toEqual([
      ...BRIDGE_INTEGRATIONS_KEYS,
    ].sort());
    expect(Object.keys(fs()).sort()).toEqual([...BRIDGE_FS_KEYS].sort());
    /**
     * `github` shipped without this assertion, and `BRIDGE_GITHUB_KEYS` sat
     * unimported — a constant whose docblock claims it makes a second verb
     * "impossible to add quietly" while nothing checked it. That is the third
     * time in this file's history that a new namespace arrived without its
     * key-set test; the list is only an alarm if something reads it.
     */
    expect(Object.keys(github()).sort()).toEqual([...BRIDGE_GITHUB_KEYS].sort());
    expect(Object.keys(notifications()).sort()).toEqual([
      ...BRIDGE_NOTIFICATIONS_KEYS,
    ].sort());
    expect(Object.keys(jira()).sort()).toEqual([...BRIDGE_JIRA_KEYS].sort());
    /**
     * The fourth time, avoided. `BRIDGE_UPDATES_KEYS` shipped exported and
     * unimported — exactly the shape the note above describes — and was caught
     * in review before it could become another list nothing reads.
     */
    expect(Object.keys(updates()).sort()).toEqual([
      ...BRIDGE_UPDATES_KEYS,
    ].sort());
  });

  /** HIVE-80. Two verbs, neither taking a destination path from the renderer. */
  it('exposes exactly the theme verbs', () => {
    expect(Object.keys(theme()).sort()).toEqual([...BRIDGE_THEME_KEYS].sort());
  });

  /**
   * HIVE-81. One verb, and it is the first in this bridge that travels out of
   * the renderer with nothing coming back: the page can report which of its
   * own tabs is on the centre stage, and nothing else.
   */
  it('exposes exactly the ui verbs', () => {
    expect(Object.keys(ui()).sort()).toEqual([...BRIDGE_UI_KEYS].sort());
  });

  /**
   * HIVE-67's namespace, asserted for what it cannot do.
   *
   * The renderer can write a token and clear one. There is **no verb that
   * returns one**, and this is where a future addition would have to announce
   * itself: a fifth key fails the surface assertion above, and a `getToken`
   * would have to be added to `BRIDGE_JIRA_KEYS` by hand to get past it.
   *
   * `test` takes no argument either. That stops a *call* from carrying a host,
   * not the renderer from having one — `config.setJira` writes the site, which
   * is what the settings pane is for. The property being pinned here is the
   * shape of the namespace, not an authority boundary the bridge does not
   * claim.
   */
  it('exposes no verb that reads a token back (HIVE-67)', async () => {
    const { ipcRenderer } = await import('electron');

    expect(Object.keys(jira())).not.toContain('token');
    expect(Object.keys(jira())).not.toContain('getToken');
    expect(Object.keys(jira())).not.toContain('readToken');

    await jira().status();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.jiraStatus);

    await jira().clearToken();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.jiraClearToken);

    await jira().test();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.jiraTest);

    await jira().setToken({ token: 'ATATT-x' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.jiraSetToken, {
      token: 'ATATT-x',
    });
  });

  /**
   * HIVE-68's two reads.
   *
   * They widen the surface to six, and the widening is a *read* one: both
   * return mapped fields, neither can name a host, and neither returns a token.
   */
  it('routes the two read verbs, passing their payloads (HIVE-68)', async () => {
    const { ipcRenderer } = await import('electron');

    await jira().search({ jql: 'project = HIVE' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.jiraSearch, {
      jql: 'project = HIVE',
    });

    await jira().issue({ key: 'HIVE-68' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.jiraIssue, {
      key: 'HIVE-68',
    });
  });

  /**
   * HIVE-70 adds the first verb in this whole bridge that **writes to something
   * outside this machine**, so it is worth naming what still bounds it: the key
   * and the id are pattern-matched in main, the endpoint is composed there, and
   * the request is attempted exactly once.
   */
  it('routes the transition read and the one write (HIVE-70)', async () => {
    const { ipcRenderer } = await import('electron');

    await jira().transitions({ key: 'HIVE-70' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.jiraTransitions, {
      key: 'HIVE-70',
    });

    await jira().applyTransition({ key: 'HIVE-70', transitionId: '31' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.jiraApplyTransition, {
      key: 'HIVE-70',
      transitionId: '31',
    });
  });

  /**
   * HIVE-71. Two reads and the one verb that carries free text — bounded and
   * control-character-free at the guard, converted to ADF in main, and
   * validated there before a request is made.
   */
  it('routes the conversation verbs (HIVE-71)', async () => {
    const { ipcRenderer } = await import('electron');

    await jira().comments({ key: 'HIVE-71' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.jiraComments, {
      key: 'HIVE-71',
    });

    await jira().links({ key: 'HIVE-71' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.jiraLinks, {
      key: 'HIVE-71',
    });

    await jira().addComment({ key: 'HIVE-71', markdown: 'hi' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.jiraAddComment, {
      key: 'HIVE-71',
      markdown: 'hi',
    });
  });

  /**
   * Story 106's two additions, asserted for what they can and cannot do.
   *
   * `integrations.status` is the first verb behind which main executes another
   * program, so the property worth pinning is that the renderer contributes
   * *nothing* to that execution: the call takes no argument, and none reaches
   * the channel.
   */
  it('routes the integrations and notification verbs (story 106)', async () => {
    const { ipcRenderer } = await import('electron');

    await integrations().status();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.integrationsStatus);

    await config().setNotifications({ sessionDone: false });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.configSetNotifications, {
      sessionDone: false,
    });
  });

  it('passes no payload to integrations:status, whatever the caller does', async () => {
    const { ipcRenderer } = await import('electron');

    // A caller that tried to smuggle an argument gets it dropped: the bridge
    // function ignores its parameters, so nothing from the renderer can reach
    // the argv main builds.
    await (integrations().status as (...args: unknown[]) => unknown)({
      command: '/bin/sh',
    });

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.integrationsStatus);
  });

  it('routes the config verbs to their channels (stories 090, 101)', async () => {
    const { ipcRenderer } = await import('electron');

    await config().get();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.configGet);

    await config().reload();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.configReload);

    await config().chooseDirectory();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.configChooseDirectory);

    await config().addProject({ path: '/tmp/x' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.configAddProject, {
      path: '/tmp/x',
    });

    await config().removeProject({ id: 'x' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.configRemoveProject, {
      id: 'x',
    });
  });

  it('routes the manage-projects verbs to their channels (story 103)', async () => {
    const { ipcRenderer } = await import('electron');

    await config().renameProject({ id: 'x', name: 'X' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.configRenameProject, {
      id: 'x',
      name: 'X',
    });

    await config().repointProject({ id: 'x', path: '~/moved' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.configRepointProject, {
      id: 'x',
      path: '~/moved',
    });

    await config().reorderProjects({ ids: ['x', 'y'] });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.configReorderProjects, {
      ids: ['x', 'y'],
    });
  });

  /**
   * Story 107's two verbs, and the assertion that matters about them.
   *
   * Both take **no payload at all**, which is their whole security design
   * rather than an omission — the same one `integrations:status` uses. So the
   * test is not just that they reach their channels, but that a caller who
   * tried to smuggle an argument gets it dropped: main reveals and rewrites the
   * file *it* resolved from `configPath()`, and nothing from the renderer can
   * redirect either.
   */
  it('routes the advanced verbs, passing no payload (story 107)', async () => {
    const { ipcRenderer } = await import('electron');

    await (config().revealConfig as (...args: unknown[]) => unknown)({
      path: '/etc/passwd',
    });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.configReveal);

    await (config().resetConfig as (...args: unknown[]) => unknown)({
      path: '/etc/passwd',
    });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(CH.configReset);
  });

  /**
   * Story 101 makes the config writable, and this is what bounds the widening.
   *
   * Story 090's comment here said the config was read-only "because a settings
   * UI that writes this file is out of scope". Story 101 is that settings UI,
   * so the reasoning stood and the condition changed. What did not change: the
   * bridge can write to exactly one file, and no verb names a destination.
   */
  it('exposes no verb that takes a destination path', () => {
    expect(Object.keys(config())).not.toContain('set');
    expect(Object.keys(config())).not.toContain('writeTo');
    expect(Object.keys(config())).not.toContain('setPath');
  });

  it('exposes it as `hive`', async () => {
    const { contextBridge } = await import('electron');
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      'hive',
      expect.any(Object),
    );
  });

  it('does not reach ipcRenderer at any depth', () => {
    // Walk the whole exposed object graph looking for anything that IS the
    // ipcRenderer, or that carries its methods.
    const seen = new Set<unknown>();
    const walk = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object') return false;
      if (seen.has(value)) return false;
      seen.add(value);
      if (value === ipcRendererMock) return true;
      const record = value as Record<string, unknown>;
      if (typeof record.invoke === 'function' && typeof record.on === 'function') {
        return true;
      }
      return Object.values(record).some(walk);
    };

    expect(walk(exposed)).toBe(false);
  });

  it('exposes only functions — no raw objects to reach through', () => {
    expect(typeof exposed.appInfo).toBe('function');
    for (const value of Object.values(pty())) {
      expect(typeof value).toBe('function');
    }
  });

  it('raises the listener cap explicitly, so a real leak stays visible', () => {
    // Thirteen terminals mean thirteen pty:data subscriptions on one channel.
    expect(ipcRendererMock.setMaxListeners).toHaveBeenCalled();
  });
});

describe('verbs route to the contract channels', () => {
  it('appInfo invokes app:info', async () => {
    await (exposed.appInfo as () => Promise<unknown>)();
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith(CH.appInfo);
  });

  it('spawn and kill invoke; write and resize send', () => {
    const request = { sessionId: 's1', projectId: 'p1', cols: 80, rows: 24 };
    pty().spawn(request);
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith(CH.ptySpawn, request);

    pty().kill('s1');
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith(CH.ptyKill, 's1');

    // send, not invoke: awaiting a round-trip per keypress would put the main
    // process in the typing latency path.
    pty().write({ sessionId: 's1', data: 'x' });
    expect(ipcRendererMock.send).toHaveBeenCalledWith(CH.ptyWrite, {
      sessionId: 's1',
      data: 'x',
    });

    pty().resize({ sessionId: 's1', cols: 100, rows: 30 });
    expect(ipcRendererMock.send).toHaveBeenCalledWith(CH.ptyResize, {
      sessionId: 's1',
      cols: 100,
      rows: 30,
    });
  });
});

describe('theme verbs route to their channels (HIVE-80)', () => {
  it('pick invokes theme:pick with no payload', async () => {
    await theme().pick();
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith(CH.themePick);
  });

  it('save invokes theme:save with the request', async () => {
    await theme().save({ suggestedName: 'x.json', contents: '{}' });
    expect(ipcRendererMock.invoke).toHaveBeenCalledWith(CH.themeSave, {
      suggestedName: 'x.json',
      contents: '{}',
    });
  });
});

describe('ui verb routes to its channel (HIVE-81)', () => {
  it('reportForeground sends ui:foreground with the terminal id', () => {
    ui().reportForeground('term-1');
    expect(ipcRendererMock.send).toHaveBeenCalledWith(CH.uiForeground, {
      terminalId: 'term-1',
    });

    // `null` means nothing is on stage, and it is a legal report, not an
    // absence to be dropped.
    ui().reportForeground(null);
    expect(ipcRendererMock.send).toHaveBeenCalledWith(CH.uiForeground, {
      terminalId: null,
    });
  });
});

describe('subscriptions', () => {
  it('returns a disposer that removes exactly one listener', () => {
    const disposeA = pty().onData(vi.fn()) as () => void;
    pty().onData(vi.fn());
    expect(listeners.get(CH.ptyData)).toHaveLength(2);

    disposeA();

    expect(listeners.get(CH.ptyData)).toHaveLength(1);
    expect(ipcRendererMock.removeListener).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a double dispose does not remove someone else', () => {
    const dispose = pty().onData(vi.fn()) as () => void;
    pty().onData(vi.fn());

    dispose();
    dispose();

    expect(listeners.get(CH.ptyData)).toHaveLength(1);
  });

  it('delivers the payload, never the IpcRendererEvent', () => {
    // Passing the event hands the renderer a `sender` handle and defeats the
    // isolation entirely.
    const callback = vi.fn();
    pty().onData(callback);

    const event = { sender: 'THE SENDER HANDLE', senderFrame: {} };
    const payload = { sessionId: 's1', chunk: 'hello' };
    listeners.get(CH.ptyData)?.[0]?.(event, payload);

    expect(callback).toHaveBeenCalledWith(payload);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]).toHaveLength(1);
    expect(callback.mock.calls[0][0]).not.toBe(event);
  });

  it('onExit behaves the same way', () => {
    const callback = vi.fn();
    const dispose = pty().onExit(callback) as () => void;

    const payload = { sessionId: 's1', exitCode: 0 };
    listeners.get(CH.ptyExit)?.[0]?.({ sender: 'x' }, payload);
    expect(callback).toHaveBeenCalledWith(payload);

    dispose();
    expect(listeners.get(CH.ptyExit)).toHaveLength(0);
  });

  it('keeps onData and onExit on separate channels', () => {
    pty().onData(vi.fn());
    expect(listeners.get(CH.ptyExit) ?? []).toHaveLength(0);
  });
});
