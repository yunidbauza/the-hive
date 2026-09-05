// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedContainer } from '../../../../electron/shared/config-contract';
import { HOOK_ENV_TOKEN } from '../../../../electron/shared/hook-contract';

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

/**
 * The same pass-through shape, over the sweep and the container-set write
 * (HIVE-133): everything forwards to the real implementation by default, so
 * the tests already below that read the container-flavoured set off disk
 * keep working unchanged. Only the ordering test overrides the sweep's
 * implementation, and only for the one call it needs to observe.
 */
vi.mock('../../../../electron/main/container/generated', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../electron/main/container/generated')
  >();
  return {
    ...actual,
    sweepSessionContainerFiles: vi.fn(actual.sweepSessionContainerFiles),
    writeSharedContainerFiles: vi.fn(actual.writeSharedContainerFiles),
    writeSessionContainerFiles: vi.fn(actual.writeSessionContainerFiles),
    writeAliasContainerFiles: vi.fn(actual.writeAliasContainerFiles),
  };
});

const sweepSpy = vi.mocked(
  (await import('../../../../electron/main/container/generated')).sweepSessionContainerFiles,
);
const writeSessionSpy = vi.mocked(
  (await import('../../../../electron/main/container/generated')).writeSessionContainerFiles,
);
const writeAliasSpy = vi.mocked(
  (await import('../../../../electron/main/container/generated')).writeAliasContainerFiles,
);
const realSweep = sweepSpy.getMockImplementation()!;

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

describe('createHookRuntime — the container-flavoured set (HIVE-132)', () => {
  let dir: string;
  let ledger: Ledger;
  let runtime: HookRuntime | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-hooks-container-'));
    ledger = createLedger({ dir, knowsParty: () => true });
  });

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async (): Promise<HookRuntime> => {
    runtime = createHookRuntime({
      userDataPath: dir,
      sessionMetrics: () => true,
      hostAlias: () => 'host.docker.internal',
      ledger,
    });
    await runtime.start(noopHandlers);

    return runtime;
  };

  it('writes the container set beside the host one when the receiver binds', async () => {
    await start();

    const written = await readdir(join(dir, 'hive', 'container'));

    expect(written).toContain('hive.mcp.json');
    expect(written).toContain('claude-hooks.settings.json');
  });

  it('addresses the alias in the container set, loopback in the host one', async () => {
    await start();

    const container = await readFile(
      join(dir, 'hive', 'container', 'claude-hooks.settings.json'),
      'utf8',
    );
    const host = await readFile(
      join(dir, 'hive', 'claude-hooks.settings.json'),
      'utf8',
    );

    expect(container).toContain('host.docker.internal');
    expect(host).toContain('127.0.0.1');
    expect(host).not.toContain('host.docker.internal');
  });

  it('reports the origin a container must use, not loopback', async () => {
    const started = await start();

    expect(started.containerOrigin()).toMatch(
      /^http:\/\/host\.docker\.internal:\d+$/,
    );
  });

  it('reports null before the receiver has bound', () => {
    runtime = createHookRuntime({
      userDataPath: dir,
      sessionMetrics: () => false,
      hostAlias: () => 'host.docker.internal',
      ledger,
    });

    expect(runtime.containerOrigin()).toBeNull();
  });

  it('leaves a host session environment untouched', async () => {
    const started = await start();

    expect(started.envFor('sess-a')['HIVE_RECEIVER_URL']).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/,
    );
  });
});

describe('createHookRuntime — sweep ordering (HIVE-133)', () => {
  let dir: string;
  let ledger: Ledger;
  let runtime: HookRuntime | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-hooks-sweep-'));
    ledger = createLedger({ dir, knowsParty: () => true });
  });

  afterEach(async () => {
    sweepSpy.mockImplementation(realSweep);
    await runtime?.stop();
    runtime = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('sweeps orphan container directories before a session can be spawned', async () => {
    // `containerOrigin()` is gated on `receiver` alone, and that gate is what
    // makes a containerised spawn viable — so whatever `containerOrigin()`
    // answers *while the sweep itself is running* is the actual invariant.
    // If the sweep runs after `receiver` is assigned, this observes a real
    // origin mid-sweep, which is the 33-line window the finding describes.
    let originDuringSweep: string | null | undefined;

    sweepSpy.mockImplementation(async (...args) => {
      originDuringSweep = runtime?.containerOrigin();
      return realSweep(...args);
    });

    runtime = createHookRuntime({ userDataPath: dir, sessionMetrics: () => false, ledger });
    await runtime.start(noopHandlers);

    expect(sweepSpy).toHaveBeenCalled();
    expect(originDuringSweep).toBeNull();
  });

  it('still keeps nothing, because no session can exist yet', async () => {
    runtime = createHookRuntime({ userDataPath: dir, sessionMetrics: () => false, ledger });
    await runtime.start(noopHandlers);

    expect(sweepSpy).toHaveBeenCalledWith(dir, []);
  });
});

describe('createHookRuntime — writeContainerSession (HIVE-133)', () => {
  let dir: string;
  let ledger: Ledger;
  let runtime: HookRuntime | undefined;

  /** Every field {@link ResolvedContainer} has, overridden per test. */
  const container: ResolvedContainer = {
    workspace: '/workspace',
    hiveDir: '/hive',
    envArg: '-e {name}={value}',
    freshness: 'exec-env',
    hostAlias: 'host.docker.internal',
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-hooks-write-session-'));
    ledger = createLedger({ dir, knowsParty: () => true });
    writeSessionSpy.mockClear();
    writeAliasSpy.mockClear();
  });

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers null before the receiver has bound', async () => {
    // No `start()` — `containerFor` says `rewrite`, but there is no socket to
    // address yet, and `writeContainerSession` must not write a set for a
    // receiver whose URLs it cannot yet know.
    runtime = createHookRuntime({
      userDataPath: dir,
      sessionMetrics: () => false,
      ledger,
      containerFor: () => ({ ...container, freshness: 'rewrite' }),
    });

    await expect(runtime.writeContainerSession('hero-refresh', 'p')).resolves.toBe(null);
    expect(writeSessionSpy).not.toHaveBeenCalled();
  });

  it('answers null for a host project — containerFor found nothing', async () => {
    runtime = createHookRuntime({
      userDataPath: dir,
      sessionMetrics: () => false,
      ledger,
      containerFor: () => undefined,
    });
    await runtime.start(noopHandlers);

    await expect(runtime.writeContainerSession('hero-refresh', 'p')).resolves.toBe(null);
    expect(writeSessionSpy).not.toHaveBeenCalled();
  });

  it('writes nothing for an exec-env project on the default alias', async () => {
    // `container.hostAlias` here equals `hostAlias()`'s own default
    // (`DEFAULT_RECEIVER.hostAlias`, since no override is passed) — the
    // shared set `writeSharedContainerFiles` wrote at `start()` already
    // addresses this alias, so there is nothing this session needs of its own.
    runtime = createHookRuntime({
      userDataPath: dir,
      sessionMetrics: () => false,
      ledger,
      containerFor: () => ({ ...container, freshness: 'exec-env' }),
    });
    await runtime.start(noopHandlers);

    await expect(runtime.writeContainerSession('hero-refresh', 'p')).resolves.toBe(null);
    expect(writeSessionSpy).not.toHaveBeenCalled();
    expect(writeAliasSpy).not.toHaveBeenCalled();
  });

  /**
   * The gap this task closes (HIVE-133, post-review fix). Before it,
   * `exec-env` never wrote a per-project set at all, so a project whose
   * `hostAlias` diverged from the global one still launched from the shared
   * set — which bakes the *global* alias's origin — while its environment
   * (`sessions/index.ts`'s `HIVE_RECEIVER_URL` substitution) said otherwise.
   */
  it('writes an alias set for an exec-env project whose alias diverges from the global one', async () => {
    runtime = createHookRuntime({
      userDataPath: dir,
      sessionMetrics: () => false,
      ledger,
      containerFor: () => ({ ...container, freshness: 'exec-env', hostAlias: 'gateway' }),
    });
    await runtime.start(noopHandlers);

    const written = await runtime.writeContainerSession('hero-refresh', 'p');

    expect(written).toBe(join(dir, 'hive', 'container', 'aliases', 'gateway'));
    expect(writeSessionSpy).not.toHaveBeenCalled();
    expect(writeAliasSpy).toHaveBeenCalledWith(
      dir,
      'gateway',
      expect.objectContaining({ origin: expect.stringContaining('gateway') }),
      expect.objectContaining({ containerRoot: '/hive/container/aliases/gateway' }),
    );
  });

  it('addresses the set by the project alias and keys it by entity id', async () => {
    runtime = createHookRuntime({
      userDataPath: dir,
      sessionMetrics: () => false,
      ledger,
      containerFor: () => ({ ...container, freshness: 'rewrite', hostAlias: 'gateway' }),
    });
    await runtime.start(noopHandlers);

    await runtime.writeContainerSession('hero-refresh', 'p');

    expect(writeSessionSpy).toHaveBeenCalledWith(
      dir,
      'hero-refresh',
      expect.objectContaining({ origin: expect.stringContaining('gateway') }),
      expect.objectContaining({ session: 'hero-refresh' }),
      expect.objectContaining({ containerRoot: '/hive/container/sessions/hero-refresh' }),
    );
  });

  it('writes the token tokenFor(entityId) actually produces, not a token for anything else', async () => {
    // `objectContaining({ session })` alone would pass even for a token
    // minted against the wrong argument — the exact failure mode that 403s
    // every hook, ledger and `/done` call from the container. The receiver's
    // own `tokenFor` is the oracle, reached the same way any other caller
    // reaches it — through `envFor`, which this module already exposes —
    // rather than reimplementing the HMAC here or reaching into the private
    // `receiver` closure.
    runtime = createHookRuntime({
      userDataPath: dir,
      sessionMetrics: () => false,
      ledger,
      containerFor: () => ({ ...container, freshness: 'rewrite' }),
    });
    await runtime.start(noopHandlers);

    await runtime.writeContainerSession('hero-refresh', 'p');

    const identity = writeSessionSpy.mock.calls.at(-1)?.[3];
    const expectedToken = runtime.envFor('hero-refresh')[HOOK_ENV_TOKEN];
    expect(identity).toEqual({ session: 'hero-refresh', token: expectedToken });
    // And not, say, a token minted for the caller's projectId or some other
    // string that happens to satisfy `objectContaining({ session })`.
    const otherToken = runtime.envFor('p')[HOOK_ENV_TOKEN];
    expect((identity as { token: string }).token).not.toBe(otherToken);
  });

  /**
   * Property B (HIVE-133 §2) again, from the metrics angle (Finding 2 of the
   * task-8 review): `sessionMetrics()` gates `metricsUrl` in the *host* set
   * (`writeHookSettings`) and in the shared `exec-env` set
   * (`writeSharedContainerFiles`) — this is the third writer of the same
   * value and it did not gate it, so a user who turned metrics off still got
   * a status line baked into every `rewrite` container session.
   */
  it('omits metricsUrl from the written set when sessionMetrics is off', async () => {
    runtime = createHookRuntime({
      userDataPath: dir,
      sessionMetrics: () => false,
      ledger,
      containerFor: () => ({ ...container, freshness: 'rewrite' }),
    });
    await runtime.start(noopHandlers);

    await runtime.writeContainerSession('hero-refresh', 'p');

    const origins = writeSessionSpy.mock.calls.at(-1)?.[2];
    expect(origins).not.toHaveProperty('metricsUrl');
  });

  it('includes metricsUrl from the written set when sessionMetrics is on', async () => {
    runtime = createHookRuntime({
      userDataPath: dir,
      sessionMetrics: () => true,
      ledger,
      containerFor: () => ({ ...container, freshness: 'rewrite' }),
    });
    await runtime.start(noopHandlers);

    await runtime.writeContainerSession('hero-refresh', 'p');

    const origins = writeSessionSpy.mock.calls.at(-1)?.[2];
    expect(origins).toHaveProperty('metricsUrl');
  });
});
