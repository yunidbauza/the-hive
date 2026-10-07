/**
 * The app's two names, which are deliberately not the same string.
 *
 * **`APP_DISPLAY_NAME` is what people read**: the app menu and its About, Hide
 * and Quit items, the About window, the update dialogs and the server's tray.
 * The Dock, Cmd-Tab and Launchpad say it too, through `CFBundleDisplayName`
 * in `electron-builder.yml`'s `mac.extendInfo`. The menu bar's leftmost title
 * does not: it reads `CFBundleName`, which must stay the identity (Electron
 * finds its helper apps by it).
 *
 * **`APP_IDENTITY_NAME` is what the app *is***, and changing it is not cosmetic:
 * - `app.setName` takes it, and `userData` is derived from it
 *   (`~/Library/Application Support/The Hive`): the window state, the hook
 *   settings, the session history, the generated plugin every session loads.
 * - Electron names the Keychain item that `safeStorage` encrypts with after it,
 *   so the stored Jira and remote credentials are only readable under it.
 * - `productName` in `electron-builder.yml` matches it, and that names the
 *   bundle (`The Hive.app`), its executable, the dmg and zip the updater
 *   fetches, and the path a server's LaunchAgent runs. Finder shows the bundle's
 *   file name, so it keeps saying "The Hive" until it changes (the Dock and
 *   Launchpad prefer `CFBundleDisplayName`, so they say Hive TTY).
 *
 * See `docs/packaging-and-updates.md` ("The app's name") for what moving the
 * identity would take.
 */
export const APP_DISPLAY_NAME = 'Hive TTY';
export const APP_IDENTITY_NAME = 'The Hive';
