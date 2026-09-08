import { BrowserWindow } from 'electron';

/**
 * Where a main → renderer push actually goes (HIVE-141).
 *
 * There is one fan-out point in the whole main tree, and it has been one since
 * story 106 put the notifier tap there rather than at each source. This
 * interface is that point given a name, so server mode can supply a second
 * implementation that writes to attached sockets without any of the 114 handler
 * bodies learning a socket exists.
 *
 * Deliberately one method. A `Broadcaster` does not know about the notifier, the
 * channel taxonomy, or which surfaces are attached — it takes a channel and a
 * payload and delivers them. The tap lives in `registerIpcHandlers`' own `send`,
 * one layer up, which is what lets the three notification pushes below reach
 * every surface while still bypassing the tap.
 */
export interface Broadcaster {
  /**
   * Deliver to every attached surface. Never throws: a failed delivery must not
   * cost a `pty:data`, and a caller in the typing path has nothing useful to do
   * with the failure anyway.
   */
  emit(channel: string, payload: unknown): void;
}

/**
 * Today's fan-out, unchanged: every live window, skipping destroyed ones.
 *
 * Windows are resolved per send rather than captured, because the window is
 * created after `registerIpcHandlers` runs and on macOS it can be closed and
 * re-created while the app keeps running. That was true of the closure this
 * replaces and it is still the reason.
 */
export function createWindowBroadcaster(): Broadcaster {
  return {
    emit(channel, payload) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        /*
          The `never throws` in the interface above, actually implemented.

          Two ways `send` throws that the inline loops this replaces got away
          with: a payload that is not structured-cloneable, and a `webContents`
          torn down in the window between `isDestroyed()` answering and the send
          landing — a race no check can close, because the answer is stale the
          moment it is given.

          It matters more here than it did there. `ledger.onChange` calls this
          from inside `Ledger.append`'s own try/catch, where the rule is that
          neither delivery nor the notifier may fail the write that triggered
          them; and one dead surface must never cost the other surfaces their
          event. Caught per window rather than around the loop for that second
          reason.
        */
        try {
          window.webContents.send(channel, payload);
        } catch (cause) {
          console.error(`[hive] broadcast failed on ${channel}:`, cause);
        }
      }
    },
  };
}
