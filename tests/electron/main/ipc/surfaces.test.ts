// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  createSurfaceRegistry,
  type SurfaceId,
} from '../../../../electron/main/ipc/surfaces';
import type { ServerFrame } from '../../../../electron/shared/remote-contract';

/**
 * The surface registry (HIVE-145).
 *
 * One identity per live surface — a local window's `webContents`, or an
 * attached socket — so the five pieces of state that used to be written by
 * "the" renderer can be keyed by *which* one wrote them.
 *
 * Everything here is a bare object with an `on`, which is also what the rest
 * of the suite hands `watchReporter` today: the registry duck-types its
 * reporters precisely so a test needs no Electron.
 */

/** A reporter with a fireable lifetime, standing in for `webContents`. */
function fakeReporter(): {
  on(event: string, listener: () => void): unknown;
  fire(event: string): void;
} {
  const listeners = new Map<string, (() => void)[]>();
  return {
    on(event, listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return undefined;
    },
    fire(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

/** A socket: the merged send handle and reporter one object carries (Task 2). */
function fakeSocket(): {
  send(frame: ServerFrame): void;
  on(event: string, listener: () => void): unknown;
  fire(event: string): void;
  frames: ServerFrame[];
} {
  const reporter = fakeReporter();
  const frames: ServerFrame[] = [];
  return {
    send(frame) {
      frames.push(frame);
    },
    on: reporter.on,
    fire: reporter.fire,
    frames,
  };
}

describe('createSurfaceRegistry', () => {
  it('dedupes on object identity, so one surface is tracked once', () => {
    const surfaces = createSurfaceRegistry();
    const reporter = fakeReporter();

    const first = surfaces.trackWindow(reporter, vi.fn());
    const second = surfaces.trackWindow(reporter, vi.fn());

    expect(second).toBe(first);
    expect(surfaces.size()).toBe(1);
  });

  it('gives two distinct reporters two distinct ids', () => {
    const surfaces = createSurfaceRegistry();

    const a = surfaces.trackWindow(fakeReporter(), vi.fn());
    const b = surfaces.trackWindow(fakeReporter(), vi.fn());

    expect(a).not.toBe(b);
    expect(surfaces.size()).toBe(2);
  });

  it('ignores a reporter with no lifetime to watch', () => {
    const surfaces = createSurfaceRegistry();

    surfaces.trackWindow({ notAReporter: true }, vi.fn());
    surfaces.trackWindow(null, vi.fn());

    expect(surfaces.size()).toBe(0);
  });

  it('fires onGone once, with that surface id, when the reporter dies', () => {
    const surfaces = createSurfaceRegistry();
    const gone = vi.fn();
    surfaces.onGone(gone);
    const reporter = fakeReporter();
    const id = surfaces.trackWindow(reporter, vi.fn());

    reporter.fire('destroyed');
    reporter.fire('destroyed');

    expect(gone).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledWith(id);
    expect(surfaces.size()).toBe(0);
  });

  it('treats a renderer reload as the surface going away', () => {
    const surfaces = createSurfaceRegistry();
    const gone = vi.fn();
    surfaces.onGone(gone);
    const reporter = fakeReporter();
    surfaces.trackWindow(reporter, vi.fn());

    reporter.fire('did-start-loading');

    expect(gone).toHaveBeenCalledTimes(1);
    expect(surfaces.size()).toBe(0);
  });

  it('re-tracks a reporter that came back after going away', () => {
    const surfaces = createSurfaceRegistry();
    const reporter = fakeReporter();
    const first = surfaces.trackWindow(reporter, vi.fn());
    reporter.fire('destroyed');

    const second = surfaces.trackWindow(reporter, vi.fn());

    expect(second).not.toBe(first);
    expect(surfaces.size()).toBe(1);
  });

  it('sends to one surface without touching the other', () => {
    const surfaces = createSurfaceRegistry();
    const toA = vi.fn();
    const toB = vi.fn();
    const a = surfaces.trackWindow(fakeReporter(), toA);
    surfaces.trackWindow(fakeReporter(), toB);

    surfaces.get(a)?.send('fs:changed', { projectId: 'p' });

    expect(toA).toHaveBeenCalledWith('fs:changed', { projectId: 'p' });
    expect(toB).not.toHaveBeenCalled();
  });

  it('wraps a socket send in an event frame', () => {
    const surfaces = createSurfaceRegistry();
    const socket = fakeSocket();
    const id = surfaces.trackSocket(socket);

    surfaces.get(id)?.send('notifications:toast', { id: 'n1' });

    expect(socket.frames).toEqual([
      { kind: 'event', channel: 'notifications:toast', payload: { id: 'n1' } },
    ]);
  });

  it('reports a socket surface as a socket, and a window as a window', () => {
    const surfaces = createSurfaceRegistry();
    const socketId = surfaces.trackSocket(fakeSocket());
    const windowId = surfaces.trackWindow(fakeReporter(), vi.fn());

    expect(surfaces.get(socketId)?.kind).toBe('socket');
    expect(surfaces.get(windowId)?.kind).toBe('window');
  });

  it('lists only socket handles for the broadcaster', () => {
    const surfaces = createSurfaceRegistry();
    const socket = fakeSocket();
    surfaces.trackSocket(socket);
    surfaces.trackWindow(fakeReporter(), vi.fn());

    const listed = [...surfaces.sockets()];

    expect(listed).toHaveLength(1);
    listed[0]?.send({
      kind: 'event',
      channel: 'fs:changed',
      payload: 1,
    } as unknown as ServerFrame);
    expect(socket.frames).toHaveLength(1);
  });

  it('drops a socket from the broadcaster list once it closes', () => {
    const surfaces = createSurfaceRegistry();
    const socket = fakeSocket();
    surfaces.trackSocket(socket);

    socket.fire('destroyed');

    expect([...surfaces.sockets()]).toHaveLength(0);
  });

  it('tracks a socket that carries no lifetime, because the fan-out is the point', () => {
    const surfaces = createSurfaceRegistry();
    const frames: ServerFrame[] = [];
    const lifeless = {
      send(frame: ServerFrame) {
        frames.push(frame);
      },
    } as unknown as Parameters<typeof surfaces.trackSocket>[0];

    surfaces.trackSocket(lifeless);

    expect([...surfaces.sockets()]).toHaveLength(1);
  });

  it('untrack removes a socket that had no lifetime of its own', () => {
    const surfaces = createSurfaceRegistry();
    const gone = vi.fn();
    surfaces.onGone(gone);
    const lifeless = {
      send() {},
    } as unknown as Parameters<typeof surfaces.trackSocket>[0];
    const id = surfaces.trackSocket(lifeless);

    surfaces.untrack(lifeless);

    expect(gone).toHaveBeenCalledExactlyOnceWith(id);
    expect([...surfaces.sockets()]).toHaveLength(0);
  });

  it('untrack and a destroyed event together still announce once', () => {
    const surfaces = createSurfaceRegistry();
    const gone = vi.fn();
    surfaces.onGone(gone);
    const socket = fakeSocket();
    surfaces.trackSocket(socket);

    socket.fire('destroyed');
    surfaces.untrack(socket);

    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('untrack ignores something it never tracked', () => {
    const surfaces = createSurfaceRegistry();
    const gone = vi.fn();
    surfaces.onGone(gone);

    expect(() => { surfaces.untrack({}); }).not.toThrow();
    expect(() => { surfaces.untrack(null); }).not.toThrow();
    expect(gone).not.toHaveBeenCalled();
  });

  it('fires onFirst only on the empty to non-empty transition', () => {
    const surfaces = createSurfaceRegistry();
    const first = vi.fn();
    surfaces.onFirst(first);

    surfaces.trackWindow(fakeReporter(), vi.fn());
    surfaces.trackSocket(fakeSocket());

    expect(first).toHaveBeenCalledTimes(1);
  });

  it('fires onFirst again after the registry has emptied', () => {
    const surfaces = createSurfaceRegistry();
    const first = vi.fn();
    surfaces.onFirst(first);
    const reporter = fakeReporter();
    surfaces.trackWindow(reporter, vi.fn());

    reporter.fire('destroyed');
    surfaces.trackWindow(fakeReporter(), vi.fn());

    expect(first).toHaveBeenCalledTimes(2);
  });

  it('clear drops everything without announcing it', () => {
    const surfaces = createSurfaceRegistry();
    const gone = vi.fn();
    surfaces.onGone(gone);
    surfaces.trackWindow(fakeReporter(), vi.fn());
    surfaces.trackSocket(fakeSocket());

    surfaces.clear();

    expect(surfaces.size()).toBe(0);
    expect(gone).not.toHaveBeenCalled();
  });

  it('stops announcing to an unsubscribed listener', () => {
    const surfaces = createSurfaceRegistry();
    const gone = vi.fn();
    const unsubscribe = surfaces.onGone(gone);
    const reporter = fakeReporter();
    surfaces.trackWindow(reporter, vi.fn());

    unsubscribe();
    reporter.fire('destroyed');

    expect(gone).not.toHaveBeenCalled();
  });

  it('lists every live surface, whatever its kind', () => {
    const surfaces = createSurfaceRegistry();
    const a: SurfaceId = surfaces.trackWindow(fakeReporter(), vi.fn());
    const b: SurfaceId = surfaces.trackSocket(fakeSocket());

    expect(surfaces.all().map((surface) => surface.id).sort()).toEqual([a, b].sort());
  });
});
