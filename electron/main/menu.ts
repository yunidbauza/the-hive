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
}: MenuContext): MenuItemConstructorOptions[] {
  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: appName,
          submenu: [
            { role: 'about' },
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
