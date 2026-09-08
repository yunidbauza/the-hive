import {
  frameKindOf,
  isClientFrameAllowed,
  windowBoundReason,
  type Authorization,
  type CallFrame,
  type ErrorFrame,
  type NotifyFrame,
  type ResultFrame,
} from '@shared/remote-contract';

import type { IpcRegistry, RemoteReporter } from './registry';

/**
 * What an attached device is trusted with (HIVE-143).
 *
 * `execute`, which is everything — and that is the Epic's model rather than an
 * omission here. `CHANNEL_AUTHORIZATION`'s own preamble states the premise:
 * server mode carries `pty:spawn`, `fs:write-file` and `agents:run`, so anyone
 * who completes the handshake can run arbitrary code as the user on the server,
 * and this is a remote execution endpoint rather than an app with a login.
 * Pairing is the gate. The grades exist so that narrowing this per device is a
 * small diff if a story ever wants one, not because one is missing.
 *
 * Named rather than written as a literal at the call site, so a reader who
 * wants to know what a paired device may do finds this comment instead of
 * reverse-engineering an `'execute'` two lines into a boolean expression.
 */
const DEVICE_GRANT: Authorization = 'execute';

/** Why a frame was refused before any handler ran. */
export type DispatchRefusal =
  | 'unknown-channel'
  | 'wrong-frame-kind'
  | 'window-bound'
  | 'not-ready';

export interface RemoteDispatch {
  /** Answer a `call`. Never rejects: a refusal is an `error` frame, not a throw. */
  call(frame: CallFrame): Promise<ResultFrame | ErrorFrame>;
  /** Run a `notify`. No reply, so a refusal is logged and dropped. */
  notify(frame: NotifyFrame, reporter: RemoteReporter): void;
}

/**
 * Where a socket's frames meet the handlers a renderer would have reached
 * (HIVE-143).
 *
 * All the remote-only policy lives here and only here. `./registry.ts` stores
 * and decides nothing; `ipc/router.ts` is explicit that the local path must
 * keep exactly one gate, so nothing below is reachable from a window.
 *
 * The order of the checks is load-bearing. Direction and existence come from
 * `isClientFrameAllowed`, which HIVE-141 shipped and tested, and they come
 * first because they are the cheap default-deny. `window-bound` comes next, and
 * before the registry lookup, so that a channel which *is* registered but
 * cannot work over a socket is refused with the reason rather than run.
 */
export function createRemoteDispatch(registry: IpcRegistry): RemoteDispatch {
  /**
   * The two shared refusals, in one place.
   *
   * Returns `null` when the frame may proceed. Split out because `call` and
   * `notify` refuse identically and diverge only in what they do about it —
   * one answers, the other logs.
   */
  function refuse(
    kind: 'call' | 'notify',
    channel: string,
  ): { code: DispatchRefusal; message: string } | null {
    if (frameKindOf(channel) === null) {
      return { code: 'unknown-channel', message: `no such channel: ${channel}` };
    }
    if (!isClientFrameAllowed(kind, channel, DEVICE_GRANT)) {
      return {
        code: 'wrong-frame-kind',
        message: `${channel} is not a ${kind} channel`,
      };
    }
    const bound = windowBoundReason(channel);
    if (bound !== null) return { code: 'window-bound', message: bound };
    return null;
  }

  return {
    async call(frame) {
      const refusal = refuse('call', frame.channel);
      if (refusal) return { kind: 'error', id: frame.id, ...refusal };

      const handler = registry.call(frame.channel);
      if (handler === null) {
        /*
          A real channel, allowed, and nothing behind it. That is not a client
          error — it means `registerIpcHandlers` has not run, or ran and was
          reset, while a socket was already attached. Given its own code rather
          than folded into `unknown-channel` because the two want opposite
          responses: one is a client bug, this is a composition-order bug on
          this side, and a client that cannot tell them apart will retry the
          wrong one.
        */
        return {
          kind: 'error',
          id: frame.id,
          code: 'not-ready',
          message: `no handler registered for ${frame.channel}`,
        };
      }

      try {
        // `await` on a non-promise is a no-op, so this covers both the 85
        // synchronous handlers and the asynchronous ones without branching.
        const payload: unknown = await handler(frame.payload);
        return { kind: 'result', id: frame.id, payload };
      } catch (cause) {
        /*
          The code is the error's own name, which is what makes this path
          better than the local one it mirrors. Electron rewraps a thrown
          handler error into a fresh `Error` whose message embeds the class
          name, and `src/lib/theme/files.ts` regex-strips it back off. Here the
          name crosses intact and the message is left for the human.
        */
        const error = cause instanceof Error ? cause : new Error(String(cause));
        return {
          kind: 'error',
          id: frame.id,
          code: error.name,
          message: error.message,
        };
      }
    },

    notify(frame, reporter) {
      const refusal = refuse('notify', frame.channel);
      if (refusal) {
        console.error(`[hive] refused remote ${frame.channel}: ${refusal.code}`);
        return;
      }
      const handler = registry.notify(frame.channel);
      if (handler === null) {
        console.error(`[hive] no handler registered for ${frame.channel}`);
        return;
      }
      try {
        handler(frame.payload, reporter);
      } catch (cause) {
        // Mirrors `on()` in `./index.ts`: a `send` channel has no reply, so a
        // throw would be an unhandled rejection rather than an error anybody
        // sees. Rejected input is logged and dropped, never acted on.
        console.error(`[hive] rejected remote ${frame.channel}:`, cause);
      }
    },
  };
}
