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
 * One stage, always — the task is an argument, not a second write (HIVE-91).
 *
 * Story 097 delivered a spawn's task as a *second stage*: the command settled,
 * then the TUI's own output settled, then the task was typed in. That is a
 * timing guess about another program's startup, and it had no safe failure. When
 * `claude` did not start, the thing reading the pty was the login shell, so the
 * user's instruction was run as a command line:
 *
 * ```
 * $ claude --model opus … && exit
 * zsh: command not found: claude
 * $ what time is it
 * what: time: No such file or directory
 * ```
 *
 * The task now rides *inside* the command as `claude`'s initial prompt, so these
 * tests assert the absence the fix creates: whatever the TUI does, and whatever
 * the command contains, the pty sees one stage and never a second.
 */
describe('the single stage (HIVE-91)', () => {
  const DEBOUNCE = 150;
  const FALLBACK = 5_000;
  const SETTLE = DEBOUNCE + SUBMIT_DELAY_MS;
  const armed = () =>
    bootstrap({ debounceMs: DEBOUNCE, fallbackMs: FALLBACK });

  /** A command carrying its task, as `sessionCommand` now builds it. */
  const WITH_TASK = "claude --name sess-a 'fix the hero' && exit";

  it('writes the command carrying its task, and nothing after it', () => {
    const boot = armed();
    boot.arm('sess-a', WITH_TASK);

    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);
    expect(submitted()).toEqual([{ entityId: 'sess-a', data: `${WITH_TASK}\r` }]);

    /**
     * The TUI paints — which is what the old second stage waited for. Nothing
     * may follow, because there is no longer anything to follow with.
     */
    boot.sawOutput('sess-a');
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(FALLBACK * 2);
    expect(submitted()).toEqual([{ entityId: 'sess-a', data: `${WITH_TASK}\r` }]);
  });

  it('never writes the task as pty input of its own', () => {
    /**
     * The regression guard for the reported defect, asserted on the byte stream
     * rather than on write counts — the failure was that `fix the hero` reached
     * the pty as a line in its own right, whoever happened to be reading it.
     */
    const boot = armed();
    boot.arm('sess-a', WITH_TASK);
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);

    for (let i = 0; i < 40; i += 1) {
      boot.sawOutput('sess-a');
      vi.advanceTimersByTime(DEBOUNCE - 20);
    }
    vi.advanceTimersByTime(FALLBACK * 2);

    expect(stream('sess-a')).toBe(`${WITH_TASK}\r`);
  });

  it('a TUI that never stops painting still adds no second write', () => {
    const boot = armed();
    boot.arm('sess-a', WITH_TASK);
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);

    for (let i = 0; i < 200; i += 1) {
      boot.sawOutput('sess-a');
      vi.advanceTimersByTime(DEBOUNCE - 20);
    }

    expect(submitted()).toHaveLength(1);
  });

  it('reports completion after the stage’s carriage return', () => {
    const done: string[] = [];
    const boot = createBootstrap({
      write: (entityId, data) => written.push({ entityId, data }),
      onComplete: (entityId) => done.push(entityId),
      debounceMs: DEBOUNCE,
      fallbackMs: FALLBACK,
    });

    boot.arm('sess-a', WITH_TASK);
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

  it('completes exactly once, however much the TUI paints afterwards', () => {
    const done: string[] = [];
    const boot = createBootstrap({
      write: (entityId, data) => written.push({ entityId, data }),
      onComplete: (entityId) => done.push(entityId),
      debounceMs: DEBOUNCE,
      fallbackMs: FALLBACK,
    });

    boot.arm('sess-a', WITH_TASK);
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SETTLE);
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(FALLBACK * 2);

    expect(done).toEqual(['sess-a']);
  });

  it('a session that dies before settling writes nothing at all', () => {
    const boot = armed();
    boot.arm('sess-a', WITH_TASK);
    boot.cancel('sess-a');
    vi.advanceTimersByTime(FALLBACK * 2);

    expect(submitted()).toEqual([]);
  });

  it('drops a pending stage on dispose, so nothing outlives the app', () => {
    const boot = armed();
    boot.arm('sess-a', WITH_TASK);
    boot.dispose();
    vi.advanceTimersByTime(FALLBACK * 2);

    expect(submitted()).toEqual([]);
  });

  it('keeps two sessions’ stages independent', () => {
    const boot = armed();
    boot.arm('sess-a', "claude 'first' && exit");
    boot.arm('sess-b', "claude 'second' && exit");

    for (const id of ['sess-a', 'sess-b']) {
      boot.sawOutput(id);
      vi.advanceTimersByTime(SETTLE);
    }

    expect(stream('sess-a')).toBe("claude 'first' && exit\r");
    expect(stream('sess-b')).toBe("claude 'second' && exit\r");
  });
});

describe('byte order (HIVE-63)', () => {
  const DEBOUNCE = 150;
  const FALLBACK = 5_000;

  it('the text goes in before its carriage return, and nothing between', () => {
    /**
     * The window this pins used to be a two-stage ordering bug.
     *
     * `SUBMIT_DELAY_MS` (300) is longer than `BOOTSTRAP_DEBOUNCE_MS` (150), and
     * the pty echoes the text just written — which is output, which started the
     * *next* stage's clock. Arming stage two beside the text therefore fired it
     * inside the gap before stage one's `\r`, and the shell received
     * `…&& exitfix the hero`: the command corrupted and the task lost.
     *
     * HIVE-91 removed the second stage, so the ordering hazard is gone by
     * construction rather than by arithmetic between two constants. What remains
     * worth asserting is that the surviving stage is still two writes in the
     * right order, and that output arriving in the gap adds nothing — which is
     * the same observation, now with the stronger expected value.
     */
    const boot = bootstrap({ debounceMs: DEBOUNCE, fallbackMs: FALLBACK });
    const command = "claude --name sess-a 'fix the hero' && exit";
    boot.arm('sess-a', command);

    // The shell speaks; the stage settles and its text goes in.
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(DEBOUNCE);
    expect(stream('sess-a')).toBe(command);

    // The echo of that text arrives while the `\r` is still pending — this is
    // the exact window the bug lived in.
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SUBMIT_DELAY_MS * 4);
    boot.sawOutput('sess-a');
    vi.advanceTimersByTime(SUBMIT_DELAY_MS * 4);

    expect(stream('sess-a')).toBe(`${command}\r`);
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

  it('resumes the conversation the uuid names when asked (HIVE-88)', () => {
    // Same identifier, opposite claim: continue it rather than start it.
    expect(
      sessionCommand('claude', { name: 'sess-01', sessionUuid: UUID, resume: true }),
    ).toBe(`claude --name sess-01 --resume ${UUID} && exit`);
  });

  it('has nothing to resume without a uuid', () => {
    // A record written before uuids were kept gets the plain spawn.
    expect(sessionCommand('claude', { name: 'sess-01', resume: true })).toBe(
      'claude --name sess-01 && exit',
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

  it('omits --plugin-dir when there is no generated directory', () => {
    /*
      `pluginDirPath()` answers null until a sync has succeeded (HIVE-96). A
      session with no custom skills is the correct outcome of that — better than
      one pointed at a directory that is not there.
    */
    expect(sessionCommand('claude', {})).toBe('claude && exit');
  });

  it('quotes the plugin dir, which is under Application Support too', () => {
    expect(
      sessionCommand('claude', {
        pluginDir: '/Users/x/Library/Application Support/the-hive/hive/plugin',
      }),
    ).toBe(
      "claude --plugin-dir '/Users/x/Library/Application Support/the-hive/hive/plugin' && exit",
    );
  });

  it('emits --plugin-dir exactly once, after --settings', () => {
    const command = sessionCommand('claude', {
      settingsPath: '/s/hooks.json',
      pluginDir: '/p/plugin',
    });

    expect(command).toBe(
      "claude --settings '/s/hooks.json' --plugin-dir '/p/plugin' && exit",
    );
    expect(command.match(/--plugin-dir/g)).toHaveLength(1);
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

  it('accepts a ticket key and its de-duplicating suffix (HIVE-78)', () => {
    /**
     * The Work-tab path. A session started from a ticket card is called after
     * its issue rather than `sess-07`, so the agent's own prompt box, its
     * `/resume` entry and the fleet rail all say the same thing.
     *
     * A Jira key is uppercase, digits and hyphens, and the suffix adds a hyphen
     * and digits — so it satisfies `SESSION_NAME_PATTERN` by construction and
     * reaches the command line rather than being silently dropped.
     */
    for (const name of ['HIVE-73', 'HIVE-73-2', 'INCORP-332', 'H2-1']) {
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

  describe('the task becomes the initial prompt (HIVE-91)', () => {
    it('passes the task as a positional argument, after the flags', () => {
      /**
       * Position is the assertion. Before the `&&` so it binds to `claude` and
       * not to `exit`, and after the flags so it is read as the prompt rather
       * than as a value for whichever flag it happened to follow.
       */
      expect(
        sessionCommand('claude', { model: 'opus', task: 'fix the hero' }),
      ).toBe("claude --model opus 'fix the hero' && exit");
    });

    it('quotes it, because it is the one value with no closed list behind it', () => {
      /**
       * `--model`/`--effort`/`--name` are validated against closed lists, so the
       * module's no-quoting rule covers them. The task is free text from the
       * console and the picker, so it is the second argument here — after
       * `settingsPath` — that genuinely needs quoting.
       */
      expect(sessionCommand('claude', { task: 'rm -rf / ; echo $HOME' })).toBe(
        "claude 'rm -rf / ; echo $HOME' && exit",
      );
    });

    it('survives a task containing a single quote', () => {
      // `'\''` closes, escapes and reopens — the same mechanism `settingsPath`
      // relies on for `/Users/o'brien/…`.
      expect(sessionCommand('claude', { task: "don't break" })).toBe(
        "claude 'don'\\''t break' && exit",
      );
    });

    it('omits an empty task rather than passing an empty argument', () => {
      /**
       * The picker spawns with `''`, not `undefined`, so this is the common path.
       * `claude ''` is a request to open with a blank prompt, which is not the
       * same as opening with none.
       */
      expect(sessionCommand('claude', { task: '' })).toBe('claude && exit');
      expect(sessionCommand('claude', { task: '   ' })).toBe('claude && exit');
      expect(sessionCommand('claude', {})).toBe('claude && exit');
    });

    it('flattens newlines, which would submit the line early', () => {
      /**
       * The command is written into a pty and terminated by one `\r`. An embedded
       * newline would submit at that point and leave the tail of the task — and
       * the `&& exit` — to be read by the shell as a second command line.
       */
      expect(
        sessionCommand('claude', { task: 'first line\nsecond line' }),
      ).toBe("claude 'first line second line' && exit");
      expect(sessionCommand('claude', { task: 'trailing\r\n' })).toBe(
        "claude 'trailing' && exit",
      );
    });

    it('rides alongside every other flag, in a full spawn', () => {
      // The shape main actually builds, so the ordering of all six is pinned.
      expect(
        sessionCommand('claude', {
          model: 'sonnet',
          effort: 'high',
          name: 'INCORP-455',
          settingsPath: '/Users/x/Application Support/hooks.json',
          pluginDir: '/Users/x/Application Support/hive/plugin',
          task: 'what time is it',
          subscriptionAuth: true,
        }),
      ).toBe(
        'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; ' +
          'claude --model sonnet --effort high --name INCORP-455 ' +
          "--settings '/Users/x/Application Support/hooks.json' " +
          "--plugin-dir '/Users/x/Application Support/hive/plugin' " +
          "'what time is it' && exit",
      );
    });
  });

  describe('sessionCommand — the MCP config (HIVE-112)', () => {
    it('passes --mcp-config when one is offered', () => {
      const command = sessionCommand('claude', { mcpConfig: '/userData/hive/hive.mcp.json' });

      expect(command).toContain("--mcp-config '/userData/hive/hive.mcp.json'");
    });

    it('omits the flag when there is none', () => {
      expect(sessionCommand('claude', {})).not.toContain('--mcp-config');
    });

    it('quotes a path with a space, like userData always has', () => {
      const command = sessionCommand('claude', {
        mcpConfig: '/Users/x/Application Support/Hive/hive.mcp.json',
      });

      expect(command).toContain("'/Users/x/Application Support/Hive/hive.mcp.json'");
    });

    it('does not pass --strict-mcp-config — a session keeps its own servers', () => {
      // Verified against the real CLI: without --strict, --mcp-config merges.
      // With it, the user's own MCP servers would vanish inside the Hive.
      const command = sessionCommand('claude', { mcpConfig: '/a/b.json' });

      expect(command).not.toContain('--strict-mcp-config');
    });

    it('sits alongside --plugin-dir rather than replacing it', () => {
      const command = sessionCommand('claude', {
        pluginDir: '/userData/hive/plugin',
        mcpConfig: '/userData/hive/hive.mcp.json',
      });

      expect(command).toContain('--plugin-dir');
      expect(command).toContain('--mcp-config');
    });
  });
});
