// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBootstrap,
  sessionCommand,
} from '../../../../electron/main/sessions/bootstrap';
import { SUBMIT_DELAY_MS } from '../../../../electron/shared/session-contract';

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

/**
 * What each stage submitted, as one line per stage.
 *
 * A stage goes in as **two** writes — its text, then its `\r` after
 * {@link SUBMIT_DELAY_MS} (HIVE-63) — so this drops the carriage returns and
 * puts them back on the text. The timing rules most of these tests exist for
 * are about when a stage *fires*, and one line per stage keeps them readable.
 *
 * **This helper cannot see ordering, and that is a real limitation.** By
 * filtering every `\r` and re-attaching one, it reports the same thing whether
 * a stage's carriage return preceded the next stage's text or followed it —
 * which is exactly the defect that shipped in the first version of the split
 * and passed this suite. Anything about the *sequence* of bytes must assert on
 * `written` directly; see `byte order across stages` below, which does.
 *
 * Deliberately **does not advance timers**. These tests interleave assertions
 * with `advanceTimersByTime` at debounce granularity, and a helper that moved
 * the clock as a side effect of being read would fire the next stage early —
 * turning the assertion into a measurement of the assertion.
 */
function submitted() {
  return written
    .filter((entry) => entry.data !== '\r')
    .map((entry) => ({ entityId: entry.entityId, data: `${entry.data}\r` }));
}

/** Every write for one entity, concatenated — the bytes the pty actually saw. */
const stream = (entityId: string) =>
  written
    .filter((entry) => entry.entityId === entityId)
    .map((entry) => entry.data)
    .join('');

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
    expect(submitted()).toEqual([{ entityId: 'sess', data: 'claude\r' }]);
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
    vi.advanceTimersByTime(SUBMIT_DELAY_MS);

    expect(written.map((entry) => entry.data).join('')).toBe('claude\r');
    expect(written.some((entry) => entry.data.includes('\n'))).toBe(false);
  });

  it('sends the text and its carriage return as two writes', () => {
    /**
     * HIVE-63. Sent as one write, a stage longer than ~64 characters is treated
     * by Claude Code's TUI as a **paste**, and the trailing `\r` is inserted
     * into the input box rather than submitting it — so the session sits there
     * holding a task nobody can see it was given. Splitting them makes the text
     * a paste, which it is, and the `\r` a keystroke, which is unambiguous.
     *
     * Measured against `claude` 2.1.222: a single write submits at ≤62
     * characters and is swallowed at ≥65.
     */
    const boot = bootstrap();
    boot.arm('sess', 'claude');
    boot.sawOutput('sess');
    vi.advanceTimersByTime(150);

    // The text goes in on its own, with no carriage return attached.
    expect(written).toEqual([{ entityId: 'sess', data: 'claude' }]);

    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(written).toEqual([
      { entityId: 'sess', data: 'claude' },
      { entityId: 'sess', data: '\r' },
    ]);
  });

  it('does not submit a stage whose session died in the split', () => {
    /**
     * The window the split opens: `fire` has already dropped the pending entry
     * by the time it writes, so a session killed between the text and its `\r`
     * has nothing in `pending` and a live timer waiting to write into a pty
     * that is gone.
     */
    const boot = bootstrap();
    boot.arm('sess', 'claude');
    boot.sawOutput('sess');
    vi.advanceTimersByTime(150);
    expect(written).toHaveLength(1);

    boot.cancel('sess');
    vi.advanceTimersByTime(SUBMIT_DELAY_MS * 10);

    expect(written).toHaveLength(1);
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

    expect(submitted()).toHaveLength(1);
  });

  it('writes exactly once, however much output arrives afterwards', () => {
    const boot = bootstrap();
    boot.arm('sess', 'claude');
    boot.sawOutput('sess');
    vi.advanceTimersByTime(150);

    boot.sawOutput('sess');
    vi.advanceTimersByTime(1_000);

    expect(submitted()).toHaveLength(1);
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

    expect(submitted()).toEqual([{ entityId: 'sess', data: 'claude\r' }]);
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

    expect(written[0]!.data).toBe('/opt/bin/claude-wrapper');
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

    expect(submitted()).toHaveLength(1);
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

    expect(submitted()).toEqual([{ entityId: 'a', data: 'claude\r' }]);
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
  /**
   * Settle a stage *and* send its carriage return.
   *
   * Stage two is armed inside the submit timer, after the `\r` — nothing
   * follows a stage until that stage has actually been submitted (HIVE-63) —
   * so a bare debounce no longer reaches the next stage.
   */
  const SETTLE = DEBOUNCE + SUBMIT_DELAY_MS;
  const armed = () =>
    bootstrap({ debounceMs: DEBOUNCE, fallbackMs: FALLBACK });

  it('writes the task after the TUI settles, not alongside the command', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');

    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);
    expect(submitted()).toEqual([{ entityId: 'sess-a', data: 'claude\r' }]);

    // The TUI paints; that is the signal the second stage waits for.
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);
    expect(submitted()).toEqual([
      { entityId: 'sess-a', data: 'claude\r' },
      { entityId: 'sess-a', data: 'fix the hero\r' },
    ]);
  });

  it('submits the task with a carriage return too', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);

    expect(submitted().at(-1)?.data).toBe('fix the hero\r');
    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(written.at(-1)?.data).toBe('\r');
  });

  it('writes the task exactly once, however much the TUI paints', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);

    boot.sawOutput('sess-a');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(FALLBACK * 2);

    expect(submitted()).toHaveLength(2);
  });

  it('writes the task even if the TUI prints nothing at all', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);

    vi.advanceTimersByTime(FALLBACK);

    expect(submitted().at(-1)?.data).toBe('fix the hero\r');
  });

  it('drops a pending task when the session dies between the stages', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);

    boot.cancel('sess-a');
    vi.advanceTimersByTime(FALLBACK * 2);

    // Only the command went in. `cancel` reaches the second stage for free,
    // which is the reason it is a re-arm rather than a chained timer.
    expect(submitted()).toHaveLength(1);
  });

  it('reports the task as still pending until it has been written', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);

    expect(boot.isPending('sess-a')).toBe(true);

    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);
    expect(boot.isPending('sess-a')).toBe(false);
  });

  it('drops the second stage on dispose, so nothing outlives the app', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);

    boot.dispose();
    vi.advanceTimersByTime(FALLBACK * 2);

    expect(submitted()).toHaveLength(1);
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
    vi.advanceTimersByTime(SETTLE);
    expect(submitted()).toHaveLength(1);

    // The echo, then a TUI that keeps painting for a while.
    for (let i = 0; i < 8; i += 1) {
      boot.sawOutput('sess-a');
      vi.advanceTimersByTime(DEBOUNCE - 20);
    }
    expect(submitted()).toHaveLength(1);

    // It goes quiet — now, and only now, the task goes in.
    vi.advanceTimersByTime(SETTLE);
    expect(submitted().at(-1)?.data).toBe('fix the hero\r');
  });

  it('caps the wait, so a TUI that never stops painting still gets its task', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'fix the hero');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);

    for (let i = 0; i < 200; i += 1) {
      boot.sawOutput('sess-a');
      vi.advanceTimersByTime(DEBOUNCE - 20);
    }

    expect(submitted()).toHaveLength(2);
    expect(submitted().at(-1)?.data).toBe('fix the hero\r');
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
    vi.advanceTimersByTime(SETTLE);
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

    /**
     * Not yet — the text has gone in but the `\r` has not (HIVE-63).
     * Completion releases held input, and releasing it here would append the
     * user's keystrokes to the command line rather than sending them to the
     * agent.
     */
    expect(done).toEqual([]);

    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(done).toEqual(['sess-a']);
  });

  it('is still a single write when there is no task', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(FALLBACK * 2);

    expect(submitted()).toEqual([{ entityId: 'sess-a', data: 'claude\r' }]);
  });

  it('keeps two sessions’ task stages independent', () => {
    const boot = armed();
    boot.arm('sess-a', 'claude', 'first');
    boot.arm('sess-b', 'claude', 'second');

    for (const id of ['sess-a', 'sess-b']) {
      boot.sawOutput(id);
      vi.advanceTimersByTime(SETTLE);
      boot.sawOutput(id);
      vi.advanceTimersByTime(SETTLE);
    }

    expect(submitted().filter((entry) => entry.data === 'first\r')).toHaveLength(1);
    expect(submitted().filter((entry) => entry.data === 'second\r')).toHaveLength(1);
  });
});

describe('byte order across stages (HIVE-63)', () => {
  const DEBOUNCE = 150;
  const FALLBACK = 5_000;

  it('never writes a stage before the previous one has been submitted', () => {
    /**
     * The regression this file previously could not see.
     *
     * `SUBMIT_DELAY_MS` (300) is longer than `BOOTSTRAP_DEBOUNCE_MS` (150), and
     * the pty echoes the text just written — which is output, which starts the
     * next stage's clock. Arming stage two beside the *text* therefore fired it
     * inside the gap before stage one's `\r`, and the shell received
     * `…&& exitfix the hero`: the command corrupted and the task lost.
     *
     * Asserted on the concatenated byte stream rather than on write counts,
     * because the whole failure is an ordering one.
     */
    const boot = bootstrap({ debounceMs: DEBOUNCE, fallbackMs: FALLBACK });
    boot.arm('sess-a', 'claude --name sess-a && exit', 'fix the hero');

    // The shell speaks; stage one settles and its text goes in.
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);

    // The echo of that text arrives while the `\r` is still pending — this is
    // the exact window the bug lived in.
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SUBMIT_DELAY_MS * 4);
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SUBMIT_DELAY_MS * 4);

    expect(stream('sess-a')).toBe('claude --name sess-a && exit\rfix the hero\r');
  });

  it('holds a stage as pending until its carriage return has gone', () => {
    /**
     * `sessions.write` gates held input on `isPending`. `fire` deletes the
     * pending entry before it writes, so without counting the submit window a
     * keystroke arriving in those 300ms went straight to the pty and was
     * appended to the command line.
     */
    const boot = bootstrap({ debounceMs: DEBOUNCE, fallbackMs: FALLBACK });
    boot.arm('sess-a', 'claude');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);

    expect(boot.isPending('sess-a')).toBe(true);

    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(boot.isPending('sess-a')).toBe(false);
  });
});

describe('sessionCommand identity flags (HIVE-61)', () => {
  const UUID = '00000000-0000-4000-8000-000000000000';

  it('names the session and pins its id', () => {
    expect(sessionCommand('claude', { name: 'sess-01', sessionUuid: UUID })).toBe(
      `claude --name sess-01 --session-id ${UUID} && exit`,
    );
  });

  it('quotes the settings path, which contains a space on every Mac', () => {
    /**
     * `app.getPath('userData')` is `~/Library/Application Support/the-hive/…`.
     * Unquoted, the shell split it and `claude` got `--settings
     * /Users/…/Application` plus a stray positional argument it read as an
     * initial prompt — so hook status never worked on macOS at all.
     */
    expect(
      sessionCommand('claude', {
        settingsPath: '/Users/x/Library/Application Support/the-hive/hooks.json',
      }),
    ).toBe(
      "claude --settings '/Users/x/Library/Application Support/the-hive/hooks.json' && exit",
    );
  });

  it('escapes a single quote in the settings path', () => {
    // A home directory can contain one; `'\''` closes, escapes and reopens.
    expect(sessionCommand('claude', { settingsPath: "/Users/o'brien/hooks.json" })).toBe(
      "claude --settings '/Users/o'\\''brien/hooks.json' && exit",
    );
  });

  it('keeps the flags in a stable order alongside model and effort', () => {
    expect(
      sessionCommand('claude', {
        model: 'opus',
        effort: 'high',
        name: 'sess-01',
        sessionUuid: UUID,
      }),
    ).toBe(`claude --model opus --effort high --name sess-01 --session-id ${UUID} && exit`);
  });

  it.each([
    ['a space', 'sess 01'],
    ['a semicolon', 'sess;rm -rf ~'],
    ['a backtick', 'sess`whoami`'],
    ['a dollar', 'sess$HOME'],
    ['an ampersand', 'sess&&curl evil.sh'],
    ['a quote', "sess'x"],
    ['a double quote', 'sess"x'],
    ['a pipe', 'sess|sh'],
    ['a newline', 'sess\nrm -rf ~'],
    ['a backslash', 'sess\\x'],
    ['an empty string', ''],
  ])('drops a name containing %s rather than escaping it', (_label, name) => {
    /**
     * The security property. `--name` is interpolated into a string a login
     * shell parses, and unlike `--model`/`--effort` it has no closed list behind
     * it — so the reasoning that justifies leaving those unquoted does not reach
     * this one. A name that fails the pattern omits the **flag**, which starts
     * the session unnamed: exactly what it did before this story, and never a
     * command line with a shell metacharacter in it.
     */
    const command = sessionCommand('claude', { name });

    expect(command).toBe('claude && exit');
    expect(command).not.toContain('--name');
  });

  it('drops a name past the length cap', () => {
    expect(sessionCommand('claude', { name: 'a'.repeat(65) })).toBe('claude && exit');
  });

  it('accepts the ids the app actually generates', () => {
    // `sess-01`, and the fixture ids that reach this path on first open.
    for (const name of ['sess-01', 'sess-a1', 'hero-refresh', 'lead-form']) {
      expect(sessionCommand('claude', { name })).toBe(`claude --name ${name} && exit`);
    }
  });

  it('drops a session id that is not a uuid', () => {
    /**
     * A malformed value makes `claude` exit non-zero, and `&&` turns that into
     * "the session opened and did nothing" — the hardest failure to diagnose
     * from the outside.
     */
    expect(sessionCommand('claude', { sessionUuid: 'not-a-uuid' })).toBe(
      'claude && exit',
    );
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

  describe('the picker’s choice reaches the command line (story 109)', () => {
    it('appends both flags, before the `&&`', () => {
      /**
       * The defect: model and effort were recorded on the entity and rendered
       * on its chip from the story that introduced the picker, and reached the
       * process in no story at all. A session started as Haiku with low effort
       * opened as Opus and its own meta bar agreed.
       *
       * Position matters — they are arguments to `claude`, so binding them to
       * `exit` instead would both lose them and break the short-circuit.
       */
      expect(sessionCommand('claude', { model: 'haiku', effort: 'low' })).toBe(
        'claude --model haiku --effort low && exit',
      );
    });

    it('omits the flag it was not given, rather than inventing a default', () => {
      /**
       * A default here would silently override the user's own `claude`
       * configuration for every session nobody picked a model for.
       */
      expect(sessionCommand('claude', { model: 'opus' })).toBe(
        'claude --model opus && exit',
      );
      expect(sessionCommand('claude', { effort: 'max' })).toBe(
        'claude --effort max && exit',
      );
      expect(sessionCommand('claude', {})).toBe('claude && exit');
    });

    it('appends to a wrapper command, which is the real configuration', () => {
      /**
       * `claudeCommand` is routinely a shell function or script that forwards
       * its arguments — the flags have to land after it, not inside it.
       */
      expect(sessionCommand('clauded', { model: 'sonnet', effort: 'high' })).toBe(
        'clauded --model sonnet --effort high && exit',
      );
    });
  });
});
