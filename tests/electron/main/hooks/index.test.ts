// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * A pass-through spy on `writeFile`, in the shape `theme/index.test.ts`
 * already uses for `readFile`: everything forwards to the real
 * implementation except what one test below deliberately makes fail. A real
 * temp directory is still used underneath — the point is never to fake the
 * filesystem, only to make one specific write in it throw.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const writeFileSpy = vi.mocked((await import('node:fs/promises')).writeFile);
const realWriteFile = writeFileSpy.getMockImplementation()!;

const noopHandlers: HookHandlers = {
  knowsSession: () => true,
  // The second id space (HIVE-115), closed: this suite is about the runtime's
  // lifecycle, and an agent has nothing to add to that.
  knowsAgent: () => false,
  // No peers either (HIVE-127) — same reason as `knowsAgent` above.
  onAgentsList: () => Promise.resolve({ agents: [] }),
  onEvent: () => {},
  onAgentEvent: () => {},
  onTicketIntent: () => {},
  onPromptName: () => {},
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

/**
 * The fix for fix-round-1's Important finding (HIVE-119): the two settings
 * writes in `start()` must fail together, not leave `settingsPathFor()`
 * answering a real, correctly-written file with no receiver behind it.
 *
 * Before this fix, `settingsPath` was assigned straight off the first
 * `await`, so a failure in the *second* write (the agent file) left it set
 * while `receiver` was never assigned — the exact split state the module's
 * own doc comment at the top of this file rules out ("start together, fail
 * together, and are switched off together").
 */
describe('createHookRuntime — settings write atomicity', () => {
  let dir: string;
  let ledger: Ledger;
  let runtime: HookRuntime | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-hooks-atomic-'));
    ledger = createLedger({ dir, knowsParty: () => true });
  });

  afterEach(async () => {
    // Every test in this block either restores the passthrough itself or
    // never touches the implementation — this is the belt-and-braces reset
    // so a failure mid-test can never leak a rejecting `writeFile` into a
    // test in a different describe block.
    writeFileSpy.mockImplementation(realWriteFile);
    await runtime?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never lets settingsPathFor answer a path with no receiver behind it', async () => {
    // The session file (claude-hooks.settings.json) still writes for real;
    // only the agent file, written second, rejects — the disk-error-between-
    // two-writes scenario the finding describes.
    writeFileSpy.mockImplementation(async (path, data, options) => {
      if (String(path).includes('claude-agent.settings.json')) {
        throw new Error('simulated disk error');
      }
      return realWriteFile(path, data, options);
    });

    runtime = createHookRuntime({ userDataPath: dir, sessionMetrics: () => false, ledger });
    await runtime.start(noopHandlers);

    // Both paths null — the pair failed together, exactly as it started
    // together. Neither is left pointing at a file nothing is listening
    // behind, which is what made the split state silent rather than visible.
    expect(runtime.settingsPathFor()).toBeNull();
    expect(runtime.agentSettingsPathFor()).toBeNull();
  });

  it('still succeeds normally once the write stops failing — the mock is not load-bearing', async () => {
    // A guard against the test above passing for the wrong reason (e.g. a
    // typo in the matched filename that makes every write reject).
    runtime = createHookRuntime({ userDataPath: dir, sessionMetrics: () => false, ledger });
    await runtime.start(noopHandlers);

    expect(runtime.settingsPathFor()).not.toBeNull();
    expect(runtime.agentSettingsPathFor()).not.toBeNull();
  });
});
