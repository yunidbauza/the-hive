// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLedger } from '../../electron/main/ledger';
import { createReceiver } from '../../electron/main/hooks/receiver';
import { mcpConfig } from '../../electron/main/mcp/config';
import { OVERMIND } from '../../electron/shared/ledger-contract';
import { openAsks } from '../../electron/shared/ledger-derive';

/**
 * What only a real `claude` can prove (HIVE-112).
 *
 * Everything else in this story is asserted against a recording fake. This is
 * the one test that answers the questions a fake cannot: does the binary load
 * our config, does it find nine tools, does the identity we put in the
 * environment come back as the `from` on a line on disk.
 *
 * Gated behind `HIVE_LIVE_LEDGER_PROOF=1` (`pnpm test:ledger`) because it
 * spends real tokens and needs `claude` on PATH.
 */

const RUN = process.env['HIVE_LIVE_LEDGER_PROOF'] === '1';

describe.skipIf(!RUN)('the hive MCP server, against a real claude', () => {
  const SESSION = 'sess-live-ledger';
  let dir: string;
  let ledgerDir: string;
  /*
    Hoisted so a test can both seed the log and read its derived state back
    (HIVE-113). Reading the files off disk, as the write test does, proves the
    line landed; only `openAsks` proves the *ask closed*.
  */
  let ledger: ReturnType<typeof createLedger>;
  let receiver: Awaited<ReturnType<typeof createReceiver>> | null = null;
  let origin: string | null = null;
  let configFile: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hive-live-ledger-'));
    ledgerDir = join(dir, 'ledger');

    ledger = createLedger({
      dir: ledgerDir,
      /*
        The session, and the overmind — which HIVE-113 needs so a test can
        stage the real shape of the exchange: the coordinator asks, the session
        answers. Widening this grants the *model* nothing, because `from` on
        the receiver path is always taken from the `x-hive-session` header.
      */
      knowsParty: (party: string) => party === SESSION || party === OVERMIND,
    });

    receiver = createReceiver({
      onLedgerRead: (_caller, query) => ledger.read(query),
      onLedgerPost: (caller, request) => ledger.append({ ...request, from: caller }),
      knowsSession: (id: string) => id === SESSION,
      // The agent id space, closed here (HIVE-115): this scenario speaks as a
      // session, so nothing should be answered on the other register.
      knowsAgent: () => false,
      onAgentEvent: () => undefined,
      // Not exercised by this test: every other route the receiver serves.
      onEvent: () => undefined,
      onTicketIntent: () => undefined,
      onCleared: () => undefined,
      onMetrics: () => undefined,
      onDone: () => undefined,
      onReady: () => undefined,
    });

    await receiver.start();
    // `origin` is the scheme+authority the MCP host builds its own request
    // paths onto (`@shared/ledger-contract`'s `LEDGER_POST_PATH` /
    // `LEDGER_READ_PATH`); `receiver.url` is `origin + '/hook'` and would
    // make every ledger call 404 (HIVE-112, discovered in Task 8).
    origin = receiver.origin;
    expect(origin).not.toBeNull();

    configFile = join(dir, 'hive.mcp.json');
    await writeFile(
      configFile,
      mcpConfig({
        execPath: process.execPath,
        scriptPath: join(process.cwd(), 'out', 'main', 'mcp-host.js'),
      }),
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
          // answer it. The wildcard is verified to match.
          '--allowedTools',
          'mcp__hive__*',
          '--model',
          'haiku',
          prompt,
        ],
        {
          env: {
            ...process.env,
            HIVE_SESSION_ID: SESSION,
            HIVE_HOOK_TOKEN: receiver?.tokenFor(SESSION) ?? '',
            HIVE_RECEIVER_URL: origin ?? '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('error', reject);
      child.on('close', () => resolve(out));
    });

  it('lists the nine tools under the short mcp__hive__ name', async () => {
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
      // HIVE-122. The tool the rotation is built on: if a real `claude` cannot
      // see it, no agent can ever hand over and every rotation takes a strike.
      'ledger_handoff',
    ]) {
      expect(out).toContain(`mcp__hive__${name}`);
    }
    // The plugin-delivered form would be mcp__plugin_hive_hive__*, which is the
    // name HIVE-115 and HIVE-119 do not use.
    expect(out).not.toContain('mcp__plugin_hive_hive__');
  }, 180_000);

  it('writes a line whose from is the session id, and reads it back', async () => {
    await runClaude(
      'Call ledger_post once with the body "live conformance ok", then reply DONE.',
    );

    const files = await readdir(ledgerDir);
    expect(files.length).toBeGreaterThan(0);

    /*
      The ledger rotates by day (HIVE-111), so a run that straddles midnight
      leaves two files and the entry this test just posted can be in either.
      `files[0]` assumed the first one readdir returns is the right one, which
      is true right up until it is yesterday's file — and then this fails for a
      reason nobody chasing a red run would think to check. Read every file and
      search all of them.
    */
    const entries = (
      await Promise.all(
        files.map(async (file) => {
          const lines = (await readFile(join(ledgerDir, file), 'utf8'))
            .split('\n')
            .filter((line) => line !== '');
          return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        }),
      )
    ).flat();
    const posted = entries.find((entry) => String(entry['body']).includes('live conformance ok'));

    expect(posted).toBeDefined();
    // Identity came from the environment, not from anything the model typed.
    expect(posted?.['from']).toBe(SESSION);
    expect(posted?.['kind']).toBe('post');

    const readBack = await runClaude(
      'Call ledger_read with no arguments and reply with the raw JSON it returns.',
    );
    expect(readBack).toContain('live conformance ok');
  }, 240_000);

  it('returns the receiver reason when answering a thread that is not open', async () => {
    const out = await runClaude(
      'Call ledger_answer with thread "does-not-exist" and body "hi", then reply with the exact error text you received.',
    );

    expect(out).toMatch(/no such thread/i);
  }, 180_000);

  /**
   * HIVE-113's second acceptance criterion, and the half that could not be
   * written until the MCP tools existed.
   *
   * The console side is proven against a mocked bridge and `deliver.ts` against
   * a recording `write`; what neither can answer is whether a **real model**,
   * handed the ref a nudge would carry, calls `ledger_answer` in a way that
   * actually retires the ask. `openAsks` is the assertion that matters — a
   * `ledger --open` that still listed an answered question is the failure this
   * whole exchange exists to prevent.
   */
  it('a session answering by ref closes the overmind’s ask', async () => {
    const asked = ledger.append({
      from: OVERMIND,
      to: SESSION,
      kind: 'ask',
      body: 'which branch should the demo use?',
    });
    expect(asked.ok).toBe(true);

    const ref = asked.ok ? asked.ref : undefined;
    const id = asked.ok ? asked.id : '';
    // Refs are what a person — and a nudge line — can actually carry.
    expect(ref).toBeDefined();

    expect(openAsks(ledger.read({}).entries, Date.now())).toHaveLength(1);

    await runClaude(
      `Call ledger_answer with thread "${ref ?? ''}" and body "main", then reply DONE.`,
    );

    const entries = ledger.read({}).entries;

    // The ask is retired: `ledger --open` would no longer list it.
    expect(openAsks(entries, Date.now())).toHaveLength(0);

    /*
      And the answer stored the **canonical id**, not the ref it was given.
      That is what keeps `thread()` a plain `id === x || thread === x` filter
      for every future reader, long after the ref has been reused.
    */
    const answer = entries.find((entry) => entry.kind === 'answer');
    expect(answer?.from).toBe(SESSION);
    expect(answer?.thread).toBe(id);
  }, 240_000);
});
