// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBootstrap,
  sessionCommand,
} from '../../../../electron/main/sessions/bootstrap';

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

/**
 * Delivering a spawn's task as the session's first message (story 097).
 *
 * The renderer cannot time this — `session:status` carries
 * `working | idle | done` and nothing finer — so main does, by applying the
 * mechanism above a second time: the command settles, then the TUI's own
 * output settles, then the task goes in.
 */
describe('the task stage', () => {
  const DEBOUNCE = 150;
  const FALLBACK = 5_000;
  const armed = () =>
    bootstrap({ debounceMs: DEBOUNCE, fallbackMs: FALLBACK });

  it('writes the task after the TUI settles, not alongside the command', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');

    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(written).toEqual([{ entityId: 'sess-a', data: 'claude\r' }]);

    // The TUI paints; that is the signal the second stage waits for.
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(written).toEqual([
      { entityId: 'sess-a', data: 'claude\r' },
      { entityId: 'sess-a', data: 'fix the hero\r' },
    ]);
  });

  it('submits the task with a carriage return too', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);

    expect(written.at(-1)?.data.endsWith('\r')).toBe(true);
    expect(written.at(-1)?.data).not.toContain('\n');
  });

  it('writes the task exactly once, however much the TUI paints', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);

    boot.sawOutput('sess-a');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(FALLBACK * 2);

    expect(written).toHaveLength(2);
  });

  it('writes the task even if the TUI prints nothing at all', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);

    vi.advanceTimersByTime(FALLBACK);

    expect(written.at(-1)?.data).toBe('fix the hero\r');
  });

  it('drops a pending task when the session dies between the stages', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);

    boot.cancel('sess-a');
    vi.advanceTimersByTime(FALLBACK * 2);

    // Only the command went in. `cancel` reaches the second stage for free,
    // which is the reason it is a re-arm rather than a chained timer.
    expect(written).toHaveLength(1);
  });

  it('reports the task as still pending until it has been written', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);

    expect(boot.isPending('sess-a')).toBe(true);

    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(boot.isPending('sess-a')).toBe(false);
  });

  it('drops the second stage on dispose, so nothing outlives the app', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);

    boot.dispose();
    vi.advanceTimersByTime(FALLBACK * 2);

    expect(written).toHaveLength(1);
  });

  it('waits for the TUI to go quiet, not for its echo of the command', () => {
    /**
     * The defect this pins: the first output after `claude\r` is the line
     * discipline's echo of the command itself, arriving in milliseconds. A
     * first-chunk-plus-debounce clock therefore fired ~150ms after `claude` was
     * invoked — long before its TUI could accept input, which is exactly the
     * failure this module exists to prevent.
     */
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(written).toHaveLength(1);

    // The echo, then a TUI that keeps painting for a while.
    for (let i = 0; i < 8; i += 1) {
      boot.sawOutput('sess-a');
      vi.advanceTimersByTime(DEBOUNCE - 20);
    }
    expect(written).toHaveLength(1);

    // It goes quiet — now, and only now, the task goes in.
    vi.advanceTimersByTime(DEBOUNCE);
    expect(written.at(-1)?.data).toBe('fix the hero\r');
  });

  it('caps the wait, so a TUI that never stops painting still gets its task', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);

    for (let i = 0; i < 200; i += 1) {
      boot.sawOutput('sess-a');
      vi.advanceTimersByTime(DEBOUNCE - 20);
    }

    expect(written).toHaveLength(2);
    expect(written.at(-1)?.data).toBe('fix the hero\r');
  });

  it('reports completion once, after the last stage', () => {
    const done: string[] = [];
    const boot = createBootstrap({
      write: (entityId, data) => written.push({ entityId, data }),
      onComplete: (entityId) => done.push(entityId),
      debounceMs: DEBOUNCE,
      fallbackMs: FALLBACK,
    });

    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);
    // Stage one is done but the task is still pending — not complete yet.
    expect(done).toEqual([]);

    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(FALLBACK);

    expect(done).toEqual(['sess-a']);
  });

  it('reports completion for a bootstrap with no task at all', () => {
    const done: string[] = [];
    const boot = createBootstrap({
      write: (entityId, data) => written.push({ entityId, data }),
      onComplete: (entityId) => done.push(entityId),
      debounceMs: DEBOUNCE,
      fallbackMs: FALLBACK,
    });

    boot.arm('sess-a', 'claude');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);

    expect(done).toEqual(['sess-a']);
  });

  it('is still a single write when there is no task', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(FALLBACK * 2);

    expect(written).toEqual([{ entityId: 'sess-a', data: 'claude\r' }]);
  });

  it('keeps two sessions’ task stages independent', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'first');
    boot.arm('sess-b', 'claude', 'second');

    for (const id of ['sess-a', 'sess-b']) {
      boot.sawOutput(id);
      vi.advanceTimersByTime(DEBOUNCE);
      boot.sawOutput(id);
      vi.advanceTimersByTime(DEBOUNCE);
    }

    expect(written.filter((entry) => entry.data === 'first\r')).toHaveLength(1);
    expect(written.filter((entry) => entry.data === 'second\r')).toHaveLength(1);
  });
});

describe('sessionCommand', () => {
  it('exits the shell after a clean claude exit', () => {
    /**
     * The whole of "`/exit` retires the session": the login shell goes with the
     * agent, the pty exits, and story 096's existing `exit → done` mapping does
     * the rest. No new status, no process-tree watching.
     */
    expect(sessionCommand('claude')).toBe('claude && exit');
  });

  it('wraps whatever claudeCommand is configured, not a hard-coded binary', () => {
    // Story 090 lets a user point at a wrapper or an alternate build; the exit
    // behaviour has to follow it rather than only applying to the default.
    expect(sessionCommand('/opt/bin/claude --verbose')).toBe(
      '/opt/bin/claude --verbose && exit',
    );
  });

  it('is `&&`, so a failed start leaves the shell alive to show the error', () => {
    /**
     * Asserted as the operator rather than as behaviour, because the behaviour
     * is the shell's. `;` here would make a mistyped `claudeCommand` close every
     * new session instantly, with `command not found` scrolling past inside a
     * pty that is already going away — the single worst failure this could have.
     */
    expect(sessionCommand('claude')).not.toContain(';');
    expect(sessionCommand('claude')).toContain('&&');
  });
});
