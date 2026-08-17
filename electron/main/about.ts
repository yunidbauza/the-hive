import { join } from 'node:path';

import { BrowserWindow } from 'electron';

import { ABOUT_SIZE, ABOUT_TRAFFIC_LIGHT_POSITION } from '@shared/about';
import { WINDOW_BACKGROUND } from '@shared/window';

import { markAuxiliary } from './aux-windows';
import { applyWebContentsPolicy } from './window';

/**
 * The About panel — the app introducing itself (variant A, "the Chamber").
 *
 * It replaces `{ role: 'about' }`, which opens Electron's stock panel: the
 * framework's atom logo, the name "Electron", and its version. Every word of
 * that is true about the runtime and none of it is what somebody opens About to
 * find out.
 *
 * ## Why a window rather than a dialog
 *
 * `dialog.showMessageBox` cannot run the creature. The animation is a keyed
 * video on a canvas (`src/splash/chamber.ts`), which needs a document — and the
 * app already owns the pattern for a second document: the splash. This is that
 * pattern a second time, with one difference.
 *
 * ## Why this one gets a preload and the splash does not
 *
 * The splash is deliberately the dumbest window in the app because anything it
 * could be told would arrive over a channel that outlives it by seconds. This
 * window opens on demand, long after the bridge is up, and the things it shows
 * — the version, the runtime versions, whether a newer release exists — are
 * exactly what `AppInfo` was introduced for; its own docblock says "for the
 * About box and bug reports". Inventing a second, narrower channel to carry
 * facts an existing one already carries would be two contracts where one will
 * do, and the second would drift.
 *
 * It takes the *same* `applyWebContentsPolicy` as the main window, so
 * `window.open` is denied, navigation is scheme-checked, and external links go
 * to the OS browser rather than replacing this document.
 */

/** The live panel, or `null`. At most one exists. */
let current: BrowserWindow | null = null;

/** The document, from disk or from the dev server — mirrors `loadRenderer`. */
function loadAbout(win: BrowserWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(new URL('about.html', `${devUrl}/`).toString());
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/about.html'));
  }
}

/**
 * Open the panel, or raise the one already open.
 *
 * Singleton because About is a *statement*, not a document: choosing the menu
 * item twice means "show me", not "give me a second copy", and a stack of
 * identical panels is a bug every app that skipped this check has shipped.
 */
export function showAboutWindow(parent?: BrowserWindow | null): BrowserWindow {
  if (current && !current.isDestroyed()) {
    current.show();
    current.focus();
    return current;
  }

  const win = new BrowserWindow({
    ...ABOUT_SIZE,
    /** Revealed on `ready-to-show`, for the reason `window.ts` gives. */
    show: false,
    /**
     * `titleBarStyle: 'hidden'` rather than `frame: false` — the difference is
     * the close button, and it is the whole point.
     *
     * `frame: false` removes the traffic lights along with the title bar, which
     * left a panel with **no visible way out**. Escape closed it and always
     * did, but a keyboard shortcut nobody can see is not an affordance: the
     * first thing this shipped as was a window a user had to guess their way
     * out of.
     *
     * `hidden` keeps the frameless look and lets macOS draw the real controls
     * over the document. `minimizable` and `maximizable` are already false, so
     * those two render disabled and Close is the only live one — which is
     * exactly what a panel should offer.
     *
     * Chosen over drawing our own `×` because that button would need to close
     * its own window, and a renderer that can do that is a capability this app
     * grants nowhere else. The platform already has the control; borrowing it
     * costs no new IPC surface.
     */
    titleBarStyle: 'hidden',
    trafficLightPosition: ABOUT_TRAFFIC_LIGHT_POSITION,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    center: true,
    skipTaskbar: true,
    backgroundColor: WINDOW_BACKGROUND,
    /**
     * Modal is deliberately **not** set, and the parent is only used for
     * centring. About blocks nothing: a user who opens it to copy a version
     * number into a bug report should be able to keep reading the terminal
     * behind it.
     */
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // `.cjs` deliberately — a sandboxed preload cannot be ESM (story 080).
      preload: join(import.meta.dirname, '../preload/index.cjs'),
    },
  });

  current = win;
  /**
   * Furniture, not a place to work — see `aux-windows.ts`. Without this the
   * dock-click handler counts this panel as the app still being open, and a
   * user who closed the main window first has no way back to it.
   */
  markAuxiliary(win);

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (current === win) current = null;
  });

  /**
   * Frameless windows keep no close button, so Escape is the only way out that
   * does not involve the menu. Handled here rather than in the document because
   * closing a window is main's job, and a renderer that could close its own
   * window is a capability this app hands out nowhere else.
   */
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') win.close();
  });

  applyWebContentsPolicy(win);
  loadAbout(win);

  return win;
}

/** Test seam: forget the singleton without waiting for a real `closed` event. */
export function resetAboutWindow(): void {
  current = null;
}
