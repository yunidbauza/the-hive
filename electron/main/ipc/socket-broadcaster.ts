import { isLocalOnlyEvent, type ServerFrame } from '@shared/remote-contract';

import type { Broadcaster } from './broadcaster';

/** One attached client, from the fan-out's point of view. */
export interface AttachedSocket {
  /** Deliver a frame. May throw; the broadcaster catches per socket. */
  send(frame: ServerFrame): void;
}

/**
 * The second `Broadcaster` (HIVE-143), writing to attached sockets.
 *
 * The interface promised one implementation could be swapped for another
 * "without any of the handler bodies learning a socket exists", and this is
 * that claim being cashed: nothing below knows what an event means, only that
 * it has a channel and a payload.
 *
 * **The set is resolved per emit, not captured**, for the reason
 * `createWindowBroadcaster` resolves windows per send: a client attaches long
 * after `registerIpcHandlers` has run, and a captured empty array would deliver
 * to nobody forever.
 *
 * What crosses is every channel the contract grades `event`, not just the
 * subset in `EVENT_CHANNELS`, minus `LOCAL_ONLY_EVENTS`. That subtraction is
 * the only filter here and it is not a second taxonomy — it is a table in the
 * contract beside `FRAME_KIND`, read rather than restated, for a question
 * `FRAME_KIND` does not answer: not "is this a push" but "is this push about
 * the machine sending it".
 */
export function createSocketBroadcaster(
  sockets: () => Iterable<AttachedSocket>,
): Broadcaster {
  return {
    emit(channel, payload) {
      /*
        The one filter, and it is not a taxonomy (HIVE-150).

        `LOCAL_ONLY_EVENTS` is a push this process raises **about itself**, and
        a served machine that is also attached somewhere raises
        `remote:link-status` about its own outward socket. Sent, every client
        would paint its header chip from a link it has no part in — going amber
        for a reconnect happening on someone else's machine.

        This is the sending half; `remote-proxy.ts` refuses the same channel
        arriving. Either alone would close the realistic case, and each closes
        a different one: this stops a correct server leaking, that stops a
        wrong one being believed.
      */
      if (isLocalOnlyEvent(channel)) return;
      /*
        `payload` is passed straight through, `undefined` included. That is not
        a hole: `agents:changed` genuinely carries nothing, and `JSON.stringify`
        drops an `undefined` value's key entirely — so the frame on the wire has
        no `payload` at all, which is the absent-versus-empty distinction
        `AttachRequest.resumeFrom` already documents. Substituting `null` here
        would invent a value the local push never had.
      */
      const frame = { kind: 'event', channel, payload } as ServerFrame;
      for (const socket of sockets()) {
        try {
          socket.send(frame);
        } catch (cause) {
          // Per socket, for the reason `createWindowBroadcaster` catches per
          // window: one dead surface must never cost the others their event.
          console.error(`[hive] remote broadcast failed on ${channel}:`, cause);
        }
      }
    },
  };
}

/**
 * Both surfaces at once.
 *
 * Server mode is composed with this rather than the socket broadcaster alone,
 * so a served machine that *does* have a window — a dev run, or a mini someone
 * has screen-shared into — keeps delivering locally. In local mode the socket
 * half iterates an empty set, which costs nothing and keeps one composition
 * shape instead of two.
 */
export function createFanOutBroadcaster(
  targets: readonly Broadcaster[],
): Broadcaster {
  return {
    emit(channel, payload) {
      for (const target of targets) {
        try {
          target.emit(channel, payload);
        } catch (cause) {
          console.error(`[hive] broadcast target failed on ${channel}:`, cause);
        }
      }
    },
  };
}
