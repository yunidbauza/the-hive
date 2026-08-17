import { BrowserWindow } from 'electron';

/**
 * Which windows are *the app*, and which are furniture.
 *
 * Three places in main reach for "the window" by taking the first thing
 * `BrowserWindow.getAllWindows()` hands back, or by counting that list:
 * re-creating the window on a dock click, focusing on a second instance, and
 * parenting the updater's dialogs. Every one of them was correct while the app
 * had exactly one durable window and a splash that destroys itself.
 *
 * The About panel broke that premise. It is a `BrowserWindow`, it is long-lived,
 * and it can be the *only* one open — close the main window on macOS (the app
 * stays alive), choose About from the menu, then click the dock icon: the count
 * is 1, so nothing is re-created, and the user is left with a panel about an app
 * they can no longer reach.
 *
 * A registry rather than a flag on the window, because Electron gives no field
 * to hang one on and a subclass would have to be threaded through every
 * construction site. Entries remove themselves on `closed`, so this never keeps
 * a destroyed window alive.
 */
const auxiliary = new WeakSet<BrowserWindow>();

/**
 * Declare a window furniture: real, but not somewhere the user can work.
 *
 * Called by the splash and the About panel. The splash never needed it — it is
 * destroyed within seconds of the main window appearing — but it is registered
 * anyway, because "the transient one happens not to overlap" is a coincidence
 * rather than a rule, and the next window like it would rediscover this bug.
 */
export function markAuxiliary(win: BrowserWindow): void {
  auxiliary.add(win);
}

export const isAuxiliary = (win: BrowserWindow): boolean => auxiliary.has(win);

/** Every live window the user can actually work in. */
export const appWindows = (): BrowserWindow[] =>
  BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && !isAuxiliary(win),
  );

/**
 * The window to focus, or to hang a dialog on.
 *
 * `undefined` when the app is running with no main window — a real macOS state,
 * and the caller's business rather than something to paper over here.
 */
export const primaryWindow = (): BrowserWindow | undefined => appWindows()[0];
