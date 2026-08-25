import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_EVENTS,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
  readyCommand,
} from '@shared/hook-contract';
import { METRICS_REFRESH_SECONDS } from '@shared/metrics-contract';

/**
 * The settings file the app hands every session (HIVE-62, HIVE-79).
 *
 * ## Why a file the app owns, and not the user's
 *
 * `claude --settings <path>` *merges* what it reads on top of the user's own
 * settings, so the app can add hooks without touching
 * `~/.claude/settings.json`. That distinction is the whole design: the user's
 * configuration is theirs, it is where their own hooks and permissions live, and
 * an app that edits it has to be trusted to un-edit it on uninstall, on crash,
 * and on downgrade. This writes one file inside its own userData directory and
 * never reads or writes anything of the user's.
 *
 * `--settings` sits at **command-line precedence**, above the user scope, so a
 * key spelled in both wins here. For `hooks` that is additive and invisible. For
 * `statusLine` it is a replacement, and it is the one thing in this file a user
 * can *see* — see {@link statusLineSettings}.
 *
 * ## Why a path and not inline JSON
 *
 * `--settings` also accepts a JSON *string*. That string would be interpolated
 * into a command line a login shell parses, where its braces, quotes and colons
 * are exactly the characters `bootstrap.ts` is careful never to hand a shell
 * unescaped.
 *
 * A path is not automatically safe either, and assuming it was is how this
 * shipped broken the first time: on macOS this sits under
 * `~/Library/Application Support/`, so the unquoted argument split on the space
 * and `claude` never saw the file. `bootstrap.ts` quotes it — see `shellQuote`.
 *
 * ## Why one file per launch, not per session
 *
 * The hook configuration is identical for every session — the only per-session
 * value is the id, and that travels in the environment of the pty rather than in
 * the file. One file means no per-session cleanup, and no directory that grows
 * by one entry every time a session starts.
 */

/** The directory the settings file and the status line script live in. */
export const HOOK_SETTINGS_DIR = 'hive';

/**
 * What Claude Code's own UI is dressed in, for every session (HIVE-82).
 *
 * A constant rather than a value chosen per spawn, and that is the fix rather
 * than a simplification — see {@link HookSettings.theme}. It is spelled here so
 * the settings file and the test that pins it read the same word.
 */
export const CLAUDE_THEME = 'dark-ansi';

/**
 * Where the file lives inside userData.
 *
 * **One file, because nothing in it varies any more.** It was briefly two —
 * `claude-hooks.settings.{dark,light}.json` — because the theme was pinned per
 * spawn and a toggle must not reach backwards into a session already reading
 * one. {@link CLAUDE_THEME} removed the variation, and the pair with it.
 */
export const HOOK_SETTINGS_FILE = join(
  HOOK_SETTINGS_DIR,
  'claude-hooks.settings.json',
);

/** The status line script, beside the settings files that name it. */
export const METRICS_SCRIPT_FILE = join(HOOK_SETTINGS_DIR, 'statusline.sh');

export interface HookSettings {
  hooks: Record<string, unknown[]>;
  statusLine?: {
    type: 'command';
    command: string;
    refreshInterval: number;
  };
  /**
   * Claude Code's own UI theme, which the Hive pins to `dark-ansi` (HIVE-82).
   *
   * The terminal's palette already follows the app theme — `ansi.ts` owns that
   * — but a palette only decides what the *named* colours mean. Claude Code
   * paints its own chrome from this setting, and under `dark` or `light` it
   * paints in **24-bit** colour: measured against 2.1.245, the submitted-prompt
   * row is `rgb(55,55,55)` and `rgb(240,240,240)` respectively.
   *
   * That is what made the old arrangement unfixable. A value chosen at spawn is
   * read once and kept for the life of the process, so toggling the app left
   * every running session dressed the way it started — an `AskUserQuestion`
   * drawn in `#ffffff` on the light terminal's `#f7fafb`, which is 1.05:1. And
   * because the colours were truecolor, xterm stored the resolved RGB per cell,
   * so even re-theming the terminal could not repaint what was already on
   * screen.
   *
   * `dark-ansi` fixes both at once, and it is measured rather than assumed:
   * under it Claude emits **zero** truecolor — every colour is an ANSI index,
   * which xterm resolves against the active theme at paint time. So a Hive
   * theme toggle repaints Claude's chrome, scrollback included, with nothing
   * re-read and nothing restarted.
   *
   * **Pinned rather than paired with `light-ansi`.** Its slot choices are the
   * ones `xtermThemeFor` already resolves correctly in both modes —
   * `text: ansi:whiteBright` → `palette.ink`, which is `#dbe4ff` on dark and
   * `#2c2f34` on light. `light-ansi` would be wrong the moment the app went
   * dark: its `text: ansi:black` resolves to the palette's surface.
   *
   * The counterpart is in `ansi.ts`: `black` and `brightBlack` had to stop
   * being text colours, because that is what Claude paints its panels with.
   */
  theme?: typeof CLAUDE_THEME;
  /**
   * Claude Code's agent view, which the Hive turns off in every session.
   *
   * **The Hive is the fleet view.** Claude Code's own agent list is a second,
   * competing one inside a single tab of the first, and `←` — the app's own
   * "back to the orchestrator" key — is what opens it. `keymap.ts` intercepts
   * that key at an empty prompt, which leaves the race to be won on every
   * keystroke; this removes the thing being raced for.
   *
   * Verified against 2.1.228: with this set the footer's `← 2 agents`
   * affordance is gone and a bare `←` at the prompt does nothing at all.
   *
   * **What it costs**, and it is not nothing: the same switch disables
   * `claude agents`, `--bg`, `/background` and the on-demand daemon inside
   * these sessions. The Hive drives none of them — it spawns its own ptys and
   * watches them through hooks — so the loss is confined to a user who wanted
   * Claude Code's background agents *inside* a Hive session, which is the
   * fleet-within-a-fleet this exists to prevent.
   */
  disableAgentView?: boolean;
}

/**
 * Quote a path for a `sh -c` command line.
 *
 * The same job — and the same single-quote doubling trick — as `bootstrap.ts`'s
 * own `shellQuote`, duplicated rather than shared because that one quotes for a
 * *login shell running the bootstrap* and this one quotes for a string Claude
 * Code hands to its own shell. Two callers, two lifetimes; a shared helper would
 * suggest changing one is safe for the other.
 */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The settings body pointing Claude's hooks at a running receiver.
 *
 * Every subscribed event gets the same `http` handler. The two headers are what
 * make a POST both attributable and trusted:
 *
 * - `x-hive-session` carries the Hive's own entity id, read from the pty's
 *   environment. Correlation is the identity function rather than a lookup
 *   through Claude's uuid — see `hook-contract.ts`.
 * - `x-hive-token` carries the per-launch secret, also from the environment.
 *
 * Both are named in `allowedEnvVars`, without which Claude will not interpolate
 * them — a hook whose headers silently arrive as the literal strings `$VAR` is
 * a receiver that answers 403 to everything, which is a confusing way to
 * discover a missing field.
 */
export function hookSettings(url: string, readyUrl?: string): HookSettings {
  const handler = {
    type: 'http',
    url,
    headers: {
      [HOOK_HEADER_SESSION]: `$${HOOK_ENV_SESSION}`,
      [HOOK_HEADER_TOKEN]: `$${HOOK_ENV_TOKEN}`,
    },
    allowedEnvVars: [HOOK_ENV_SESSION, HOOK_ENV_TOKEN],
    /**
     * Short, and shorter than the hook system's default.
     *
     * This handler's answer never changes what the session does — the receiver
     * replies 204 and the agent carries on regardless — so a slow or dead
     * endpoint must not be something the user waits behind. Ten seconds is
     * generous for a loopback POST and brief enough to be invisible if the app
     * has quit while a session is still running.
     */
    timeout: 10,
  };

  /**
   * `SessionStart` carries a second handler, and it is a `command` (HIVE-101).
   *
   * Not redundancy. The http handler above is subscribed to every event and
   * **`SessionStart` is the one that never arrives** — measured, twice, and
   * recorded in `hook-contract.ts`. So the app has no http-borne way to learn
   * that Claude is up, which is precisely the moment the boot overlay needs.
   *
   * The http entry stays anyway, exactly as the note there argues: it costs one
   * key in a generated file, and a future release that starts delivering it
   * would simply make this arrive twice. The receiver is idempotent about that
   * — a session that is already up cannot become more up.
   */
  const ready =
    readyUrl === undefined
      ? []
      : [{ matcher: '*', hooks: [{ type: 'command', command: readyCommand(readyUrl) }] }];

  return {
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((event) => [
        event,
        [
          { matcher: '*', hooks: [handler] },
          ...(event === 'SessionStart' ? ready : []),
        ],
      ]),
    ),
    /*
      Unconditional, where `theme` is optional. The agent view is wrong for
      every Hive session regardless of how it was started or what the app looks
      like; the theme is a match to something the app knows and a caller may
      not. See the two fields on `HookSettings` for what each one costs.
    */
    disableAgentView: true,
    theme: CLAUDE_THEME,
    /*
      No `permissions` block, deliberately (HIVE-93). `/done`'s `curl` is
      authorised by `allowed-tools` in the generated skill's own frontmatter
      instead — see `skills/done-skill.ts`. This file merges above the user's
      scope, so a grant written here is one they can neither see among their own
      settings nor revoke; the skill's frontmatter puts the authorisation three
      lines above the command it authorises, in a file they can read.
    */
  };
}

/**
 * The status line entry, which is how usage metrics reach the header (HIVE-79).
 *
 * ## Why a script, when the hooks next door use `http`
 *
 * `receiver.ts` explains at length why hooks are an `http` handler rather than a
 * `command`: no script to ship, no path to resolve inside a packaged app, no
 * process spawn per event. **The status line offers no `http` handler at all.**
 * It is `command`-only, because its contract is "print something and I will
 * render it" — so the trade the hooks avoided is one this has to take. The cost
 * is a `curl` per session per report, which is the cadence a status line already
 * assumed.
 *
 * ## Why it prints nothing
 *
 * Claude Code renders whatever the script prints. Printing the same numbers the
 * Hive's own header is about to show would put them on screen twice, six inches
 * apart, in two different formats. A script that produces no output leaves the
 * status line blank, which is documented behaviour rather than a trick.
 *
 * **What this costs, and it is not nothing:** configuring `statusLine` at all
 * makes Claude Code drop most of its footer keyboard hints — `esc to interrupt`,
 * `? for shortcuts`, the voice-dictation hint. That is a real regression inside
 * the terminal, it applies whether the line is blank or not, and it is why the
 * whole mechanism is switchable off rather than unconditional.
 *
 * ## Why the URL is baked in rather than passed through the environment
 *
 * The port is chosen at bind time and the script is written immediately after,
 * once per launch, so the URL is known before the file exists. Threading it
 * through a third environment variable would add a value to every pty for
 * something no session needs to be able to see.
 *
 * `refreshInterval` exists because Claude Code's own triggers are event-driven
 * and go quiet exactly when a user is most likely to be *reading* the header
 * rather than typing — see {@link METRICS_REFRESH_SECONDS}.
 */
export function statusLineSettings(scriptPath: string): HookSettings['statusLine'] {
  return {
    type: 'command',
    command: `/bin/sh ${shellQuote(scriptPath)}`,
    refreshInterval: METRICS_REFRESH_SECONDS,
  };
}

/**
 * The status line script itself.
 *
 * POSIX `sh`, not bash: it is one `curl` behind three guards, and `/bin/sh`
 * exists on every platform this app runs a pty on.
 *
 * Every line of it is about **saying nothing**:
 *
 * - `curl -s -o /dev/null` with stderr discarded, so neither a response body nor
 *   a connection refusal can reach stdout and become a status line.
 * - `exit 0` unconditionally, so a receiver that has gone away — the app quit
 *   while a session kept running — is not reported in the user's terminal as a
 *   failing status line command.
 * - The three guards exit early rather than calling `curl` with empty values,
 *   which would POST an unattributable body the receiver would answer 400 to.
 *
 * `-m 5` bounds the whole request. This runs on a 30-second timer per live
 * session; a hung connection must not accumulate.
 */
export function metricsScript(url: string): string {
  return `#!/bin/sh
# The Hive — session usage reporter. Written per launch; do not edit.
# Reads Claude Code's status line payload on stdin, forwards it to the app, and
# prints nothing so no status line is rendered. See electron/main/hooks/settings.ts.
[ -n "$${HOOK_ENV_SESSION}" ] || exit 0
[ -n "$${HOOK_ENV_TOKEN}" ] || exit 0

curl -s -m 5 -o /dev/null \\
  -X POST ${shellQuote(url)} \\
  -H 'content-type: application/json' \\
  -H "${HOOK_HEADER_SESSION}: $${HOOK_ENV_SESSION}" \\
  -H "${HOOK_HEADER_TOKEN}: $${HOOK_ENV_TOKEN}" \\
  --data-binary @- 2>/dev/null

exit 0
`;
}

/**
 * Write one settings file per theme, plus the script, and return both paths.
 *
 * The script is written **first**. A settings file naming a script that is not
 * there yet is a window in which every session's status line fails; the reverse
 * — a script nothing points at — is inert.
 *
 * `metricsUrl` is optional so a caller that only wants hooks can have them. In
 * practice both come from the same receiver, but the settings file is the one
 * artifact a session sees and it should not become all-or-nothing.
 *
 * The two files differ in exactly one key. Writing both up front means the
 * spawn path never writes anything — it picks a path — so a theme toggle can
 * never race a session that is starting, and a session's settings stay the
 * bytes it was started with for as long as it runs.
 */
export async function writeHookSettings(
  userDataPath: string,
  url: string,
  metricsUrl?: string,
  readyUrl?: string,
): Promise<string> {
  await mkdir(join(userDataPath, HOOK_SETTINGS_DIR), { recursive: true });

  let statusLine: HookSettings['statusLine'];

  if (metricsUrl !== undefined) {
    const scriptPath = join(userDataPath, METRICS_SCRIPT_FILE);
    await writeFile(scriptPath, metricsScript(metricsUrl), 'utf8');
    /*
      Executable for the owner only. It is invoked as `/bin/sh <path>`, which
      does not require the bit — it is set so the file is recognisably a program
      by anyone who goes looking in userData, and `0o700` rather than `0o755`
      because nothing but this user's sessions should be running it.
    */
    await chmod(scriptPath, 0o700);
    statusLine = statusLineSettings(scriptPath);
  }

  const path = join(userDataPath, HOOK_SETTINGS_FILE);
  const settings = hookSettings(url, readyUrl);
  if (statusLine !== undefined) settings.statusLine = statusLine;
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

  return path;
}
