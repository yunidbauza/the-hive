// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_CONFIG_KEYS,
  BRIDGE_INTEGRATIONS_KEYS,
  BRIDGE_KEYS,
  BRIDGE_NOTIFICATIONS_KEYS,
  BRIDGE_PTY_KEYS,
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

describe('exposed surface', () => {
  it('exposes exactly the documented verbs — widening this is the alarm', () => {
    expect(Object.keys(exposed).sort()).toEqual([...BRIDGE_KEYS].sort());
    expect(Object.keys(pty()).sort()).toEqual([...BRIDGE_PTY_KEYS].sort());
    expect(Object.keys(config()).sort()).toEqual([...BRIDGE_CONFIG_KEYS].sort());
    expect(Object.keys(integrations()).sort()).toEqual([
      ...BRIDGE_INTEGRATIONS_KEYS,
    ].sort());
    expect(Object.keys(notifications()).sort()).toEqual([
      ...BRIDGE_NOTIFICATIONS_KEYS,
    ].sort());
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
