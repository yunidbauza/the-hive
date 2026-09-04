// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createReceiver } from '../../electron/main/hooks/receiver';
import { createLedger } from '../../electron/main/ledger';
import {
  HOOK_ENV_RECEIVER_URL,
  HOOK_ENV_RUN,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_HEADER_RUN,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
} from '../../electron/shared/hook-contract';
import { MCP_PATH, MCP_SERVER_NAME } from '../../electron/shared/mcp-contract';

/**
 * What only a real `claude` can prove about `POST /mcp` (HIVE-130).
 *
 * The route's own behaviour — envelope, auth, 202, 405, 403 — is asserted
 * against the server directly in `tests/electron/main/hooks/receiver.test.ts`.
 * Three things are left that no fake can answer, and all three are load-bearing
 * for the epic:
 *
 * 1. **Does `claude` accept a single JSON reply to its POST**, or does it insist
 *    on an SSE stream? The spec permits either and obliges the client to
 *    support both; this suite is what turns "permitted" into "observed".
 * 2. **Do the tools keep the `mcp__hive__*` name** when the same server arrives
 *    over HTTP instead of stdio? `electron/main/mcp/paths.ts` records that the
 *    name follows the *delivery*, and the agent preamble and the permission
 *    tool both depend on it.
 * 3. **Does `${VAR}` expansion actually work in `url` and `headers`?** The
 *    container config HIVE-132 emits is secret-free precisely because it does.
 *    The config written below is that exact shape, so this suite fails on the
 *    day that stops being true rather than at the end of HIVE-133.
 *
 * The receiver still binds loopback here — making the bind configurable is
 * HIVE-131 — so `claude` runs on this machine and reaches `127.0.0.1`. That is
 * enough: what is under test is the transport and the config shape, and neither
 * changes when the address does.
 *
 * Gated behind `HIVE_LIVE_MCP_HTTP_PROOF=1` (`pnpm test:mcp-http`) because it
 * spends real tokens and needs `claude` on PATH.
 */

const RUN = process.env['HIVE_LIVE_MCP_HTTP_PROOF'] === '1';

describe.skipIf(!RUN)('the hive MCP endpoint over HTTP, against a real claude', () => {
  const SESSION = 'sess-live-mcp-http';
  let dir: string;
  let ledgerDir: string;
  let ledger: ReturnType<typeof createLedger>;
  let receiver: ReturnType<typeof createReceiver> | null = null;
  let origin: string | null = null;
  let configFile: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hive-live-mcp-http-'));
    ledgerDir = join(dir, 'ledger');

    ledger = createLedger({
      dir: ledgerDir,
      knowsParty: (party: string) => party === SESSION,
    });

    receiver = createReceiver({
      onLedgerRead: (_caller, query) => ledger.read(query),
      onLedgerPost: (caller, request) => ledger.append({ ...request, from: caller }),
      // This scenario speaks as a session, which has no peers to list.
      onAgentsList: () => Promise.resolve({ agents: [] }),
      knowsSession: (id: string) => id === SESSION,
      knowsAgent: () => false,
      onAgentEvent: () => undefined,
      // Not exercised by this test: every other route the receiver serves.
      onEvent: () => undefined,
      onTicketIntent: () => undefined,
      onPromptName: () => {},
      onCleared: () => undefined,
      onMetrics: () => undefined,
      onDone: () => undefined,
      onReady: () => undefined,
    });

    await receiver.start();
    origin = receiver.origin;
    expect(origin).not.toBeNull();

    /*
      Written by hand rather than through a builder, and deliberately: the
      emitter that produces this for a container is HIVE-132's, and a test that
      called it would pass by agreeing with itself. Spelling the shape out here
      means HIVE-132 has a fixture to match rather than a function to trust.

      Note what is *not* in this file: no token, no session id, no port. Every
      one of them is a `${VAR}` the CLI resolves from the environment at launch,
      which is the whole reason the container flavour can be mounted read-only.
    */
    configFile = join(dir, 'hive.mcp.json');
    await writeFile(
      configFile,
      `${JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_NAME]: {
              type: 'http',
              url: `\${${HOOK_ENV_RECEIVER_URL}}${MCP_PATH}`,
              headers: {
                [HOOK_HEADER_SESSION]: `\${${HOOK_ENV_SESSION}}`,
                [HOOK_HEADER_TOKEN]: `\${${HOOK_ENV_TOKEN}}`,
                /*
                  Present with a default, and that is the whole trick. A pty
                  session has no run, and `${VAR}` with no value left would be
                  sent as the literal text `${HIVE_RUN_ID}`; `:-` collapses that
                  to empty, which the route treats as absent. Without this line
                  an agent run in a container would lose `meta.run` and its asks
                  would be indistinguishable from a concurrent neighbour's —
                  and HIVE-132's emitter is built to match this fixture.
                */
                [HOOK_HEADER_RUN]: `\${${HOOK_ENV_RUN}:-}`,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }, 60_000);

  afterAll(async () => {
    await receiver?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const runClaude = (prompt: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        'claude',
        [
          '-p',
          '--mcp-config',
          configFile,
          '--strict-mcp-config',
          // Pinned, or a permission prompt strands the turn with no tty to
          // answer it — the same fence `ledger-conformance` documents.
          '--allowedTools',
          'mcp__hive__*',
          // And `Bash` removed outright, so the model cannot decide to reach a
          // tool by shelling out to `claude mcp call` and strand on a prompt
          // nothing here can answer.
          '--disallowedTools',
          'Bash',
          '--model',
          'haiku',
          prompt,
        ],
        {
          env: {
            ...process.env,
            /*
              The three the config's `${VAR}`s resolve from. This is the same
              environment `envFor` builds for a pty session — which is the
              point: a container gets these through `docker exec -e`, and
              nothing else about the config changes.
            */
            [HOOK_ENV_SESSION]: SESSION,
            [HOOK_ENV_TOKEN]: receiver?.tokenFor(SESSION) ?? '',
            [HOOK_ENV_RECEIVER_URL]: origin ?? '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      /*
        Drained, not merely piped. A `pipe` with no reader fills its ~64 KiB
        buffer and then blocks the child forever: `close` never fires and the
        test hangs to its timeout with nothing saying why.
      */
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        /*
          A non-zero exit is reported as itself. Resolving regardless would hand
          the assertions an empty string, and a missing `claude` would surface
          as "expected output to contain mcp__hive__ledger_read" — pointing the
          reader at the transport instead of at the spawn.
        */
        if (code !== 0) {
          reject(new Error(`claude exited ${String(code)}: ${err.slice(0, 2000)}`));
          return;
        }
        resolve(out);
      });
    });

  it('serves the tools under the same mcp__hive__ name stdio delivery gives them', async () => {
    const out = await runClaude(
      'Do not call any tool. List the exact fully-qualified names of every MCP tool you can see, one per line.',
    );

    for (const name of [
      'ledger_read',
      'ledger_post',
      'ledger_ask',
      'ledger_answer',
      'ledger_claim',
      'ledger_release',
      'ledger_done',
      'ledger_failed',
      'ledger_handoff',
      'agents',
    ]) {
      expect(out).toContain(`mcp__hive__${name}`);
    }
  }, 180_000);

  /**
   * The end-to-end claim: a tool call arriving over HTTP lands on the same
   * handler the stdio host reaches, so `from` is the authenticated header.
   *
   * Read back in-process rather than off disk. The files are the ledger's own
   * business and `ledger-conformance` already proves they get written; what
   * this suite owes is that the *transport* carried an identity, and
   * `ledger.read` is the shortest honest way to see it.
   */
  it('writes a line whose from is the session that authenticated the request', async () => {
    await runClaude(
      'Call ledger_post once with the body "http conformance ok", then reply DONE.',
    );

    const snapshot = ledger.read({});
    const mine = snapshot.entries.filter((entry) => entry.from === SESSION);

    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((entry) => entry.body.includes('http conformance ok'))).toBe(true);
  }, 180_000);
});
