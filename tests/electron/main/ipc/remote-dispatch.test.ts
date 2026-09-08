import { describe, expect, it, vi } from 'vitest';

import { CH } from '../../../../electron/shared/ipc-contract';
import { createIpcRegistry } from '../../../../electron/main/ipc/registry';
import { createRemoteDispatch } from '../../../../electron/main/ipc/remote-dispatch';

const callFrame = (channel: string, payload: unknown = null) =>
  ({ kind: 'call', id: 'c1', channel, payload }) as never;

describe('createRemoteDispatch call', () => {
  it('answers a recorded channel with a result frame carrying the return value', async () => {
    const registry = createIpcRegistry();
    registry.recordCall(CH.configGet, () => ({ projects: [] }));
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.configGet));

    expect(frame).toEqual({ kind: 'result', id: 'c1', payload: { projects: [] } });
  });

  it('awaits an async handler before answering', async () => {
    const registry = createIpcRegistry();
    registry.recordCall(CH.githubPrs, async () => [{ number: 1 }]);
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.githubPrs));

    expect(frame).toEqual({ kind: 'result', id: 'c1', payload: [{ number: 1 }] });
  });

  it('refuses a channel that does not exist', async () => {
    const dispatch = createRemoteDispatch(createIpcRegistry());

    const frame = await dispatch.call(callFrame('not:a:channel'));

    expect(frame).toMatchObject({ kind: 'error', id: 'c1', code: 'unknown-channel' });
  });

  it('refuses a client naming a server-to-client event channel', async () => {
    const registry = createIpcRegistry();
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.ptyData));

    expect(frame).toMatchObject({ kind: 'error', code: 'wrong-frame-kind' });
  });

  it('refuses a window-bound channel with the ticket in the message', async () => {
    const registry = createIpcRegistry();
    registry.recordCall(CH.configChooseDirectory, () => '/never/reached');
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.configChooseDirectory));

    expect(frame).toMatchObject({ kind: 'error', code: 'window-bound' });
    expect((frame as { message: string }).message).toMatch(/HIVE-146/);
  });

  it('does not invoke the handler behind a window-bound channel', async () => {
    const registry = createIpcRegistry();
    const handler = vi.fn(() => '/never/reached');
    registry.recordCall(CH.themePick, handler);
    const dispatch = createRemoteDispatch(registry);

    await dispatch.call(callFrame(CH.themePick));

    expect(handler).not.toHaveBeenCalled();
  });

  it('reports not-ready for a real channel with no handler recorded yet', async () => {
    const dispatch = createRemoteDispatch(createIpcRegistry());

    const frame = await dispatch.call(callFrame(CH.configGet));

    expect(frame).toMatchObject({ kind: 'error', code: 'not-ready' });
  });

  it('carries a thrown error name across as the code', async () => {
    const registry = createIpcRegistry();
    registry.recordCall(CH.configGet, () => {
      const error = new Error('config:get: bad shape');
      error.name = 'IpcValidationError';
      throw error;
    });
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.configGet));

    expect(frame).toMatchObject({
      kind: 'error',
      code: 'IpcValidationError',
      message: 'config:get: bad shape',
    });
  });

  it('leaves an FsResult refusal a result frame, because it is a return value', async () => {
    const registry = createIpcRegistry();
    registry.recordCall(CH.fsReadFile, () => ({
      ok: false,
      error: { code: 'EOUTSIDE', message: 'outside the project' },
    }));
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.fsReadFile));

    expect(frame).toMatchObject({
      kind: 'result',
      payload: { ok: false, error: { code: 'EOUTSIDE' } },
    });
  });
});

describe('createRemoteDispatch notify', () => {
  const reporter = { on: vi.fn() };

  it('invokes a recorded notify handler with the payload and the reporter', () => {
    const registry = createIpcRegistry();
    const handler = vi.fn();
    registry.recordNotify(CH.ptyAck, handler);
    const dispatch = createRemoteDispatch(registry);

    dispatch.notify({ kind: 'notify', channel: CH.ptyAck, payload: { seq: 3 } } as never, reporter);

    expect(handler).toHaveBeenCalledWith({ seq: 3 }, reporter);
  });

  it('drops a notify naming a call channel rather than running it', () => {
    const registry = createIpcRegistry();
    const handler = vi.fn();
    registry.recordCall(CH.configGet, handler);
    const dispatch = createRemoteDispatch(registry);

    dispatch.notify({ kind: 'notify', channel: CH.configGet, payload: null } as never, reporter);

    expect(handler).not.toHaveBeenCalled();
  });

  it('swallows a throwing notify handler, because a notify has no reply', () => {
    const registry = createIpcRegistry();
    registry.recordNotify(CH.ptyWrite, () => {
      throw new Error('rejected');
    });
    const dispatch = createRemoteDispatch(registry);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() =>
      dispatch.notify({ kind: 'notify', channel: CH.ptyWrite, payload: null } as never, reporter),
    ).not.toThrow();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });
});
