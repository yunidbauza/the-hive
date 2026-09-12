import { app, powerMonitor, screen } from 'electron';

/**
 * How long after the last wake signal the listener runs.
 *
 * A wake arrives as a burst — `resume`, then `unlock-screen`, then a display
 * reattaching — and each one is the same news. One call after the burst, not
 * three SIGWINCH redraws in a row.
 */
export const DISPLAY_WAKE_SETTLE_MS = 1_000;

/**
 * Tell the listener when the machine wakes or a display comes back.
 *
 * Those are the moments Claude Code has been seen to lose its size, drawing at
 * 80×24 until the window is dragged. The caller answers with `refresh`, which
 * is that drag done for the user.
 *
 * Subscribed after `whenReady`, because `registerIpcHandlers` runs before it
 * and `screen` cannot be touched until then. Each subscription is attempted on
 * its own and a failure is swallowed: a wake that cannot be heard costs a
 * redraw, not the app, and a unit test's `electron` mock supplies only the
 * surface that test needs.
 */
export function onDisplayWake(
  listener: () => void,
  settleMs = DISPLAY_WAKE_SETTLE_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const poke = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      listener();
    }, settleMs);
  };

  const offs: Array<() => void> = [];
  const subscribe = (source: () => NodeJS.EventEmitter, event: string) => {
    try {
      const emitter = source();
      emitter.on(event, poke);
      offs.push(() => emitter.removeListener(event, poke));
    } catch {
      // Not available here. See the note above.
    }
  };

  try {
    void app.whenReady().then(() => {
      if (stopped) return;
      subscribe(() => powerMonitor, 'resume');
      subscribe(() => powerMonitor, 'unlock-screen');
      subscribe(() => screen, 'display-added');
    });
  } catch {
    // No app lifecycle here, so nothing to hear. See the note above.
  }

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    for (const off of offs) off();
  };
}
