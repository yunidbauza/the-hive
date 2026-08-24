import {
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  type HookStatusEvent,
  type HookTicketIntentEvent,
} from '@shared/hook-contract';
import type { SessionMetrics } from '@shared/metrics-contract';
import type { SessionTheme } from '@shared/session-contract';

import { createReceiver, type Receiver } from './receiver';
import { writeHookSettings, type HookSettingsPaths } from './settings';

/**
 * The hook pipeline, as one thing the session layer can hold (HIVE-62).
 *
 * Two moving parts that are useless apart — a receiver with no settings file is
 * an endpoint nothing knows about, and a settings file with no receiver points
 * every session's hooks at a closed port — so they start together, fail
 * together, and are switched off together.
 *
 * **Everything here degrades rather than throws.** `settingsPathFor` answers `null`
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
  /** A session declared itself finished — `/done` (HIVE-93). */
  onDone: (entityId: string) => void;
  /** Claude is up and the shell's boot output is over (HIVE-101). */
  onReady: (entityId: string) => void;
}

export interface HookRuntime {
  /**
   * Bind, write the settings file, and begin reporting.
   *
   * Resolves either way. `settingsPathFor` afterwards is the honest answer to
   * whether it worked.
   */
  start(handlers: HookHandlers): Promise<void>;
  /**
   * The `--settings` argument for a session dressed in `theme`, or `null` when
   * hooks are not available.
   *
   * A function rather than a property because there is now one file per theme
   * — see `settings.ts` for why both are written up front rather than one
   * rewritten. `theme` is optional and omitting it answers with the dark file,
   * which is what every caller got before the light one existed.
   */
  settingsPathFor(theme?: SessionTheme): string | null;
  /**
   * The environment a session's pty needs for its hooks to be attributable.
   *
   * Empty when hooks are unavailable, which is what keeps the caller from
   * having to ask: it always merges this in, and merging nothing is correct.
   */
  envFor(entityId: string): Record<string, string>;
  /**
   * The URL `/done`'s body POSTs to, or `null` when hooks are unavailable
   * (HIVE-93).
   *
   * Read by the **skills** runtime, which is a sibling of this one and holds no
   * reference to it — so the value travels as a getter passed at construction
   * rather than as a dependency. That indirection is what keeps the two
   * runtimes independent while letting the generated skill name a port this one
   * chose at bind time, on a schedule (`sync()` before every spawn) that is
   * always later than the bind.
   *
   * `null` is load-bearing rather than a placeholder: it is what makes the
   * generated `/done` fall back to a body that promises nothing, instead of one
   * that curls an address nobody is listening on.
   */
  doneUrl(): string | null;
  stop(): Promise<void>;
}

export function createHookRuntime(options: HookRuntimeOptions): HookRuntime {
  const { userDataPath, port, sessionMetrics = () => true } = options;

  let receiver: Receiver | null = null;
  let settingsPaths: HookSettingsPaths | null = null;

  return {
    settingsPathFor(theme = 'dark') {
      return settingsPaths?.[theme] ?? null;
    },

    async start({
      knowsSession,
      onEvent,
      onTicketIntent,
      onCleared,
      onMetrics,
      onDone,
      onReady,
    }) {
      const created = createReceiver({
        onEvent,
        onTicketIntent,
        onCleared,
        onMetrics,
        onDone,
        onReady,
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
        settingsPaths = await writeHookSettings(
          userDataPath,
          url,
          /*
            Omitted entirely when the user has turned metrics off, which is what
            keeps `statusLine` out of the settings file — and therefore keeps
            Claude Code's footer key hints, which it drops for any configured
            status line whether or not that line renders anything.
          */
          sessionMetrics() ? (created.metricsUrl ?? undefined) : undefined,
          /*
            The ready URL rides along on the same terms (HIVE-101), and is not
            behind the metrics preference: the boot overlay is not a metric, and
            a user who has turned the status line off has not asked to watch
            `direnv` again.
          */
          created.readyUrl ?? undefined,
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

    doneUrl(): string | null {
      /*
        Gated on `settingsPaths` as well as the receiver, exactly as `envFor` is.
        A bound socket whose settings file failed to write is a session with no
        `HIVE_HOOK_TOKEN` in its environment, so the command would build a
        request that could only ever be refused — and a `/done` that 403s is
        worse than one that says up front it cannot finish the session.
      */
      const running = receiver;
      if (running === null || settingsPaths === null) return null;
      return running.doneUrl;
    },

    envFor(entityId): Record<string, string> {
      const running = receiver;
      if (running === null || settingsPaths === null) return {};
      return {
        [HOOK_ENV_SESSION]: entityId,
        [HOOK_ENV_TOKEN]: running.token,
      };
    },

    async stop() {
      const running = receiver;
      receiver = null;
      settingsPaths = null;
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
  HOOK_SETTINGS_DIR,
  METRICS_SCRIPT_FILE,
} from './settings';
export { parseMetrics } from './metrics';
