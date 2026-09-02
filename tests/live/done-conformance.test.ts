// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
} from '../../electron/shared/hook-contract';

import { createReceiver, type Receiver } from '../../electron/main/hooks/receiver';
import { writeHookSettings } from '../../electron/main/hooks/settings';
import { writePluginDir } from '../../electron/main/skills/plugin';
import type { SkillsRead } from '../../electron/main/skills/read';

/** Not exercised by this suite — `/done`, not the ledger. */
const noLedger = {
  onLedgerRead: () => ({ entries: [], openAsks: [], claims: {} }),
  onLedgerPost: () => ({ ok: false as const, status: 503, reason: 'not exercised by this test' }),
};

/**
 * The agent half of the id space, closed (HIVE-115).
 *
 * `/done` is a session's declaration — it ends in an `/exit` written into a pty
 * — so this scenario knows no agents and the route stays session-only.
 */
const noAgents = {
  knowsAgent: () => false,
  onAgentEvent: () => {},
  // And no peer directory either (HIVE-127).
  onAgentsList: () => Promise.resolve({ agents: [] }),
};

/**
 * `/done`, end to end, against a real `claude` (HIVE-93).
 *
 * The one thing no unit test can establish. Everything about `/done` that could
 * be asserted in isolation already is — the receiver's route and its auth, the
 * finish state machine, the generated skill's text — and all of it was green
 * while the feature was, at various points, completely broken:
 *
 * - the `allowed-tools` value was unquoted, so the frontmatter did not parse and
 *   the skill did not exist;
 * - before that the grant lived in a settings file, where a near-miss on the
 *   rule meant a permission prompt instead of a request.
 *
 * Both failures look identical from inside the app — `/done` simply does
 * nothing — and both are invisible to a test that reads the generated text
 * rather than handing it to the binary that has to accept it.
 *
 * ## What `-p` proves that an interactive run would not
 *
 * Print mode has **no one to ask**. A `Bash` call the settings do not authorise
 * is denied outright rather than raising a prompt, so the request either arrives
 * or it does not. That makes this the sharpest available test of the
 * authorisation: if `allowed-tools` in a generated skill's frontmatter did not
 * actually grant the command, `onDone` would never fire.
 *
 * ## Why it is opt-in
 *
 * It spawns a real `claude`, which costs real tokens and takes tens of seconds.
 * That is a different risk profile from the rest of the suite, which is exactly
 * the line `tests/live/` exists to draw. Run it with:
 *
 * ```
 * pnpm test:done
 * ```
 */
const enabled = process.env.HIVE_LIVE_DONE_PROOF === '1';

/** The Hive id this run's session answers to, echoed back in the POST's header. */
const ENTITY = 'sess-live-done';

/** No custom skills — the built-in `/done` is what is under test. */
const NO_SKILLS: SkillsRead = { skills: [], invalid: [] };

const claude = (
  cwd: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      'claude',
      [...args, '--model', 'haiku', '-p'],
      {
        cwd,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, ...env },
      },
      (_error, stdout, stderr) => resolve({ stdout, stderr }),
    );
  });

describe.skipIf(!enabled)('/done conformance', () => {
  let receiver: Receiver;
  let cwd: string;
  let pluginRoot: string;
  let settingsPath: string;
  let declared: string[];

  beforeAll(async () => {
    declared = [];
    receiver = createReceiver({
      onEvent: () => {},
      onTicketIntent: () => {},
      onPromptName: () => {},
      onCleared: () => {},
      onMetrics: () => {},
      onDone: (entityId) => declared.push(entityId),
      onReady: () => {},
      knowsSession: (entityId) => entityId === ENTITY,
      ...noLedger,
      ...noAgents,
    });

    const url = await receiver.start();
    expect(url).not.toBeNull();

    cwd = mkdtempSync(join(tmpdir(), 'hive-done-cwd-'));
    const userData = mkdtempSync(join(tmpdir(), 'hive-done-data-'));
    pluginRoot = join(mkdtempSync(join(tmpdir(), 'hive-done-plugin-')), 'plugin');

    /*
      Generated exactly as a real launch generates them, from the receiver that
      is actually listening — a hand-written skill or a hand-written settings
      file would test this file's idea of the app rather than the app.
    */
    await writePluginDir(pluginRoot, '0.0.0-test', NO_SKILLS, receiver.doneUrl);
    settingsPath = await writeHookSettings(userData, url as string);
  });

  afterAll(async () => {
    await receiver.stop();
  });

  it(
    'reaches the receiver when a real claude runs it',
    { timeout: 300_000 },
    async () => {
      const { stdout, stderr } = await claude(
        cwd,
        ['--plugin-dir', pluginRoot, '--settings', settingsPath, '/done'],
        {
          [HOOK_ENV_SESSION]: ENTITY,
          [HOOK_ENV_TOKEN]: receiver.tokenFor(ENTITY),
        },
      );

      /*
        The whole chain in one assertion: the frontmatter parsed, `/done`
        resolved by its bare name, `allowed-tools` authorised the command
        without anyone to ask, the command ran, and the route accepted it with
        the session id from the environment.
      */
      expect(
        declared,
        `claude printed:\n${stdout}\n---\n${stderr}`,
      ).toEqual([ENTITY]);
    },
  );

  it(
    'is refused when the session is not one the app has',
    { timeout: 300_000 },
    async () => {
      /*
        The same command with a session id the receiver does not know. Proves
        the header is really read and really checked, rather than the route
        answering 204 to anything that reaches it — which would make `/done` a
        way for any process on the machine to close a terminal.
      */
      declared.length = 0;

      await claude(
        cwd,
        ['--plugin-dir', pluginRoot, '--settings', settingsPath, '/done'],
        {
          [HOOK_ENV_SESSION]: 'sess-not-ours',
          [HOOK_ENV_TOKEN]: receiver.tokenFor('sess-not-ours'),
        },
      );

      expect(declared).toEqual([]);
    },
  );
});
