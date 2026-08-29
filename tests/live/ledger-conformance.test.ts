// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLedger } from '../../electron/main/ledger';
import { createReceiver } from '../../electron/main/hooks/receiver';
import { mcpConfig } from '../../electron/main/mcp/config';

/**
 * What only a real `claude` can prove (HIVE-112).
 *
 * Everything else in this story is asserted against a recording fake. This is
 * the one test that answers the questions a fake cannot: does the binary load
 * our config, does it find eight tools, does the identity we put in the
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
  let receiver: Awaited<ReturnType<typeof createReceiver>> | null = null;
  let origin: string | null = null;
  let configFile: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hive-live-ledger-'));
    ledgerDir = join(dir, 'ledger');

    const ledger = createLedger({
      dir: ledgerDir,
      // Only this session exists, and only it may write.
      knowsParty: (party: string) => party === SESSION,
    });

    receiver = createReceiver({
      onLedgerRead: (_caller, query) => ledger.read(query),
      onLedgerPost: (caller, request) => ledger.append({ ...request, from: caller }),
      knowsSession: (id: string) => id === SESSION,
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

  it('lists the eight tools under the short mcp__hive__ name', async () => {
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
});
