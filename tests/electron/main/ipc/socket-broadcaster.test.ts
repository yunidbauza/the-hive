import { describe, expect, it, vi } from 'vitest';

import { CH, EVENT_CHANNELS } from '../../../../electron/shared/ipc-contract';
import { FRAME_KIND } from '../../../../electron/shared/remote-contract';
import {
  createFanOutBroadcaster,
  createSocketBroadcaster,
  type AttachedSocket,
} from '../../../../electron/main/ipc/socket-broadcaster';

const socket = () => ({ send: vi.fn() });

describe('createSocketBroadcaster', () => {
  it('wraps a push as an event frame and sends it to every attached socket', () => {
    const a = socket();
    const b = socket();
    const broadcaster = createSocketBroadcaster(() => [a, b]);

    broadcaster.emit(CH.ledgerChanged, { id: 'e1' });

    const frame = { kind: 'event', channel: CH.ledgerChanged, payload: { id: 'e1' } };
    expect(a.send).toHaveBeenCalledWith(frame);
    expect(b.send).toHaveBeenCalledWith(frame);
  });

  it('resolves the socket set per emit, so a late attach still receives', () => {
    // Typed as `AttachedSocket[]`, not the untyped `ReturnType<typeof vi.fn>`
    // the other tests use inline — `vi.fn()` on its own infers a call
    // signature vitest's mock type can't structurally match against
    // `AttachedSocket['send']` once it escapes an argument position where
    // contextual typing would have pinned it down for us.
    const sockets: AttachedSocket[] = [];
    const broadcaster = createSocketBroadcaster(() => sockets);

    broadcaster.emit(CH.ledgerChanged, null);
    const late = socket();
    sockets.push(late);
    broadcaster.emit(CH.agentsChanged, undefined);

    expect(late.send).toHaveBeenCalledTimes(1);
  });

  it('serialises a payload-less event with no payload key at all', () => {
    const only = socket();
    createSocketBroadcaster(() => [only]).emit(CH.agentsChanged, undefined);

    const [frame] = only.send.mock.calls[0] as [unknown];
    expect(JSON.parse(JSON.stringify(frame))).toEqual({
      kind: 'event',
      channel: CH.agentsChanged,
    });
  });

  it('one dead socket does not cost the others their event', () => {
    const dead = { send: vi.fn(() => { throw new Error('socket closed'); }) };
    const live = socket();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    createSocketBroadcaster(() => [dead, live]).emit(CH.ptyData, { seq: 1 });

    expect(live.send).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('carries every channel the contract grades as an event, not just EVENT_CHANNELS', () => {
    const pushed = Object.entries(FRAME_KIND)
      .filter(([, kind]) => kind === 'event')
      .map(([channel]) => channel);
    const only = socket();
    const broadcaster = createSocketBroadcaster(() => [only]);

    for (const channel of pushed) broadcaster.emit(channel, null);

    // 27 graded `event`, less the one `LOCAL_ONLY_EVENTS` holds back (HIVE-150).
    expect(only.send).toHaveBeenCalledTimes(26);
    // The regression this guards: forwarding EVENT_CHANNELS would be 20, and
    // would silently drop every notification the remote inbox needs.
    expect(pushed.length).toBeGreaterThan(EVENT_CHANNELS.length);
  });

  /**
   * A served machine does not tell its clients about its own attachment
   * (HIVE-150).
   *
   * The sending half of the fence `remote-proxy.ts` also applies on receipt. A
   * mini that serves this fleet and is itself attached to a third Hive raises
   * `remote:link-status` about *its* outward socket; carried, every client
   * would paint its header chip from a link it has no part in, and go amber for
   * a reconnect happening on a machine none of them is looking at.
   */
  it('holds back a push about the sending machine itself', () => {
    const only = socket();
    const broadcaster = createSocketBroadcaster(() => [only]);

    broadcaster.emit(CH.remoteLinkStatus, {
      state: 'reconnecting',
      serverName: 'a-third-hive',
      attempt: 2,
      nextAttemptAt: null,
      reason: null,
      epoch: 0,
    });

    expect(only.send).not.toHaveBeenCalled();
  });
});

describe('createFanOutBroadcaster', () => {
  it('delivers to every target', () => {
    const a = { emit: vi.fn() };
    const b = { emit: vi.fn() };

    createFanOutBroadcaster([a, b]).emit(CH.ledgerChanged, { id: 'e1' });

    expect(a.emit).toHaveBeenCalledWith(CH.ledgerChanged, { id: 'e1' });
    expect(b.emit).toHaveBeenCalledWith(CH.ledgerChanged, { id: 'e1' });
  });

  it('a throwing target does not stop the next one', () => {
    const bad = { emit: vi.fn(() => { throw new Error('boom'); }) };
    const good = { emit: vi.fn() };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    createFanOutBroadcaster([bad, good]).emit(CH.ptyData, null);

    expect(good.emit).toHaveBeenCalled();
    logged.mockRestore();
  });
});
