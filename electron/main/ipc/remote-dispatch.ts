import {
  frameKindOf,
  isClientFrameAllowed,
  remoteRefusedReason,
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
  | 'remote-refused'
  | 'not-ready';

export interface RemoteDispatch {
  /** Answer a `call`. Never rejects: a refusal is an `error` frame, not a throw. */
  call(frame: CallFrame, reporter: RemoteReporter): Promise<ResultFrame | ErrorFrame>;
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
 * The order of the checks is load-bearing. Existence comes from `frameKindOf`
 * first, because it is the cheap default-deny. `remote-refused` comes next —
 * before `isClientFrameAllowed`, which still folds the same channels into its
 * own answer, so that one is checked for the specific reason rather than
 * falling through to the generic one (HIVE-148 review; see `refuse()`'s own
 * comment). Direction then comes from `isClientFrameAllowed`, which HIVE-141
 * shipped and tested. `window-bound` comes last, and before the registry
 * lookup, so that a channel which *is* registered but cannot work over a
 * socket is refused with the reason rather than run.
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
    channel: unknown,
    payload: unknown,
  ): { code: DispatchRefusal; message: string } | null {
    /*
      `channel` is typed `string` on the frame and is not one on the wire
      (HIVE-143 review).

      Everything downstream that decides is `Object.hasOwn` — `frameKindOf`,
      `isClientFrameAllowed`, `remoteRefusedReason` and `windowBoundReason` all
      key a plain object — and `Object.hasOwn` coerces its key, so
      `["pty:spawn"]` stringifies to `"pty:spawn"` and clears every gate.
      `registry.call` is a `Map`, which
      does not coerce, so the lookup then misses and the frame was answered
      `not-ready`. Nothing unsafe ran; the answer was simply a lie. `not-ready`
      was given its own code to mean "the handlers are not registered yet" — a
      composition-order fault on *this* side — and a client told that about its
      own malformed frame will retry rather than fix it.

      Checked here, where the other shape checks live, so `call` and `notify`
      are covered by the one guard. The channel is not echoed back: it is
      attacker-controlled and of unknown type, and there is nothing useful to
      quote to a client that already knows what it sent.
    */
    if (typeof channel !== 'string') {
      return { code: 'unknown-channel', message: 'channel must be a string' };
    }
    if (frameKindOf(channel) === null) {
      return { code: 'unknown-channel', message: `no such channel: ${channel}` };
    }
    /*
      Checked before `isClientFrameAllowed`, not after (HIVE-148 review).

      `isClientFrameAllowed` still folds `REMOTE_REFUSED_CHANNELS` into its own
      answer — that is the property its own tests pin, "may a client frame
      ever reach this at all" — so a remote-refused channel would fall
      through to the generic check below and come back `wrong-frame-kind`
      with "skills:file:drop is not a call channel", which is false: it *is*
      a call channel, correctly directed, at the highest grade a device
      holds. That code means a malformed frame and tells a client to retry
      with a different shape, and no shape fixes a policy refusal. Checking
      the specific reason first is what gives it the true one.
    */
    const refused = remoteRefusedReason(channel, payload);
    if (refused !== null) return { code: 'remote-refused', message: refused };
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
    async call(frame, reporter) {
      const refusal = refuse('call', frame.channel, frame.payload);
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
        const payload: unknown = await handler(frame.payload, reporter);
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
      const refusal = refuse('notify', frame.channel, frame.payload);
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
