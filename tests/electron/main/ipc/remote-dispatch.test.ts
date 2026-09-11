import { describe, expect, it, vi } from 'vitest';

import { CH } from '../../../../electron/shared/ipc-contract';
import { createIpcRegistry } from '../../../../electron/main/ipc/registry';
import { createRemoteDispatch } from '../../../../electron/main/ipc/remote-dispatch';
import { PROCESS_LOCAL } from '../../../../electron/shared/remote-contract';

const callFrame = (channel: unknown, payload: unknown = null) =>
  ({ kind: 'call', id: 'c1', channel, payload }) as never;

/**
 * The socket a call arrived on (HIVE-145).
 *
 * `dispatch.call` takes one for the reason `dispatch.notify` always has: a
 * handler that keys state by surface — `fs:watch`, `pty:ack`, `ui:foreground` —
 * has to know whose call this is. Duck-typed, so a test needs no socket.
 */
const reporter = { on: () => undefined } as never;

describe('createRemoteDispatch call', () => {
  /**
   * The hole HIVE-145's live suite found (case 25).
   *
   * A remotely dispatched call used to be handed the payload alone, and
   * `ipc/index.ts` gave its handler a synthetic **empty** event. That was safe
   * only while nothing keyed anything by surface. The moment `fs:watch` did, a
   * watch arriving over a socket installed a watcher belonging to a surface
   * that did not exist, and every `fs:changed` it produced was addressed to
   * nobody — a remote explorer that never refreshed, with no error anywhere.
   */
  it('hands the handler the socket the call arrived on', async () => {
    const registry = createIpcRegistry();
    let seen: unknown = null;
    registry.recordCall(CH.fsWatch, (_payload, surface) => {
      seen = surface;
      return null;
    });
    const dispatch = createRemoteDispatch(registry);

    await dispatch.call(callFrame(CH.fsWatch), reporter);

    expect(seen).toBe(reporter);
  });


  it('answers a recorded channel with a result frame carrying the return value', async () => {
    const registry = createIpcRegistry();
    registry.recordCall(CH.configGet, () => ({ projects: [] }));
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.configGet), reporter);

    expect(frame).toEqual({ kind: 'result', id: 'c1', payload: { projects: [] } });
  });

  it('awaits an async handler before answering', async () => {
    const registry = createIpcRegistry();
    registry.recordCall(CH.githubPrs, async () => [{ number: 1 }]);
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.githubPrs), reporter);

    expect(frame).toEqual({ kind: 'result', id: 'c1', payload: [{ number: 1 }] });
  });

  it('refuses a channel that does not exist', async () => {
    const dispatch = createRemoteDispatch(createIpcRegistry());

    const frame = await dispatch.call(callFrame('not:a:channel'), reporter);

    expect(frame).toMatchObject({ kind: 'error', id: 'c1', code: 'unknown-channel' });
  });

  /**
   * HIVE-143 review: `frameKindOf`, `isClientFrameAllowed` and
   * `windowBoundReason` all key a plain object through `Object.hasOwn`, which
   * coerces — so `["pty:spawn"]` used to clear every gate, miss the registry's
   * `Map` (which does not coerce), and come back `not-ready`. That code means
   * "the handlers are not registered yet", a fault on this side, and a client
   * told that about its own malformed frame retries instead of fixing it.
   */
  it('refuses a channel that is not a string, rather than reporting not-ready', async () => {
    const registry = createIpcRegistry();
    registry.recordCall(CH.ptySpawn, vi.fn());
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame([CH.ptySpawn]), reporter);

    expect(frame).toMatchObject({ kind: 'error', id: 'c1', code: 'unknown-channel' });
  });

  it('refuses a client naming a server-to-client event channel', async () => {
    const registry = createIpcRegistry();
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.ptyData), reporter);

    expect(frame).toMatchObject({ kind: 'error', code: 'wrong-frame-kind' });
  });

  it('refuses a window-bound channel, naming what to do instead', async () => {
    const registry = createIpcRegistry();
    registry.recordCall(CH.configChooseDirectory, () => '/never/reached');
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.configChooseDirectory), reporter);

    expect(frame).toMatchObject({ kind: 'error', code: 'window-bound' });
    expect((frame as { message: string }).message).toMatch(
      /config:browse-directory/,
    );
  });

  it('does not invoke the handler behind a window-bound channel', async () => {
    const registry = createIpcRegistry();
    const handler = vi.fn(() => '/never/reached');
    registry.recordCall(CH.skillsFileImport, handler);
    const dispatch = createRemoteDispatch(registry);

    await dispatch.call(callFrame(CH.skillsFileImport), reporter);

    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * `skills:file:drop` is a correctly-directed `call` channel, at the
   * highest grade a device holds — `isClientFrameAllowed` still folds
   * `REMOTE_REFUSED_CHANNELS` into its own answer, so before this fix the
   * refusal fell through to the generic `wrong-frame-kind` branch and
   * claimed "skills:file:drop is not a call channel", which is false
   * (HIVE-148 review). This is the property that regresses if the specific
   * check is ever removed or reordered after the generic one.
   */
  it('refuses a remote-refused channel with its own code, not the generic direction one', async () => {
    const registry = createIpcRegistry();
    registry.recordCall(CH.skillsFileDrop, () => ({
      skills: [],
      invalid: [],
      skillsRoot: '/never/reached',
    }));
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.skillsFileDrop), reporter);

    expect(frame).toMatchObject({ kind: 'error', code: 'remote-refused' });
    const message = (frame as { message: string }).message;
    expect(message).not.toMatch(/is not a call channel/);
    expect(message).toMatch(/preload/i);
  });

  it('does not invoke the handler behind a remote-refused channel', async () => {
    const registry = createIpcRegistry();
    const handler = vi.fn(() => ({ skills: [], invalid: [], skillsRoot: '/x' }));
    registry.recordCall(CH.skillsFileDrop, handler);
    const dispatch = createRemoteDispatch(registry);

    await dispatch.call(callFrame(CH.skillsFileDrop), reporter);

    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * HIVE-155. The proxy answers every `PROCESS_LOCAL` channel on the machine
   * that asked, and that was the only fence: a peer that hand-built a
   * `remote:forget` frame reached this handler and cleared the server's own
   * credential. The proxy guards the sender; this guards the socket.
   */
  it('refuses every PROCESS_LOCAL channel and never runs its handler', async () => {
    for (const channel of PROCESS_LOCAL) {
      const registry = createIpcRegistry();
      const handler = vi.fn(() => null);
      registry.recordCall(channel, handler);
      const dispatch = createRemoteDispatch(registry);

      const frame = await dispatch.call(callFrame(channel), reporter);

      expect(frame, channel).toMatchObject({ kind: 'error', id: 'c1', code: 'remote-refused' });
      expect((frame as { message: string }).message, channel).toContain(channel);
      expect(handler, channel).not.toHaveBeenCalled();
    }
  });

  /*
    All three this-machine actions, not only `url` (HIVE-140 audit): the
    contract test names all three, and this is where the server acts on that
    table. `update.install` is the dangerous one, a peer quitting the server.
  */
  it.each([
    { type: 'url', url: 'https://example.com' },
    { type: 'update.download' },
    { type: 'update.install' },
  ])('refuses a notifications:act that would act on the answering machine: %o', async (action) => {
    const registry = createIpcRegistry();
    const handler = vi.fn(() => null);
    registry.recordCall(CH.notificationsAct, handler);
    const dispatch = createRemoteDispatch(registry);

    const frame = await dispatch.call(callFrame(CH.notificationsAct, action), reporter);

    expect(frame).toMatchObject({ kind: 'error', code: 'remote-refused' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('still answers a notifications:act that resolves against fleet state', async () => {
    const registry = createIpcRegistry();
    const handler = vi.fn(() => null);
    registry.recordCall(CH.notificationsAct, handler);
    const dispatch = createRemoteDispatch(registry);
    const payload = { type: 'session', entityId: 's1' };

    const frame = await dispatch.call(callFrame(CH.notificationsAct, payload), reporter);

    expect(frame).toEqual({ kind: 'result', id: 'c1', payload: null });
    expect(handler).toHaveBeenCalledWith(payload, reporter);
  });

  it('reports not-ready for a real channel with no handler recorded yet', async () => {
    const dispatch = createRemoteDispatch(createIpcRegistry());

    const frame = await dispatch.call(callFrame(CH.configGet), reporter);

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

    const frame = await dispatch.call(callFrame(CH.configGet), reporter);

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

    const frame = await dispatch.call(callFrame(CH.fsReadFile), reporter);

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

  /**
   * The `notify` half of the coercion hole above (HIVE-143 review). One guard
   * covers both because both refuse through the same `refuse` helper — this is
   * the case that would catch a future fix applied to only one of them.
   */
  it('drops a notify whose channel is not a string', () => {
    const registry = createIpcRegistry();
    const handler = vi.fn();
    registry.recordNotify(CH.ptyWrite, handler);
    const dispatch = createRemoteDispatch(registry);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    dispatch.notify({ kind: 'notify', channel: [CH.ptyWrite], payload: null } as never, reporter);

    expect(handler).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('unknown-channel'));

    logged.mockRestore();
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
