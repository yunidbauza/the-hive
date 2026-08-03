import { app } from 'electron';

import { installContentSecurityPolicy } from './csp';
import { registerIpcHandlers } from './ipc';
import { registerLifecycle } from './lifecycle';
import { registerPtyHost } from './pty-host';
import { createWindow } from './window';

/**
 * Main process entry (stories 081, 082).
 *
 * Lifecycle only. The window is `window.ts`, the platform handlers are
 * `lifecycle.ts`, the channels are `ipc/`, and teardown registration is
 * `shutdown.ts` — this file decides whether this process should run at all,
 * and then hands off.
 */

/**
 * The single-instance lock, first, before anything else is wired.
 *
 * `requestSingleInstanceLock()` returns false in the *second* process, which
 * must exit immediately — the first process gets a `second-instance` event and
 * focuses its window instead (see `lifecycle.ts`).
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerIpcHandlers();

  /**
   * Creates the pty-host supervisor and registers its teardown — it does
   * **not** start a process (story 091). The host is forked lazily on the
   * first session, because most launches land on the orchestrator console,
   * which owns no PTY.
   */
  registerPtyHost();

  /**
   * The CSP has to be installed before any renderer loads, and
   * `session.defaultSession` is only available once the app is ready.
   */
  void app.whenReady().then(() => installContentSecurityPolicy());

  registerLifecycle({ createWindow });
}
