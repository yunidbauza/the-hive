// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLedger, type Ledger } from '../../../../electron/main/ledger';
import {
  createHookRuntime,
  type HookHandlers,
  type HookRuntime,
} from '../../../../electron/main/hooks';

/**
 * `createHookRuntime`'s own contract — `settingsPathFor`, `envFor`, `doneUrl`
 * and lifecycle — as distinct from `receiver.test.ts`, which drives the
 * socket underneath it, and from `sessions/index.test.ts`, which only ever
 * fakes this runtime (`envFor: () => ({})`) to test what main does with it.
 * Nothing in this repo previously exercised the real runtime directly.
 */

const noopHandlers: HookHandlers = {
  knowsSession: () => true,
  // The second id space (HIVE-115), closed: this suite is about the runtime's
  // lifecycle, and an agent has nothing to add to that.
  knowsAgent: () => false,
  onEvent: () => {},
  onAgentEvent: () => {},
  onTicketIntent: () => {},
  onCleared: () => {},
  onMetrics: () => {},
  onDone: () => {},
  onReady: () => {},
};

describe('createHookRuntime — envFor', () => {
  let dir: string;
  let ledger: Ledger;
  let runtime: HookRuntime | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-hooks-runtime-'));
    ledger = createLedger({ dir, knowsParty: () => true });
  });

  afterEach(async () => {
    await runtime?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is empty before start — merging nothing is correct', () => {
    runtime = createHookRuntime({ userDataPath: dir, sessionMetrics: () => false, ledger });

    expect(runtime.envFor('sess-a')).toEqual({});
  });

  it('carries the receiver URL for the MCP host (HIVE-112)', async () => {
    // The MCP host is started by `claude`, not by us, so it cannot be handed a
    // URL any other way.
    runtime = createHookRuntime({ userDataPath: dir, sessionMetrics: () => false, ledger });
    await runtime.start(noopHandlers);

    const env = runtime.envFor('sess-a');

    expect(env['HIVE_RECEIVER_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env['HIVE_SESSION_ID']).toBe('sess-a');
    expect(env['HIVE_HOOK_TOKEN']).toEqual(expect.any(String));

    await runtime.stop();
  });

  /**
   * The regression `envFor` itself is answerable for (HIVE-112): a shared
   * per-launch token would hand every session the same string here, which is
   * exactly what let one session's environment be replayed as another's.
   */
  it('hands two different sessions two different tokens', async () => {
    runtime = createHookRuntime({ userDataPath: dir, sessionMetrics: () => false, ledger });
    await runtime.start(noopHandlers);

    const a = runtime.envFor('sess-a')['HIVE_HOOK_TOKEN'];
    const b = runtime.envFor('sess-b')['HIVE_HOOK_TOKEN'];

    expect(a).not.toBe(b);
    // And deterministic for the same session, since there is no map behind it.
    expect(runtime.envFor('sess-a')['HIVE_HOOK_TOKEN']).toBe(a);

    await runtime.stop();
  });
});
