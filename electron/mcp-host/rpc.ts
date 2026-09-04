import { createInterface } from 'node:readline';

import { RPC_INTERNAL_ERROR, type JsonRpcRequest } from '@shared/mcp-contract';
import { handleMessage, rpcFailure, type RpcHandlers } from '@shared/mcp-protocol';

/**
 * The stdio MCP transport, and nothing else (HIVE-112, narrowed HIVE-130).
 *
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout. What a request *means* moved
 * to `@shared/mcp-protocol` when `POST /mcp` became a second transport for the
 * same messages (HIVE-130); what is left here is framing. The split is what
 * lets the protocol be tested with no stream in sight, and what keeps "we
 * framed a message wrong" and "we answered the wrong thing" from ever being the
 * same commit.
 *
 * ## The three rules that matter
 *
 * 1. **One message per line, no embedded newlines.** The spec frames on `\n`,
 *    so `JSON.stringify` without indentation is not a style choice.
 * 2. **A notification draws no reply.** `notifications/initialized` carries no
 *    `id`; answering it puts a response with `id: undefined` on the wire and
 *    the client is entitled to hang up.
 * 3. **stdout belongs to the protocol.** Diagnostics go to `log`, which the
 *    entry point points at stderr. A stray `console.log` here corrupts the
 *    stream in a way that looks like the server crashing.
 */

/**
 * Re-exported so the host's own modules keep one import site for the protocol.
 *
 * `handleMessage` is re-exported for the tests that drive this transport's
 * behaviour end to end; its own unit tests live beside the shared module.
 */
export { handleMessage, type RpcHandlers };

export interface ServeOptions {
  input: NodeJS.ReadableStream;
  /** Where a reply goes. The entry point points this at stdout. */
  write: (line: string) => void;
  /** Where diagnostics go. The entry point points this at stderr. */
  log: (message: string) => void;
  handlers: RpcHandlers;
}

/** Read messages off `input` until it ends, replying on `write`. */
export function serve({ input, write, log, handlers }: ServeOptions): void {
  const reader = createInterface({ input });

  reader.on('line', (line) => {
    const text = line.trim();
    if (text === '') return;

    let message: JsonRpcRequest;
    try {
      message = JSON.parse(text) as JsonRpcRequest;
    } catch {
      /*
        Skipped, not fatal. A half-written line is a transport hiccup; killing
        the server would take the session's tools down with it for the rest of
        its life, since `claude` starts the host once.
      */
      log(`unparseable message, skipped: ${text.slice(0, 200)}`);
      return;
    }

    void handleMessage(message, handlers)
      .then((reply) => {
        if (reply !== null) write(`${JSON.stringify(reply)}\n`);
      })
      .catch((cause: unknown) => {
        // A handler that threw is a bug in this app, not a client error. Report
        // it where a developer can see it and leave the stream intact.
        log(`handler threw: ${String(cause)}`);

        /*
          A client that sent an `id` is owed a reply — silence here means it
          waits on an answer that will never come, all the way out to its own
          timeout, instead of failing fast with a message a model could act
          on. A notification (`id` absent or `null`) drew no reply from
          `handleMessage` either, so there is nothing to send back for it.
        */
        const { id } = message;
        if (id !== undefined && id !== null) {
          write(
            `${JSON.stringify(rpcFailure(id, RPC_INTERNAL_ERROR, `handler threw: ${String(cause)}`))}\n`,
          );
        }
      });
  });
}
