import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The mode switch in front of `registerIpcHandlers` (HIVE-141).
 *
 * `registerIpcHandlers` is mocked here rather than run: the eight suites that
 * exercise it for real each build a full main-process fixture, and none of what
 * they set up is what this file is about. What is being tested is one branch —
 * which mode reaches the handlers, which does not, and that the broadcaster is
 * handed through rather than swallowed.
 */

const registerIpcHandlers = vi.fn();

vi.mock('../../../../electron/main/ipc/index', () => ({ registerIpcHandlers }));

const { registerIpc, RemoteModeNotImplementedError } = await import(
  '../../../../electron/main/ipc/router'
);

beforeEach(() => {
  registerIpcHandlers.mockClear();
});

describe('registerIpc', () => {
  it('binds the local handlers in local mode', () => {
    registerIpc('local');

    expect(registerIpcHandlers).toHaveBeenCalledTimes(1);
  });

  it('passes the broadcaster through to the handlers', () => {
    const broadcaster = { emit: vi.fn() };

    registerIpc('local', { broadcaster });

    expect(registerIpcHandlers).toHaveBeenCalledWith(broadcaster);
  });

  /**
   * Undefined rather than a substitute, so `registerIpcHandlers` reaches its own
   * default. A router that manufactured a broadcaster here would be a second
   * place that decides where a push goes, and the first one to drift would win
   * silently.
   */
  it('leaves the default broadcaster to the handlers when none is given', () => {
    registerIpc('local');

    expect(registerIpcHandlers).toHaveBeenCalledWith(undefined);
  });

  it('refuses remote mode by name, and binds nothing', () => {
    expect(() => registerIpc('remote')).toThrow(RemoteModeNotImplementedError);
    expect(registerIpcHandlers).not.toHaveBeenCalled();
  });

  it('names the story that implements remote mode', () => {
    expect(() => registerIpc('remote')).toThrow(/HIVE-144/);
  });
});
