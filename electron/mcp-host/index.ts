import { createHandlers } from './host';
import { serve } from './rpc';

/**
 * The entry point `claude` actually spawns (HIVE-112).
 *
 * Everything worth testing lives in `./host` and `./rpc`, both importable with
 * no side effects. This file's only job is to wire stdio to them, so it stays
 * a handful of lines with nothing to unit-test on its own.
 *
 * `process.stderr` for logs, never `process.stdout`: stdout is the protocol
 * channel and one stray line on it desynchronises the client for good.
 */
serve({
  input: process.stdin,
  write: (line) => process.stdout.write(line),
  log: (message) => process.stderr.write(`[hive-mcp] ${message}\n`),
  handlers: createHandlers(process.env, globalThis.fetch),
});
