import { app, BrowserWindow } from 'electron';

import { CH, type ForegroundReport } from '@shared/ipc-contract';

/**
 * This machine's own window focus, stamped onto `ui:foreground` on its way to
 * an attached server (HIVE-145).
 *
 * ## Why the client has to be the one to say it
 *
 * Notification suppression asks "is this session already in front of the
 * person". On the server that used to be `windowFocused()` — a fact about the
 * *server's* windows, read live rather than published by a renderer, because a
 * renderer-published boolean goes stale in exactly the case the feature exists
 * for: the window hidden, the app in the background, the renderer no longer
 * running to update it.
 *
 * Neither half of that survives the network. A served Mac usually has no
 * windows at all, and the ones it does have say nothing about a laptop four
 * time zones away. The only process that can see this machine's windows is this
 * one, so this is where the answer comes from — and it is still read live from
 * `BrowserWindow` rather than published by the renderer, which keeps the
 * original asymmetry intact with the reading moved one process along.
 *
 * ## Why `src/` is untouched
 *
 * The renderer sends the same one-key `{ terminalId }` it always sent, in local
 * mode and attached alike. This is a main-process concern on both ends, so the
 * whole feature lives in `electron/` and the renderer needs no idea whether it
 * is driving a local Hive or a remote one — which is server mode's own rule.
 *
 * ## Why a focus change re-sends
 *
 * The renderer reports on *stage* changes. Focus changes independently: a
 * cmd-tab away from the Hive is not a stage change and produces no
 * `ui:foreground` at all, so without this the server would hold a stale
 * `focused: true` for as long as the user was in another app, and go quiet
 * about the very session they walked away from.
 */
export interface ForegroundStamp {
  /**
   * The payload to actually send.
   *
   * A well-formed `{ terminalId }` comes back with `focused` added. **Anything
   * else is returned untouched**, deliberately: the server rejects rather than
   * sanitises, so that a compromised or buggy renderer cannot make a fabricated
   * shape read as "nothing on stage". Normalising a malformed payload here
   * would launder it past that guard.
   */
  stamp(payload: unknown): unknown;
  /** Stop watching focus. Called from `resetRemoteProxy`. */
  dispose(): void;
}

/**
 * Any window of ours, not the main one — the same set `windowFocused()` counts
 * on the server, and for the same reason: the About panel focused over the
 * terminal is still the app being in front of the user.
 */
const anyWindowFocused = (): boolean =>
  BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );

export function createForegroundStamp(
  notify: (channel: string, payload: unknown) => void,
): ForegroundStamp {
  /** What this machine last put on its stage, or `null` for nothing. */
  let terminalId: string | null = null;
  /** Whether the renderer has reported at all. Nothing to re-send before it has. */
  let reported = false;
  let tick: ReturnType<typeof setTimeout> | null = null;

  /*
    Deferred by a tick, coalescing the burst of a window switch into one send,
    for the reason `scheduleForegroundChange` in `ipc/index.ts` defers: on macOS
    `blur` on the outgoing window fires *before* `focus` on the incoming one, so
    switching between two of our own windows passes through a moment where none
    is focused. Sending synchronously there would tell the server the user had
    walked away, and it would toast about a session sitting in plain sight.
  */
  const resend = (): void => {
    if (tick !== null) return;
    tick = setTimeout(() => {
      tick = null;
      if (!reported) return;
      notify(CH.uiForeground, { terminalId, focused: anyWindowFocused() });
    }, 0);
    // Never a reason to hold the process open; the app's own windows do that.
    tick.unref?.();
  };

  app.on('browser-window-blur', resend);
  app.on('browser-window-focus', resend);

  return {
    stamp(payload) {
      if (typeof payload !== 'object' || payload === null) return payload;
      const record = payload as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length !== 1 || keys[0] !== 'terminalId') return payload;
      const reportedId = record.terminalId;
      if (reportedId !== null && typeof reportedId !== 'string') return payload;

      terminalId = reportedId;
      reported = true;
      return { terminalId: reportedId, focused: anyWindowFocused() } satisfies ForegroundReport;
    },

    dispose() {
      app.removeListener('browser-window-blur', resend);
      app.removeListener('browser-window-focus', resend);
      if (tick !== null) {
        clearTimeout(tick);
        tick = null;
      }
      reported = false;
      terminalId = null;
    },
  };
}
