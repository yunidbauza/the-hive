// @vitest-environment node
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  doneCommand,
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_EVENTS,
  HOOK_STATUS,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
} from '../../../../electron/shared/hook-contract';
import { METRICS_REFRESH_SECONDS } from '../../../../electron/shared/metrics-contract';
import {
  CLAUDE_THEME,
  hookSettings,
  metricsScript,
  statusLineSettings,
  writeHookSettings,
} from '../../../../electron/main/hooks/settings';
import { doneSkill } from '../../../../electron/main/skills/done-skill';

/**
 * The settings file and the receiver are two halves of one contract (HIVE-62).
 *
 * The file names the headers Claude will send; the receiver authenticates on
 * exactly those names. A mismatch is silent and total — every hook answers 403,
 * every session's status falls back to pty inference, and nothing anywhere says
 * why. So the halves are pinned against the shared constants here rather than
 * against string literals, which would agree with themselves and nothing else.
 */
describe('hookSettings', () => {
  const URL = 'http://127.0.0.1:51234/hook';
  const settings = hookSettings(URL);

  it('subscribes to exactly the events the app handles', () => {
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
  });

  /**
   * `SessionEnd` **is** subscribed now, and the reason the old omission gave is
   * still respected.
   *
   * That reason was: `/clear` fires it on a live session, so calling it
   * `terminated` locks the user out of a working agent. Both remain true. What
   * changed is that the event no longer produces a status at all — it produces
   * `done` on its own channel, and only for `reason: 'clear'`. The guarantee
   * that used to be expressed by not subscribing is now expressed by
   * {@link StatusHookEvent}, which excludes it from the status map so no edit
   * can quietly map it back onto `terminated`.
   */
  it('subscribes SessionEnd, but never as a status', () => {
    expect(Object.keys(settings.hooks)).toContain('SessionEnd');
    expect(Object.keys(HOOK_STATUS)).not.toContain('SessionEnd');
  });

  it('posts every event to the receiver over http', () => {
    for (const event of HOOK_EVENTS) {
      const [entry] = settings.hooks[event] as { hooks: { type: string; url: string }[] }[];
      expect(entry!.hooks[0]!.type).toBe('http');
      expect(entry!.hooks[0]!.url).toBe(URL);
    }
  });

  it('sends the two headers the receiver authenticates on', () => {
    const handler = (
      settings.hooks.Stop as {
        hooks: { headers: Record<string, string>; allowedEnvVars: string[] }[];
      }[]
    )[0]!.hooks[0]!;

    expect(handler.headers[HOOK_HEADER_SESSION]).toBe(`$${HOOK_ENV_SESSION}`);
    expect(handler.headers[HOOK_HEADER_TOKEN]).toBe(`$${HOOK_ENV_TOKEN}`);
  });

  it('allowlists both variables, without which they arrive as literal $NAME', () => {
    /**
     * Claude will not interpolate an environment variable into a header unless
     * it is named here. Omitted, the receiver sees the literal string `$HIVE_…`
     * and answers 403 to everything — which looks exactly like a wrong token.
     */
    const handler = (
      settings.hooks.Stop as { hooks: { allowedEnvVars: string[] }[] }[]
    )[0]!.hooks[0]!;

    expect(handler.allowedEnvVars).toEqual([HOOK_ENV_SESSION, HOOK_ENV_TOKEN]);
  });

  /**
   * The `SessionStart` command hook (HIVE-101).
   *
   * The http handler above is subscribed to every event including this one, and
   * **`SessionStart` is the one that never arrives** — measured twice against
   * real binaries and recorded in `hook-contract.ts`. So this event, alone,
   * carries a second handler of a different type, and these assertions are what
   * stop the map builder being "simplified" back into one entry per event.
   */
  describe('the ready signal', () => {
    const withReady = hookSettings(URL, 'http://127.0.0.1:9/ready');

    it('adds a command hook to SessionStart and to nothing else', () => {
      for (const event of HOOK_EVENTS) {
        const entries = withReady.hooks[event] as { hooks: { type: string }[] }[];
        const types = entries.flatMap((entry) => entry.hooks.map((h) => h.type));

        expect(types).toEqual(
          event === 'SessionStart' ? ['http', 'command'] : ['http'],
        );
      }
    });

    it('keeps the http handler on SessionStart even though it never arrives', () => {
      /*
        Deliberate: the entry costs one key in a generated file, and a release
        that started delivering it would simply make the signal arrive twice —
        which the renderer's action already tolerates.
      */
      const [first] = withReady.hooks.SessionStart as {
        hooks: { type: string; url: string }[];
      }[];

      expect(first!.hooks[0]!.type).toBe('http');
      expect(first!.hooks[0]!.url).toBe(URL);
    });

    it('reports to the ready URL, and prints nothing while doing it', () => {
      const entries = withReady.hooks.SessionStart as {
        hooks: { type: string; command?: string }[];
      }[];
      const command = entries[1]!.hooks[0]!.command as string;

      expect(command).toContain('http://127.0.0.1:9/ready');
      /*
        A SessionStart hook's stdout is added to Claude's *context*, so silence
        here is correctness rather than tidiness — and a non-zero exit would
        surface in the session as a failure the user did not cause.
      */
      expect(command).toContain('-o /dev/null');
      expect(command).toContain('|| true');
    });

    it('writes no command hook at all when there is no ready URL', () => {
      const entries = settings.hooks.SessionStart as { hooks: unknown[] }[];

      expect(entries).toHaveLength(1);
    });
  });

  it('is serialisable — it is written to disk as JSON', () => {
    expect(() => JSON.stringify(settings)).not.toThrow();
    expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
  });
});

/**
 * The status line half (HIVE-79).
 *
 * This is the mechanism that makes the header's numbers real, and it is also
 * the one part of this file a *user* can see the effect of: `--settings` sits
 * at command-line precedence, so the entry written here replaces whatever
 * status line they configured for themselves, inside Hive sessions only.
 */
/**
 * What this file deliberately does NOT grant (HIVE-93).
 *
 * An earlier version wrote a `permissions.allow` entry here so the built-in
 * `/done` could run its `curl` without a prompt. It was moved to `allowed-tools`
 * in the generated skill's own frontmatter, and this test is what keeps it from
 * creeping back: this file merges **above** the user's own scope, so a grant
 * written here is one they can neither find among their settings nor revoke.
 */
describe('the settings file grants no permissions', () => {
  it('writes no permissions block', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-done-'));
    const path = await writeHookSettings(dir, 'http://127.0.0.1:51234/hook');

    {
      const raw = await readFile(path, 'utf8');
      const written = JSON.parse(raw) as Record<string, unknown>;

      expect(written).not.toHaveProperty('permissions');
      /*
        Asserted on the raw text too. A nested grant somewhere else in the file
        would satisfy the property check above and still be a permission the
        user never wrote.
      */
      expect(raw).not.toContain('permissions');
    }
  });

  it('authorises the curl at the skill instead, exactly', () => {
    /*
      The grant lives with the command it authorises. Exact, not a prefix:
      `…:*` would let anything be appended to the same `curl` invocation, and
      `-K` redefines the target, `-o`/`-D` write to a chosen path and
      `--upload-file` sends one — none needing a shell operator, so none caught
      by Claude Code's `&&`/`;` handling.
    */
    const command = doneCommand('http://127.0.0.1:51234/done');
    /*
      Quoted, because the rule contains a colon-space inside its `-H` arguments
      and YAML forbids that in a plain scalar. `done-skill.test.ts` is where the
      value is read back through the quoting; here it is enough that the grant
      lives in the skill and not in this file.
    */
    expect(doneSkill('http://127.0.0.1:51234/done')).toContain(
      `allowed-tools: 'Bash(${command})'`,
    );
  });
});

describe('statusLineSettings', () => {
  const scriptPath = '/Users/x/Library/Application Support/The Hive/hive/statusline.sh';

  it('runs the script through a shell, quoted', () => {
    const entry = statusLineSettings(scriptPath);

    // The macOS userData path contains a space; an unquoted argument splits on
    // it and Claude Code runs `/bin/sh /Users/x/Library/Application`.
    expect(entry?.command).toBe(`/bin/sh '${scriptPath}'`);
  });

  it('survives a path containing a single quote', () => {
    const entry = statusLineSettings("/Users/o'brien/hive/statusline.sh");

    expect(entry?.command).toBe(`/bin/sh '/Users/o'\\''brien/hive/statusline.sh'`);
  });

  it('sets a refresh interval, because the event triggers go quiet when idle', () => {
    expect(statusLineSettings(scriptPath)?.refreshInterval).toBe(
      METRICS_REFRESH_SECONDS,
    );
  });
});

describe('metricsScript', () => {
  const url = 'http://127.0.0.1:51234/statusline';
  const script = metricsScript(url);

  /**
   * The single most important property of this script, and the reason it exists
   * in this shape at all: Claude Code renders whatever a status line prints, and
   * printing these numbers would duplicate the header six inches below it.
   */
  it('writes nothing to stdout on any path', () => {
    // The response body is discarded and stderr is redirected; nothing echoes.
    expect(script).toContain('-o /dev/null');
    expect(script).toContain('2>/dev/null');
    expect(script).not.toMatch(/^\s*(echo|printf)\b/m);
  });

  it('exits zero even when the receiver has gone away', () => {
    // The app can quit while a session keeps running. A non-zero exit would
    // surface in the user's terminal as a failing status line command.
    expect(script.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('forwards stdin as the body rather than re-encoding it', () => {
    expect(script).toContain('--data-binary @-');
  });

  it('carries both correlation headers from the pty environment', () => {
    expect(script).toContain(`${HOOK_HEADER_SESSION}: $${HOOK_ENV_SESSION}`);
    expect(script).toContain(`${HOOK_HEADER_TOKEN}: $${HOOK_ENV_TOKEN}`);
  });

  it('declines to POST at all when either variable is missing', () => {
    // An empty header is an unattributable body the receiver answers 400 to.
    expect(script).toContain(`[ -n "$${HOOK_ENV_SESSION}" ] || exit 0`);
    expect(script).toContain(`[ -n "$${HOOK_ENV_TOKEN}" ] || exit 0`);
  });

  it('bounds the request, because it runs on a timer per live session', () => {
    expect(script).toContain('-m 5');
  });

  it('bakes in the URL rather than adding a variable to every pty', () => {
    expect(script).toContain(`'${url}'`);
  });
});


/**
 * The status line is the half that can be switched off (HIVE-79).
 *
 * Hooks and metrics share a file and a receiver, but only one of them has a
 * visible cost inside the terminal: Claude Code drops most of its footer
 * keyboard hints for *any* configured status line, whether or not it renders
 * anything. A user who would rather keep those hints than see the header's
 * gauges is making a reasonable trade, and this is what lets them.
 */
describe('writeHookSettings', () => {
  it('omits statusLine entirely when no metrics URL is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-settings-'));

    const path = await writeHookSettings(dir, 'http://127.0.0.1:1234/hook');
    const written = JSON.parse(await readFile(path, 'utf8')) as {
      hooks: unknown;
      statusLine?: unknown;
    };

    // The hooks half is unaffected — the two are separable, not coupled.
    expect(written.hooks).toBeDefined();
    expect(written).not.toHaveProperty('statusLine');
  });

  it('writes both halves when one is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-settings-'));

    const path = await writeHookSettings(
      dir,
      'http://127.0.0.1:1234/hook',
      'http://127.0.0.1:1234/statusline',
    );
    const written = JSON.parse(await readFile(path, 'utf8')) as {
      hooks: unknown;
      statusLine?: { type: string; command: string };
    };

    expect(written.hooks).toBeDefined();
    expect(written.statusLine?.type).toBe('command');
    expect(written.statusLine?.command).toContain('statusline.sh');
  });

  it('never reads or writes anything outside the directory it was given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-settings-'));

    const path = await writeHookSettings(
      dir,
      'http://127.0.0.1:1234/hook',
      'http://127.0.0.1:1234/statusline',
    );

    // The user's own ~/.claude/settings.json is theirs; this module has no
    // business anywhere near it.
    expect(path.startsWith(dir)).toBe(true);
  });

  /**
   * One file, and Claude's theme in it is an **`-ansi`** one (HIVE-82).
   *
   * This was two files, one per theme, because the theme was pinned at spawn
   * and a toggle must not reach backwards into a session already reading one.
   *
   * The assertion is on the literal value rather than on "not dark and not
   * light", because the `-ansi` part is the whole mechanism: under it Claude
   * emits ANSI indices instead of 24-bit colour, and an index is what xterm
   * resolves against the active palette at paint time. Pinning `dark` or
   * `light` here would compile, pass a negative assertion, and silently restore
   * the bug — including for scrollback, which truecolor can never repaint.
   */
  it('writes one file, pinning Claude to an indexed palette', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-settings-'));

    const path = await writeHookSettings(
      dir,
      'http://127.0.0.1:1234/hook',
      'http://127.0.0.1:1234/statusline',
    );

    const written = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;

    expect(written.theme).toBe(CLAUDE_THEME);
    expect(written.theme).toBe('dark-ansi');
  });

  /**
   * The agent view is off in every session, whatever else the file says.
   *
   * `←` is the app's own "back to the orchestrator" key, and Claude Code binds
   * the same key at an empty prompt to its own agent list — a second fleet view
   * inside one tab of the first. `keymap.ts` races for that keystroke; this
   * removes what it is racing for. Verified against Claude Code 2.1.228: the
   * footer's `← 2 agents` affordance disappears and a bare `←` does nothing.
   */
  it('disables the agent view', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hive-settings-'));

    const path = await writeHookSettings(dir, 'http://127.0.0.1:1234/hook');

    const written = JSON.parse(await readFile(path, 'utf8')) as {
      disableAgentView?: boolean;
    };
    expect(written.disableAgentView).toBe(true);
  });
});
