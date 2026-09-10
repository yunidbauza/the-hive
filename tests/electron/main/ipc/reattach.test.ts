// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteLinkStatus } from '../../../../electron/shared/ipc-contract';
import type { CloseCause, RemoteClient } from '../../../../electron/remote-client/socket';
import { BACKOFF_MS, createReattachLoop } from '../../../../electron/main/ipc/reattach';

/**
 * The reconnect loop (HIVE-150).
 *
 * HIVE-144's own delivery notes list "nothing re-attaches after a socket drops"
 * as a deliberately deferred gap. This closes it: a socket that dies for a
 * reason another dial could fix is dialled again on a backoff, and one that
 * dies for a reason another dial would reproduce is not.
 *
 * Everything here runs on fake timers. The schedule is the subject, and a test
 * that waited out thirty real seconds to prove a thirty-second step would be
 * the slowest test in the repo for the least information.
 */

const TRANSPORT: CloseCause = {
  kind: 'transport',
  code: 'transport',
  message: 'The connection to mini:7433 closed.',
};

const TERMINAL: CloseCause = {
  kind: 'terminal',
  code: 'revoked',
  message: 'That device was revoked.',
};

/**
 * A `RemoteClient` stand-in.
 *
 * `close` is real rather than omitted: the loop closes a socket that lands
 * after it was cancelled, and a fake without it turned that path into an
 * unhandled rejection the assertions could not see.
 */
const fakeClient = () =>
  ({ serverName: () => 'mini', close: vi.fn() }) as unknown as RemoteClient;

interface Harness {
  statuses: RemoteLinkStatus[];
  attached: RemoteClient[];
  connect: ReturnType<typeof vi.fn>;
  wake: () => void;
  loop: ReturnType<typeof createReattachLoop>;
}

function harness(connect: () => Promise<RemoteClient>): Harness {
  const statuses: RemoteLinkStatus[] = [];
  const attached: RemoteClient[] = [];
  const wakeListeners = new Set<() => void>();
  const connectSpy = vi.fn(connect);

  const loop = createReattachLoop({
    serverName: 'mini',
    connect: connectSpy,
    onStatus: (status) => statuses.push(status),
    onAttached: (client) => attached.push(client),
    onWake: (listener) => {
      wakeListeners.add(listener);
      return () => wakeListeners.delete(listener);
    },
    now: () => Date.now(),
  });

  return {
    statuses,
    attached,
    connect: connectSpy,
    wake: () => {
      for (const listener of wakeListeners) listener();
    },
    loop,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createReattachLoop', () => {
  it('never dials for a cause another dial would reproduce', async () => {
    const h = harness(async () => fakeClient());

    h.loop.begin(TERMINAL);
    await vi.advanceTimersByTimeAsync(120_000);

    /*
      The whole point of the terminal classification. A revoked device presents
      the same credential on every retry, so a loop here would re-refuse on a
      timer forever while the pane said "reconnecting" about something that was
      never going to reconnect.
    */
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.statuses).toEqual([
      {
        state: 'disconnected',
        serverName: 'mini',
        attempt: 0,
        nextAttemptAt: null,
        reason: 'That device was revoked.',
        epoch: 0,
      },
    ]);
  });

  it('walks the backoff, one dial per step', async () => {
    const h = harness(async () => {
      throw new Error('ECONNREFUSED');
    });

    h.loop.begin(TRANSPORT);

    // Nothing dials on the drop itself; the first step is a wait.
    expect(h.connect).not.toHaveBeenCalled();

    const seen: number[] = [];
    for (const step of BACKOFF_MS) {
      await vi.advanceTimersByTimeAsync(step);
      seen.push(h.connect.mock.calls.length);
    }

    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);

    // And then it holds at the ceiling rather than growing without bound.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.connect).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.connect).toHaveBeenCalledTimes(8);
  });

  it('says which attempt is coming and when', async () => {
    const h = harness(async () => {
      throw new Error('ECONNREFUSED');
    });

    h.loop.begin(TRANSPORT);
    const first = h.statuses.at(-1);
    expect(first).toMatchObject({
      state: 'reconnecting',
      serverName: 'mini',
      attempt: 1,
      reason: null,
    });
    expect(first?.nextAttemptAt).toBe(Date.now() + BACKOFF_MS[0]);

    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);

    const second = h.statuses.at(-1);
    expect(second).toMatchObject({ state: 'reconnecting', attempt: 2 });
    expect(second?.nextAttemptAt).toBe(Date.now() + BACKOFF_MS[1]);
  });

  it('hands over the client and raises the epoch on a reattach', async () => {
    const client = fakeClient();
    const h = harness(async () => client);

    h.loop.begin(TRANSPORT);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);

    expect(h.attached).toEqual([client]);
    expect(h.statuses.at(-1)).toEqual({
      state: 'attached',
      serverName: 'mini',
      attempt: 0,
      nextAttemptAt: null,
      reason: null,
      /*
        1, not 0. The renderer keys the effects that own per-surface state on
        this: the server minted a new surface id for the new socket, and the
        old surface's fs watcher, foreground record and delivery focus went
        away with the old one.
      */
      epoch: 1,
    });
  });

  it('stops dialling once it is back', async () => {
    const h = harness(async () => fakeClient());

    h.loop.begin(TRANSPORT);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
    expect(h.connect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.connect).toHaveBeenCalledTimes(1);
  });

  it('counts each reattach, so two drops give two epochs', async () => {
    const h = harness(async () => fakeClient());

    h.loop.begin(TRANSPORT);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
    h.loop.begin(TRANSPORT);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);

    expect(h.statuses.filter((s) => s.state === 'attached').map((s) => s.epoch)).toEqual([
      1, 2,
    ]);
  });

  it('goes terminal when a retry is refused for good', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      const { AttachRefusedError } = await import(
        '../../../../electron/remote-client/socket'
      );
      throw new AttachRefusedError('revoked', 'That device was revoked.');
    });

    h.loop.begin(TRANSPORT);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[1]);

    expect(h.statuses.at(-1)).toMatchObject({
      state: 'disconnected',
      reason: 'That device was revoked.',
    });

    // And it really has stopped, rather than merely said so.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it('dials again immediately on waking, from the first step', async () => {
    const h = harness(async () => {
      throw new Error('ECONNREFUSED');
    });

    h.loop.begin(TRANSPORT);
    // Out to the ceiling, where a lid closed overnight would leave it.
    for (const step of BACKOFF_MS) await vi.advanceTimersByTimeAsync(step);
    const before = h.connect.mock.calls.length;

    h.wake();
    await vi.advanceTimersByTimeAsync(0);

    /*
      Without this, opening a laptop reattaches up to thirty seconds later —
      long enough to look broken to someone who just watched the machine wake.
    */
    expect(h.connect).toHaveBeenCalledTimes(before + 1);

    // And the backoff really restarted, rather than the wake being one free dial.
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
    expect(h.connect).toHaveBeenCalledTimes(before + 2);
  });

  it('cancels a pending retry', async () => {
    const h = harness(async () => fakeClient());

    h.loop.begin(TRANSPORT);
    h.loop.cancel();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(h.connect).not.toHaveBeenCalled();
  });

  it('drops a dial that lands after it was cancelled', async () => {
    let release: (client: RemoteClient) => void = () => undefined;
    const h = harness(
      async () =>
        new Promise<RemoteClient>((resolve) => {
          release = resolve;
        }),
    );

    h.loop.begin(TRANSPORT);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
    expect(h.connect).toHaveBeenCalledTimes(1);

    /*
      Detaching while a dial is in flight. Without the guard the socket that
      lands afterwards is adopted — the user asked to work locally and the app
      silently reattaches them a second later.
    */
    h.loop.cancel();
    const orphan = fakeClient();
    release(orphan);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.attached).toEqual([]);
    /*
      And it is closed rather than merely dropped. An unowned socket still holds
      its half of the server's fan-out and counts against the attachment it is
      no longer part of — the same reason `unbindEverything` closes the client
      it dialled instead of letting the reference go.
    */
    expect(orphan.close).toHaveBeenCalledTimes(1);
  });

  it('stops listening for wakes once cancelled', async () => {
    const h = harness(async () => fakeClient());

    h.loop.begin(TRANSPORT);
    h.loop.cancel();
    h.wake();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.connect).not.toHaveBeenCalled();
  });

  it('ignores a second begin while it is already running', async () => {
    const h = harness(async () => {
      throw new Error('ECONNREFUSED');
    });

    h.loop.begin(TRANSPORT);
    h.loop.begin(TRANSPORT);
    await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);

    /*
      `onClose` fires once, so this should not happen — but two loops against
      one drop would dial twice on every step and race each other's success,
      which is worth one guard rather than one assumption.
    */
    expect(h.connect).toHaveBeenCalledTimes(1);
  });
});
