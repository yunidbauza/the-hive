import {
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  type HookStatusEvent,
  type HookTicketIntentEvent,
} from '@shared/hook-contract';
import type { SessionMetrics } from '@shared/metrics-contract';

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
  /**
   * Whether to inject the status line that reports usage (HIVE-79).
   *
   * A function rather than a boolean, read at `start()`, for the reason
   * `SessionsOptions.config` is one: the config can be reloaded, and a value
   * captured at construction would pin whatever it said when the app booted.
   *
   * Defaults to injecting. Hooks and metrics start and stop together
   * *structurally* — one file, one receiver — but they are separable in this one
   * respect, because the status line has a visible cost inside the terminal
   * (Claude Code drops its footer key hints) and the hooks have none.
   */
  sessionMetrics?: () => boolean;
  /** Overridable for tests; `0` asks the OS for a free port. */
  port?: number;
}

/**
 * What the session layer wants told to it.
 *
 * Named rather than positional, and that changed with HIVE-78 adding a fourth.
 * Three bare callbacks in a row were already at the limit of what a call site
 * can be read for; a fourth of the same arity would be a swap nothing catches —
 * the hazard `pty-transport.ts` records for `requestSpawn` and fixed the same
 * way.
 */
export interface HookHandlers {
  /** Whether an entity id is a session this app actually has. */
  knowsSession: (entityId: string) => boolean;
  onEvent: (event: HookStatusEvent) => void;
  /** A prompt named a ticket (HIVE-78). Unconfirmed — see the contract. */
  onTicketIntent: (event: HookTicketIntentEvent) => void;
  onCleared: (entityId: string) => void;
  /** A session reported its context and rate-limit usage (HIVE-79). */
  onMetrics: (entityId: string, metrics: SessionMetrics) => void;
}

export interface HookRuntime {
  /**
   * Bind, write the settings file, and begin reporting.
   *
   * Resolves either way. `settingsPath` afterwards is the honest answer to
   * whether it worked.
   */
  start(handlers: HookHandlers): Promise<void>;
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
  const { userDataPath, port, sessionMetrics = () => true } = options;

  let receiver: Receiver | null = null;
  let settingsPath: string | null = null;

  return {
    get settingsPath() {
      return settingsPath;
    },

    async start({ knowsSession, onEvent, onTicketIntent, onCleared, onMetrics }) {
      const created = createReceiver({
        onEvent,
        onTicketIntent,
        onCleared,
        onMetrics,
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
        /*
          The metrics URL rides along rather than being written separately: one
          settings file, one write, and a session either gets both halves of
          what this runtime offers or neither. `metricsUrl` is non-null here by
          construction — the bind succeeded — but it is read rather than rebuilt
          so the path lives in exactly one place.
        */
        settingsPath = await writeHookSettings(
          userDataPath,
          url,
          /*
            Omitted entirely when the user has turned metrics off, which is what
            keeps `statusLine` out of the settings file — and therefore keeps
            Claude Code's footer key hints, which it drops for any configured
            status line whether or not that line renders anything.
          */
          sessionMetrics() ? (created.metricsUrl ?? undefined) : undefined,
        );
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
export {
  hookSettings,
  metricsScript,
  statusLineSettings,
  writeHookSettings,
  HOOK_SETTINGS_FILE,
  METRICS_SCRIPT_FILE,
} from './settings';
export { parseMetrics } from './metrics';
