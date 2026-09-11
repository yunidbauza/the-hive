import type { RemoteLinkStatus } from '@shared/ipc-contract';

import { classifyCause, type CloseCause, type RemoteClient } from '../../remote-client/socket';

/**
 * How long to wait before each retry, and the ceiling it holds at.
 *
 * Front-loaded because most drops are brief — a tailnet blip, a peer that slept
 * for a moment — and those should be invisible. The tail is thirty seconds
 * because the drops that are not brief are usually a machine rebooting or a
 * network that is gone, and polling either one faster achieves nothing at some
 * cost to a laptop battery.
 *
 * The last entry repeats for as long as the loop runs. There is no give-up
 * step, deliberately: see {@link createReattachLoop}.
 */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

export interface ReattachDeps {
  /** The far machine's name, for every status this loop emits. */
  serverName: string;
  /** One dial. Rejects the way `connectRemote` does. */
  connect: () => Promise<RemoteClient>;
  /** Called on every transition, for the renderer. */
  onStatus: (status: Omit<RemoteLinkStatus, 'lost'>) => void;
  /** Called once per successful reattach, with the live client. */
  onAttached: (client: RemoteClient) => void;
  /**
   * Subscribe to this machine waking from sleep. Returns an unsubscribe.
   *
   * Injected rather than reached for directly so the schedule is testable
   * without Electron — `powerMonitor` is only meaningful after `whenReady`, and
   * this module has no other reason to import `electron` at all.
   */
  onWake?: (listener: () => void) => () => void;
  /** Injectable clock, for `nextAttemptAt`. */
  now?: () => number;
  /**
   * Mints the epoch a successful reattach reports (HIVE-150).
   *
   * Supplied by the caller rather than counted here, because the value has to
   * be monotonic across the *window's* whole life and this object's life is one
   * attachment. A detach or a re-target builds a new loop, and a per-loop
   * counter restarts at 0 — so re-attaching to the same server, with the same
   * project and session open, would leave every input to the renderer's
   * epoch-keyed effects unchanged and neither would re-arm against the new
   * surface.
   */
  nextEpoch: () => number;
}

export interface ReattachLoop {
  /** Start reconnecting, or go terminal, according to `cause`. */
  begin(cause: CloseCause): void;
  /** Stop for good: no pending timer survives, no in-flight dial is adopted. */
  cancel(): void;
}

/**
 * Dials a dropped attachment again until it comes back (HIVE-150).
 *
 * **It never gives up, and it never falls back to local on its own.** Both are
 * deliberate. The user's sessions are running on the far machine; a local
 * surface would show an empty fleet, which reads as data loss rather than as a
 * disconnection. And a budget that expires strands whoever's server took longer
 * to come back than the budget allowed — a reboot, a lid, a tailnet that
 * reconnects on its own schedule. What makes indefinite retrying honest rather
 * than silent is that it says so: every transition raises a status, the header
 * chip goes amber, and the attach pane offers a button. The exit is a decision,
 * not a timeout.
 *
 * **A terminal cause is not retried at all.** `unauthorized`, `revoked`,
 * `protocol-mismatch`, a refused address, an oversized attach frame: every one
 * of them would be reproduced exactly by the next dial, so a loop would
 * re-refuse forever behind a pane claiming to be reconnecting.
 */
export function createReattachLoop(deps: ReattachDeps): ReattachLoop {
  const { serverName, connect, onStatus, onAttached, onWake, nextEpoch, now = Date.now } = deps;

  let timer: NodeJS.Timeout | null = null;
  let stopWake: (() => void) | null = null;
  let attempt = 0;
  /** The last epoch this loop reported, so every status carries a stable one. */
  let epoch = 0;
  let running = false;
  /*
    Bumped by anything that invalidates a dial already in flight — a cancel, or
    a wake that restarts the schedule. The dial's own resolution checks it
    before adopting a client, because a promise cannot be un-awaited: without
    this, detaching while a dial was outstanding would silently reattach the
    user a moment after they asked to work locally.
  */
  let generation = 0;

  const emit = (status: Omit<RemoteLinkStatus, 'serverName' | 'epoch' | 'lost'>): void => {
    onStatus({ ...status, serverName, epoch });
  };

  const stopTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const finish = (): void => {
    running = false;
    generation += 1;
    stopTimer();
    stopWake?.();
    stopWake = null;
  };

  const schedule = (): void => {
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    emit({ state: 'reconnecting', attempt, nextAttemptAt: now() + wait, reason: null });
    stopTimer();
    timer = setTimeout(() => {
      void dial(generation);
    }, wait);
  };

  const dial = async (mine: number): Promise<void> => {
    let client: RemoteClient;
    try {
      client = await connect();
    } catch (cause) {
      if (mine !== generation) return;
      const classified = classifyCause(cause);
      if (classified.kind === 'terminal') {
        finish();
        emit({ state: 'disconnected', attempt: 0, nextAttemptAt: null, reason: classified.message });
        return;
      }
      schedule();
      return;
    }

    if (mine !== generation) {
      /*
        Cancelled, or superseded by a wake, while this dial was outstanding.
        The socket is real and nobody owns it, so it is closed rather than
        leaked — an orphaned socket holds a handle on the server and counts
        against the attachment it is no longer part of.

        Guarded, because this whole function runs as a floating promise off a
        timer: a `close()` that threw here would surface as an unhandled
        rejection in main rather than as anything anyone could act on, and
        failing to close an orphan is not worth taking the process down for.
      */
      try {
        client.close();
      } catch {
        // Nothing to do about it, and nobody to tell.
      }
      return;
    }

    finish();
    epoch = nextEpoch();
    attempt = 0;
    emit({ state: 'attached', attempt: 0, nextAttemptAt: null, reason: null });
    onAttached(client);
  };

  return {
    begin(cause) {
      // `onClose` fires once, so this is a guard rather than an expectation:
      // two loops against one drop would dial twice per step and race.
      if (running) return;

      if (cause.kind === 'terminal') {
        emit({ state: 'disconnected', attempt: 0, nextAttemptAt: null, reason: cause.message });
        return;
      }

      running = true;
      attempt = 0;
      stopWake =
        onWake?.(() => {
          if (!running) return;
          /*
            A machine that just woke has a network that just came back, and the
            schedule may be parked thirty seconds out. Restarting from the first
            step and dialling now is the difference between a lid that opens
            already attached and one that looks broken for half a minute.
          */
          generation += 1;
          attempt = 1;
          stopTimer();
          /*
            Say so before dialling. Without this the pane keeps rendering the
            `nextAttemptAt` from the step that was pending when the machine went
            to sleep — a countdown to a moment that has already passed, next to
            an attempt number that is about to restart anyway.
          */
          emit({ state: 'reconnecting', attempt: 1, nextAttemptAt: now(), reason: null });
          void dial(generation);
        }) ?? null;
      schedule();
    },

    cancel() {
      if (!running) {
        // Still drop any wake subscription a terminal `begin` never took.
        stopWake?.();
        stopWake = null;
        return;
      }
      finish();
    },
  };
}
