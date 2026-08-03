// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBootstrap } from '../../../../electron/main/sessions/bootstrap';

/**
 * When `claude` is written into a freshly spawned shell (story 096).
 *
 * **Fake timers throughout**, per `AGENTS.md`. Every rule here is a timing rule,
 * and the failure they prevent — characters landing in a buffer the shell
 * discards — is invisible in a test that waits for real milliseconds and passes
 * anyway on a fast machine.
 */

let written: { entityId: string; data: string }[];
let silent: string[];

function bootstrap(options: { debounceMs?: number; fallbackMs?: number } = {}) {
  return createBootstrap({
    write: (entityId, data) => written.push({ entityId, data }),
    onSilentStart: (entityId) => silent.push(entityId),
    ...options,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  written = [];
  silent = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bootstrap timing', () => {
  it('writes nothing until the shell has said something', () => {
    /**
     * The failure this prevents: characters written before the shell installs
     * its line discipline land in a buffer it may discard, and the session sits
     * at a bare prompt having silently swallowed the command.
     */
    const boot = bootstrap();
    boot.arm('sess', 'claude');

    vi.advanceTimersByTime(4_000);

    expect(written).toEqual([]);
    expect(boot.isPending('sess')).toBe(true);
  });

  it('writes after the first output plus a settling debounce', () => {
    const boot = bootstrap();
    boot.arm('sess', 'claude');

    boot.sawOutput('sess');
    vi.advanceTimersByTime(149);
    expect(written).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(written).toEqual([{ entityId: 'sess', data: 'claude\r' }]);
  });

  it('submits with a carriage return, not a newline', () => {
    /**
     * A pty's line discipline turns CR into "line submitted". A bare newline is
     * inserted as a literal in some shells and readline configurations, leaving
     * the command typed but never run — which looks exactly like `claude`
     * failing to start.
     */
    const boot = bootstrap();
    boot.arm('sess', 'claude');
    boot.sawOutput('sess');
    vi.advanceTimersByTime(150);

    expect(written[0]!.data.endsWith('\r')).toBe(true);
    expect(written[0]!.data).not.toContain('\n');
  });

  it('does not restart the debounce on every chunk', () => {
    // A shell that prints a long motd would otherwise postpone the bootstrap
    // indefinitely, one chunk at a time.
    const boot = bootstrap();
    boot.arm('sess', 'claude');

    boot.sawOutput('sess');
    vi.advanceTimersByTime(100);
    boot.sawOutput('sess');
    boot.sawOutput('sess');
    vi.advanceTimersByTime(50);

    expect(written).toHaveLength(1);
  });

  it('writes exactly once, however much output arrives afterwards', () => {
    const boot = bootstrap();
    boot.arm('sess', 'claude');
    boot.sawOutput('sess');
    vi.advanceTimersByTime(150);

    boot.sawOutput('sess');
    vi.advanceTimersByTime(1_000);

    expect(written).toHaveLength(1);
  });

  it('writes anyway after the fallback window, and records that it did', () => {
    /**
     * A genuinely silent startup is unusual but real — a bare `sh` with no
     * profile and `PS1` unset prints nothing at all. Waiting forever would leave
     * the session permanently empty.
     */
    const boot = bootstrap();
    boot.arm('sess', 'claude');

    vi.advanceTimersByTime(5_000);

    expect(written).toEqual([{ entityId: 'sess', data: 'claude\r' }]);
    // Flagged, because if the command also fails to take, this is the fact that
    // explains it.
    expect(silent).toEqual(['sess']);
  });

  it('does not flag a bootstrap that followed real output', () => {
    const boot = bootstrap();
    boot.arm('sess', 'claude');
    boot.sawOutput('sess');
    vi.advanceTimersByTime(150);

    expect(silent).toEqual([]);
  });

  it('uses the configured command, not a hard-coded one', () => {
    // `claudeCommand` from story 090, so a user with a wrapper or an alternate
    // binary is not stuck.
    const boot = bootstrap();
    boot.arm('sess', '/opt/bin/claude-wrapper');
    boot.sawOutput('sess');
    vi.advanceTimersByTime(150);

    expect(written[0]!.data).toBe('/opt/bin/claude-wrapper\r');
  });
});

describe('bootstrap lifecycle', () => {
  it('ignores a second arm for the same session', () => {
    // Re-arming would stack a timer and write the command twice.
    const boot = bootstrap();
    boot.arm('sess', 'claude');
    boot.arm('sess', 'claude');

    boot.sawOutput('sess');
    vi.advanceTimersByTime(5_000);

    expect(written).toHaveLength(1);
  });

  it('drops a pending bootstrap when the session dies first', () => {
    const boot = bootstrap();
    boot.arm('sess', 'claude');
    boot.cancel('sess');

    vi.advanceTimersByTime(10_000);

    expect(written).toEqual([]);
    expect(boot.isPending('sess')).toBe(false);
  });

  it('ignores output for a session it is not tracking', () => {
    const boot = bootstrap();
    expect(() => boot.sawOutput('ghost')).not.toThrow();
    vi.advanceTimersByTime(10_000);
    expect(written).toEqual([]);
  });

  it('keeps sessions independent', () => {
    const boot = bootstrap();
    boot.arm('a', 'claude');
    boot.arm('b', 'claude');

    boot.sawOutput('a');
    vi.advanceTimersByTime(150);

    expect(written).toEqual([{ entityId: 'a', data: 'claude\r' }]);
    expect(boot.isPending('b')).toBe(true);
  });

  it('drops every timer on dispose, so nothing outlives the app', () => {
    const boot = bootstrap();
    boot.arm('a', 'claude');
    boot.arm('b', 'claude');

    boot.dispose();
    vi.advanceTimersByTime(10_000);

    expect(written).toEqual([]);
  });
});
