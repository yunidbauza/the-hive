import { HOOK_ENV_SESSION, HOOK_ENV_TOKEN, type HookStatusEvent } from '@shared/hook-contract';

import { createReceiver, type Receiver } from './receiver';
import { writeHookSettings } from './settings';

/**
 * The hook pipeline, as one thing the session layer can hold (HIVE-62).
 *
 * Two moving parts that are useless apart — a receiver with no settings file is
 * an endpoint nothing knows about, and a settings file with no receiver points
 * every session's hooks at a closed port — so they start together, fail
 * together, and are switched off together.
 *
 * **Everything here degrades rather than throws.** `settingsPath` is `null`
 * until the receiver is listening and the file is on disk, and a session spawned
 * while it is `null` simply gets no `--settings` flag. That session's status
 * comes from `activity.ts` exactly as it did before this story. The rule is that
 * no session ever fails to start, or starts differently, because status
 * reporting is unavailable.
 */

export interface HookRuntimeOptions {
  /** Where the settings file is written. Electron's `app.getPath('userData')`. */
  userDataPath: string;
  /** Overridable for tests; `0` asks the OS for a free port. */
  port?: number;
}

export interface HookRuntime {
  /**
   * Bind, write the settings file, and begin reporting.
   *
   * Resolves either way. `settingsPath` afterwards is the honest answer to
   * whether it worked.
   */
  start(
    knowsSession: (entityId: string) => boolean,
    onEvent: (event: HookStatusEvent) => void,
  ): Promise<void>;
  /** The `--settings` argument, or `null` when hooks are not available. */
  readonly settingsPath: string | null;
  /**
   * The environment a session's pty needs for its hooks to be attributable.
   *
   * Empty when hooks are unavailable, which is what keeps the caller from
   * having to ask: it always merges this in, and merging nothing is correct.
   */
  envFor(entityId: string): Record<string, string>;
  stop(): Promise<void>;
}

export function createHookRuntime(options: HookRuntimeOptions): HookRuntime {
  const { userDataPath, port } = options;

  let receiver: Receiver | null = null;
  let settingsPath: string | null = null;

  return {
    get settingsPath() {
      return settingsPath;
    },

    async start(knowsSession, onEvent) {
      const created = createReceiver({
        onEvent,
        knowsSession,
        ...(port === undefined ? {} : { port }),
      });

      const url = await created.start();
      if (url === null) {
        console.info(
          '[hive] hook receiver could not bind — session status falls back to pty activity',
        );
        return;
      }

      try {
        settingsPath = await writeHookSettings(userDataPath, url);
        receiver = created;
      } catch (cause) {
        /**
         * A receiver nobody can be told about is worse than none: it holds a
         * port for the life of the app and reports nothing. So the failure to
         * write the file takes the socket down with it.
         */
        await created.stop();
        console.info(
          `[hive] hook settings could not be written — session status falls back to pty activity (${String(cause)})`,
        );
      }
    },

    envFor(entityId): Record<string, string> {
      const running = receiver;
      if (running === null || settingsPath === null) return {};
      return {
        [HOOK_ENV_SESSION]: entityId,
        [HOOK_ENV_TOKEN]: running.token,
      };
    },

    async stop() {
      const running = receiver;
      receiver = null;
      settingsPath = null;
      if (running !== null) await running.stop();
    },
  };
}

export { createReceiver } from './receiver';
export { hookSettings, writeHookSettings, HOOK_SETTINGS_FILE } from './settings';
