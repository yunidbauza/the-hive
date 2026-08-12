// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ptyHost,
  registerPtyHost,
  resetPtyHost,
} from '../../../../electron/main/pty-host/index';
import {
  resetShutdownHooks,
  runShutdown,
  shutdownHookCount,
} from '../../../../electron/main/shutdown';

/**
 * Wiring the supervisor into the app (story 091).
 *
 * `electron` is mocked because this module is the one that imports it. The
 * assertions are about *registration* — that creating the supervisor costs no
 * process, and that its teardown is on the quit path — not about supervision,
 * which `supervisor.test.ts` owns.
 *
 * Deliberately **no `vi.resetModules()`**: the shutdown registry is module
 * state, and a reset would hand this file a different copy of it than the one
 * the module under test writes to. `resetPtyHost` exists so the singleton can
 * be cleared without resetting the graph.
 */

// `vi.hoisted`, because `vi.mock`'s factory is hoisted above every top-level
// binding — a plain `const` above it is still in its temporal dead zone when
// the factory runs.
const { fork } = vi.hoisted(() => ({
  // Parameters are declared even though the body ignores them: without them
  // `mock.calls[0]` is the empty tuple and the assertions below cannot index it.
  fork: vi.fn(
    (
      _entry: string,
      _args: string[],
      _options: { serviceName?: string },
    ) => ({
      pid: 4242,
      postMessage: vi.fn(),
      kill: vi.fn(() => true),
      on: vi.fn(),
    }),
  ),
}));

vi.mock('electron', () => ({ utilityProcess: { fork } }));

beforeEach(() => {
  resetShutdownHooks();
  resetPtyHost();
  fork.mockClear();
});

afterEach(() => {
  resetShutdownHooks();
  resetPtyHost();
});

describe('registerPtyHost', () => {
  it('forks nothing — registration is not a launch', () => {
    registerPtyHost();

    // The AC this protects: no extra process at app launch.
    expect(fork).not.toHaveBeenCalled();
  });

  it('registers exactly one shutdown hook', () => {
    registerPtyHost();

    expect(shutdownHookCount()).toBe(1);
  });

  it('is idempotent — a second call adds no second hook', () => {
    const first = registerPtyHost();
    const second = registerPtyHost();

    expect(second).toBe(first);
    expect(shutdownHookCount()).toBe(1);
  });

  it('exposes the supervisor only after registration', () => {
    expect(ptyHost()).toBeNull();

    const created = registerPtyHost();

    expect(ptyHost()).toBe(created);
  });

  it('shuts the supervisor down when the app quits', async () => {
    const supervisor = registerPtyHost();
    const shutdown = vi.spyOn(supervisor, 'shutdown');

    await runShutdown();

    // `before-quit` awaits this, which is what stops `claude` processes
    // surviving app quit (story 081 built the hook for exactly this).
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('forks the real host only when a session is finally requested', () => {
    const supervisor = registerPtyHost();

    supervisor.spawn({
      sessionId: 'hero-refresh',
      shell: '/bin/zsh',
      args: [],
      cwd: '/repos/apfm-web',
      env: {},
      cols: 80,
      rows: 24,
    });

    expect(fork).toHaveBeenCalledTimes(1);
    // Beside `index.js`, which is where the second rollup input emits it.
    expect(fork.mock.calls[0]?.[0]).toMatch(/pty-host\.js$/);
    expect(fork.mock.calls[0]?.[2]).toMatchObject({
      serviceName: 'hive-pty-host',
    });
  });
});
