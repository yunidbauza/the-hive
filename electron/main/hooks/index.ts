import { join } from 'node:path';

import type { AgentsDirectory } from '@shared/agent-contract';
import { DEFAULT_RECEIVER, type ResolvedContainer } from '@shared/config-contract';
import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  type HookAgentEvent,
  type HookStatusEvent,
  type HookTicketIntentEvent,
} from '@shared/hook-contract';
import type { SessionMetrics } from '@shared/metrics-contract';

import {
  containerOrigins,
  sweepSessionContainerFiles,
  writeSessionContainerFiles,
  writeSharedContainerFiles,
} from '../container/generated';
import type { Ledger } from '../ledger';

import { withHostAlias } from './container-origin';
import { createReceiver, type Receiver } from './receiver';
import { writeAgentSettings, writeHookSettings } from './settings';

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
   * The ledger (HIVE-111), threaded through rather than constructed here.
   *
   * This runtime has no opinion about where `~/.hive/ledger` lives or who
   * counts as a known party — `ipc/index.ts` is where both of those facts are
   * already reachable, from `configPath()` and the session registry. Handing
   * over a constructed `Ledger` keeps this module's only job the receiver's
   * lifecycle, the same division `HookHandlers` draws for everything else.
   */
  ledger: Ledger;
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
  /**
   * The hostname a container reaches this machine by (HIVE-132).
   *
   * A getter for the same reason {@link HookRuntimeOptions.sessionMetrics} is:
   * the config can be reloaded, and a value captured at construction would pin
   * whatever it said at boot. Injected rather than read from `../config`
   * directly, which is what keeps this runtime's job the receiver's lifecycle
   * and nothing else.
   *
   * **A reload does not rewrite the files already on disk.** This is read once
   * per `start()` for the generated set, and live by
   * {@link HookRuntime.containerOrigin}. So after a reload that changes the
   * alias, a containerised session would reach the receiver over MCP at the new
   * one while its hook settings still name the old — ledger calls working,
   * status and inbox events going nowhere. Rewriting the set on
   * `config:reload` belongs with the story that makes anything read it
   * (HIVE-133); until then nothing consumes either value in production.
   */
  hostAlias?: () => string;
  /**
   * A project's resolved container block, or `undefined` for a host project
   * (HIVE-133).
   *
   * A getter, like {@link HookRuntimeOptions.sessionMetrics} and
   * {@link HookRuntimeOptions.hostAlias}, and for the same two reasons: the
   * config can be reloaded, and this module imports nothing from `config/`.
   * `ipc/index.ts` supplies it as
   * `(id) => effectiveRuntime(getConfig(), getConfig().projects.find((entry)
   * => entry.id === id) ?? null).container` — there is no `projectById`
   * helper in this codebase; `configDiagnoseCommand` and `configDiagnoseEnv`
   * resolve a project id the same inline way.
   */
  containerFor?: (projectId: string | null) => ResolvedContainer | undefined;
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
  /**
   * Whether an entity id is an agent this app has a definition for (HIVE-115).
   *
   * Its own question rather than a wider {@link HookHandlers.knowsSession}, so
   * that "an agent gets hook events, and never a `session:status` push or a
   * history record" is decided by which callback matched. See
   * `ReceiverOptions.knowsAgent` for the argument in full.
   */
  knowsAgent: (entityId: string) => boolean;
  /**
   * Who else is on this machine (HIVE-127).
   *
   * Injected from the composition root rather than reached for here, because
   * that is the only place the agent registry and the run-state file are both
   * in scope — and because the receiver serving this must not learn to import
   * either of them.
   */
  onAgentsList: (caller: string) => Promise<AgentsDirectory>;
  onEvent: (event: HookStatusEvent) => void;
  /**
   * A hook event from an agent's headless turn (HIVE-115).
   *
   * {@link HookHandlers.onEvent}'s agent-space twin. Both required, because a
   * composition that supplied only one would be answering an id space it then
   * had nowhere to report — a shape worth failing to compile.
   */
  onAgentEvent: (event: HookAgentEvent) => void;
  /** A prompt named a ticket (HIVE-78). Unconfirmed — see the contract. */
  onTicketIntent: (event: HookTicketIntentEvent) => void;
  /**
   * A session's **first** prompt yielded a name for it (first-prompt naming).
   *
   * Already a session name, not a prompt: the receiver derives it and drops the
   * text. See `ReceiverOptions.onPromptName`.
   */
  onPromptName: (entityId: string, name: string) => void;
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
   * The `--settings` argument, or `null` when hooks are not available.
   *
   * A function rather than a property because it answers `null` until `start`
   * has resolved, so callers must ask at spawn rather than capture it. It took
   * a theme until HIVE-82, when the file stopped varying by one.
   */
  settingsPathFor(): string | null;
  /**
   * The `--settings` argument for an agent's headless turn (HIVE-119).
   *
   * {@link settingsPathFor}'s agent-space twin, `null` on the same terms —
   * hooks unavailable, or the write itself failing. Kept separate rather than
   * a parameter on `settingsPathFor` because the two files answer different
   * questions: a session asks "what am I handed", an agent's wake asks
   * "what fences every tool call", and conflating them would let a future edit
   * hand a session the agent's `permissions` block by accident.
   */
  agentSettingsPathFor(): string | null;
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
  /**
   * The receiver's origin as a *container* must address it, addressed by the
   * **global** alias, or `null` before the bind (HIVE-132).
   *
   * **Unused by any spawn path today (post-HIVE-133 review).** This was
   * written expecting HIVE-133's spawn path to read it for a containerised
   * session's `HIVE_RECEIVER_URL` — the doc here said so — but that story
   * ended up needing the *project's own* alias, not the global one this
   * getter applies, and built the substitution itself out of
   * {@link HookRuntime.envFor} plus `withHostAlias` instead (see
   * `sessions/index.ts`'s `containerSpawn`). Left in place — correctly,
   * genuinely working — as the answer to "what origin would a container using
   * the *default* alias see", which is still what `writeSharedContainerFiles`
   * bakes into the `exec-env` set at `start()`. A getter beside
   * {@link HookRuntime.doneUrl} rather than something folded into
   * {@link HookRuntime.envFor}, because nothing here knows which sessions are
   * containerised — that is deliberately a caller's decision, and a host
   * session's environment has to stay exactly what it is.
   */
  containerOrigin(): string | null;
  /**
   * Write one session's resolved container set, for a `rewrite` project.
   *
   * Returns the host directory written, or `null` when there was nothing to
   * write — a host project, an `exec-env` project, or a receiver that never
   * bound. The caller does not branch on why.
   */
  writeContainerSession(
    entityId: string,
    projectId: string | null,
  ): Promise<string | null>;
  stop(): Promise<void>;
}

export function createHookRuntime(options: HookRuntimeOptions): HookRuntime {
  const {
    userDataPath,
    port,
    sessionMetrics = () => true,
    hostAlias = () => DEFAULT_RECEIVER.hostAlias,
    containerFor,
    ledger,
  } = options;

  let receiver: Receiver | null = null;
  let settingsPath: string | null = null;
  let agentSettingsPath: string | null = null;

  return {
    settingsPathFor() {
      return settingsPath;
    },

    agentSettingsPathFor() {
      return agentSettingsPath;
    },

    async start({
      knowsSession,
      knowsAgent,
      onAgentsList,
      onEvent,
      onAgentEvent,
      onTicketIntent,
      onPromptName,
      onCleared,
      onMetrics,
      onDone,
      onReady,
    }) {
      const created = createReceiver({
        onEvent,
        onAgentEvent,
        onTicketIntent,
        onPromptName,
        onCleared,
        onMetrics,
        onDone,
        onReady,
        /*
          `caller` is the session id off `x-hive-session` (HIVE-111) — never
          trusted from the body, which is what `parseLedgerPostBody` already
          drops it from.

          The query goes down **unmodified**: `visibleTo` in the receiver
          narrows the result to "addressed to me, or broadcast, or from me",
          and defaulting `to: caller` here is strictly narrower than that —
          it would drop a caller's own ask, which is `from: sess-a,
          to: overmind`, and so leave no query at all by which a session could
          read back its own correspondence.
        */
        onLedgerRead: (_caller, query) => ledger.read(query),
        onLedgerPost: (caller, request) => ledger.append({ ...request, from: caller }),
        onAgentsList,
        knowsSession,
        knowsAgent,
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

          Both writes land in **local** variables first, and `settingsPath` /
          `agentSettingsPath` are assigned only once both have resolved — see
          the doc comment above this type: "two moving parts that are useless
          apart… start together, fail together". Assigning `settingsPath`
          straight from the first `await` (as this once did) let a failure in
          the second write strand a real, correctly-written session file with
          no receiver behind it — `settingsPathFor()` would answer a path that
          looked valid while every hook POST it named went nowhere. Holding
          both in locals until the second `await` resolves is what keeps that
          window from opening.
        */
        const newSettingsPath = await writeHookSettings(
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
        /*
          Written right after its sibling, with the same `url`/`readyUrl` — the
          only two values an agent's turn needs from this bind, since it gets no
          status line (HIVE-119). Unlike `settingsPath`, this file's content is
          fixed once the receiver is up: no wake ever calls this again, so
          there is nothing here to keep in sync on a later re-bind.
        */
        const newAgentSettingsPath = await writeAgentSettings(
          userDataPath,
          url,
          created.readyUrl ?? undefined,
        );

        /*
          Ahead of the three assignments below, and that placement is the whole
          correctness argument (HIVE-133).

          `containerOrigin()` is gated on `receiver` alone, so the instant
          `receiver = created` runs, a containerised session is spawnable and
          can write its own directory under this root. With the sweep after that
          line — where it used to be, 33 lines further down — a session opened
          during app boot wrote its directory and then had it deleted, and every
          hook and MCP call from that container 403'd with nothing logged.

          Here, `[]` is not an assumption to be defended but a fact: no session
          can exist yet, because the gate that permits one has not been assigned.
          The `live` parameter stays in the signature for a mid-run sweep that
          does not exist today.

          Its own `try`, and never blocking the write below. `rm` with `force`
          swallows a missing path but not `EPERM` or `EBUSY`, and a single
          undeletable orphan must not be the reason this launch has no container
          set at all.
        */
        try {
          await sweepSessionContainerFiles(userDataPath, []);
        } catch (cause) {
          console.info(
            `[hive] stale container session files could not be swept (${String(cause)})`,
          );
        }

        settingsPath = newSettingsPath;
        agentSettingsPath = newAgentSettingsPath;
        receiver = created;

        /*
          The container-flavoured set, beside the host one. Written
          unconditionally and cheaply: nothing here knows whether any session is
          containerised, and a set that exists costs four small files while a
          set that does not exist costs a containerised session every route it
          has — the status dot, the inbox, the gauges and `/done` (HIVE-132).

          Unlike the two writes above, a failure here does *not* take the socket
          down. Those files are what every host session depends on; these are
          what no host session touches, so the honest failure is a log and a
          receiver that still works for everyone it already worked for.
        */
        try {
          if (created.origin === null) {
            /*
              No origin means no honest container set: every URL in it is built
              from one. `envFor` handles the same case by omitting
              `HIVE_RECEIVER_URL` rather than substituting `url`, whose `/hook`
              suffix would make the MCP endpoint `…/hook/mcp` — a 404 on every
              call, with nothing anywhere to say why.
            */
            throw new Error('the receiver bound without an origin');
          }

          await writeSharedContainerFiles(
            userDataPath,
            containerOrigins(
              {
                url,
                origin: created.origin,
                ...(sessionMetrics() && created.metricsUrl !== null
                  ? { metricsUrl: created.metricsUrl }
                  : {}),
                ...(created.readyUrl === null
                  ? {}
                  : { readyUrl: created.readyUrl }),
              },
              hostAlias(),
            ),
          );
        } catch (cause) {
          console.info(
            `[hive] the container-flavoured files could not be written — a containerised session would start without them (${String(cause)})`,
          );
        }
      } catch (cause) {
        /**
         * A receiver nobody can be told about is worse than none: it holds a
         * port for the life of the app and reports nothing. So the failure to
         * write either file takes the socket down with it — and resets both
         * paths to `null`, in case the first write had already resolved before
         * the second one threw. Neither is ever left pointing at a file that
         * is, in fact, real and correctly written, with no receiver behind it.
         */
        await created.stop();
        settingsPath = null;
        agentSettingsPath = null;
        console.info(
          `[hive] hook settings could not be written — session status falls back to pty activity (${String(cause)})`,
        );
      }
    },

    doneUrl(): string | null {
      /*
        Gated on `settingsPath` as well as the receiver, exactly as `envFor` is.
        A bound socket whose settings file failed to write is a session with no
        `HIVE_HOOK_TOKEN` in its environment, so the command would build a
        request that could only ever be refused — and a `/done` that 403s is
        worse than one that says up front it cannot finish the session.
      */
      const running = receiver;
      if (running === null || settingsPath === null) return null;
      return running.doneUrl;
    },

    containerOrigin(): string | null {
      /*
        Gated on the receiver alone, not on `settingsPath`: what this answers is
        "where would a container address this machine", which is true as soon as
        the socket is bound and independent of whether the *host* set was
        written. The container set has its own files and its own failure.
      */
      const running = receiver;

      if (running === null || running.origin === null) return null;

      return withHostAlias(running.origin, hostAlias());
    },

    async writeContainerSession(entityId, projectId) {
      const running = receiver;
      /*
        `url` and `origin` are set together on a successful bind and cleared
        together on the way down (`receiver.ts`), so this is one fact checked
        twice, not two independent ones — but the type of each is `string |
        null` on its own, and only checking `origin` would leave `url` typed
        as possibly-`null` below.
      */
      if (running === null || running.origin === null || running.url === null) {
        return null;
      }

      /*
        Asked, not read. This module imports nothing from `config/` — see
        {@link HookRuntimeOptions.ledger}: its only job is the receiver's
        lifecycle, and `ipc/index.ts` is where a project's runtime is already
        reachable. A getter rather than a value for the reason `sessionMetrics`
        and `hostAlias` are getters: the config can be reloaded, and a value
        captured at construction would pin whatever it said at boot.
      */
      const config = containerFor?.(projectId);

      /*
        `exec-env` writes nothing per session: every per-session value in that
        set is a `${VAR}`, resolved by the runtime at each exec. Only `rewrite`
        bakes a live token, which is the trade that mode exists to make.
      */
      if (config === undefined || config.freshness !== 'rewrite') return null;

      return writeSessionContainerFiles(
        userDataPath,
        /*
          The **entity id**, never the registry's `entityId.gN`. `tokenFor` is
          HMAC(launchSecret, entityId) and the receiver compares against
          `tokenFor(entityId)` for the id in `x-hive-session`, so a directory
          named after the generation would carry a token refused on every call.
        */
        entityId,
        containerOrigins(
          {
            url: running.url,
            origin: running.origin,
            /*
              Gated on `sessionMetrics()`, matching its two neighbours — the
              host set (`writeHookSettings`, above) and the shared `exec-env`
              set (`writeSharedContainerFiles`, above). Without the gate, a
              user who turned session metrics off still got a status line
              baked into every `rewrite` container session: the dot never
              renders anything, but Claude Code drops its footer key hints for
              any *configured* status line, rendering or not.
            */
            ...(sessionMetrics() && running.metricsUrl !== null
              ? { metricsUrl: running.metricsUrl }
              : {}),
            ...(running.readyUrl === null ? {} : { readyUrl: running.readyUrl }),
          },
          config.hostAlias,
        ),
        { session: entityId, token: running.tokenFor(entityId) },
        {
          /*
            Where this set will be visible *inside* the container. The status
            line script is the one value in the set naming a path rather than a
            URL, so it is the only thing that needs it.
          */
          containerRoot: join(config.hiveDir, 'container', 'sessions', entityId),
        },
      );
    },

    envFor(entityId): Record<string, string> {
      const running = receiver;
      if (running === null || settingsPath === null) return {};
      return {
        [HOOK_ENV_SESSION]: entityId,
        [HOOK_ENV_TOKEN]: running.tokenFor(entityId),
        /*
          The third variable, for the MCP host (HIVE-112). A hook is handed its
          URL baked into the generated settings file, but the MCP host is
          started by `claude` from a config file written before this socket had
          bound — so it is told at spawn, the way its identity is.

          `running.origin` rather than `running.url`: the host builds its own
          request paths from `@shared/ledger-contract`, so it needs the bare
          scheme-and-authority, not `url`'s `/hook` suffix — see
          {@link Receiver.origin}.

          `running.origin` is non-null here: `settingsPath` is only set after a
          successful `start()`, which is also what assigns it.
        */
        ...(running.origin === null ? {} : { [HOOK_ENV_RECEIVER_URL]: running.origin }),
      };
    },

    async stop() {
      const running = receiver;
      receiver = null;
      settingsPath = null;
      agentSettingsPath = null;
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
