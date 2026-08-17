import { Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * The application menu (story 081).
 *
 * **Not optional.** An Electron app with no `Menu` gets no `Cmd+C`, `Cmd+V`,
 * `Cmd+A` or `Cmd+Q` on macOS, because those are menu accelerators rather than
 * browser behaviour. In an app whose entire point is a terminal you copy text
 * out of, that is a broken product — and it fails silently, since nothing
 * errors when a keystroke simply does nothing.
 *
 * `Cmd+C` inside a *focused terminal* is revisited in story 095, where
 * copy-on-selection and Ctrl-C-as-SIGINT have to coexist.
 */

export interface MenuContext {
  isMac: boolean;
  /** DevTools is a dev-only affordance; a shipped app does not offer it. */
  isDev: boolean;
  appName: string;
  /**
   * Runs "Check for updates…". Injected rather than imported so the template
   * stays a pure value — the unit test asserts the item is *there* and that
   * choosing it calls this, neither of which should need an updater.
   *
   * Optional: the menu is also built in contexts that have no updater, and an
   * absent handler drops the item rather than offering one that does nothing.
   */
  onCheckForUpdates?: () => void;
  /**
   * Opens the app's own About panel, replacing `{ role: 'about' }`.
   *
   * Injected for the same reason as {@link MenuContext.onCheckForUpdates}: the
   * template stays a pure value, and the test asserts the item exists and calls
   * this without needing a `BrowserWindow`.
   *
   * Optional, and an absent handler falls back to the stock panel rather than
   * dropping the item — About is the one entry macOS users expect to be there,
   * and a menu missing it is stranger than one showing Electron's version.
   */
  onShowAbout?: () => void;
}

/**
 * Built as a pure template so the menu's *contents* are unit-testable without
 * an Electron instance — the assertion that matters is "Copy and Quit exist",
 * and it should not require booting a window.
 */
export function buildMenuTemplate({
  isMac,
  isDev,
  appName,
  onCheckForUpdates,
  onShowAbout,
}: MenuContext): MenuItemConstructorOptions[] {
  /**
   * The app's own panel, not Electron's.
   *
   * `{ role: 'about' }` opens the stock panel — the framework's atom logo, the
   * name "Electron", and its version. All true of the runtime, and none of it
   * what anybody opens About to find out; the app's name does not even appear.
   *
   * Named `About <appName>` explicitly because a custom item does not inherit
   * the role's platform label, and "About" alone in the app menu would be the
   * one entry there that does not say what it is about.
   */
  const aboutItem: MenuItemConstructorOptions =
    onShowAbout === undefined
      ? { role: 'about' }
      : { label: `About ${appName}`, click: () => onShowAbout() };
  /**
   * Directly under About, which is where macOS users look for it.
   *
   * The ellipsis is Apple's convention and it is load-bearing information: it
   * promises the item opens something rather than acting immediately. This one
   * always answers with a dialog — including "You're up to date", which is the
   * case a version without the ellipsis would mislead about.
   */
  const updateItem: MenuItemConstructorOptions[] =
    onCheckForUpdates === undefined
      ? []
      : [
          { type: 'separator' },
          { label: 'Check for Updates…', click: () => onCheckForUpdates() },
        ];

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: appName,
          submenu: [
            aboutItem,
            ...updateItem,
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
      ]
    : [];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: 'reload' },
    ...(isDev
      ? ([{ role: 'toggleDevTools' }] satisfies MenuItemConstructorOptions[])
      : []),
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  return [
    ...appMenu,
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: viewSubmenu },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(isMac
          ? ([{ role: 'zoom' }] satisfies MenuItemConstructorOptions[])
          : []),
        { role: 'close' },
      ],
    },
    // No Help menu: there is nowhere to send anyone yet, and a menu item that
    // opens a 404 is worse than its absence.
  ];
}

export function installApplicationMenu(context: MenuContext): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(context)));
}
