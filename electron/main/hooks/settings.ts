import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_EVENTS,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
} from '@shared/hook-contract';
import { METRICS_REFRESH_SECONDS } from '@shared/metrics-contract';
import { SESSION_THEMES, type SessionTheme } from '@shared/session-contract';

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

/**
 * The directory both settings files and the status line script live in.
 *
 * Named as a directory rather than kept as a `HOOK_SETTINGS_FILE` pointing at
 * one of the two, which is what it briefly was: a constant called "the settings
 * file" that silently meant *the dark one* is a trap for the next caller, and
 * the only thing this value is actually used for is `mkdir`. Paths come from
 * {@link hookSettingsFile}, which cannot be read without picking a theme.
 */
export const HOOK_SETTINGS_DIR = 'hive';

/**
 * Where the files live inside userData — one per theme.
 *
 * Two files rather than one rewritten in place, because the theme is decided
 * per **spawn** and the file has to still be true for every session already
 * reading it. Rewriting would make a theme toggle reach backwards into sessions
 * that started under the other one, on a file whose other half — the hooks — is
 * load-bearing. Two immutable files cost one extra `writeFile` per launch and
 * make the choice a matter of which path goes on the command line. See
 * {@link hookSettingsFile}.
 */
export const hookSettingsFile = (theme: SessionTheme): string =>
  join(HOOK_SETTINGS_DIR, `claude-hooks.settings.${theme}.json`);

/** The status line script, beside the settings files that name it. */
export const METRICS_SCRIPT_FILE = join(HOOK_SETTINGS_DIR, 'statusline.sh');

/** Both settings files, by the theme each one dresses a session in. */
export type HookSettingsPaths = Record<SessionTheme, string>;

export interface HookSettings {
  hooks: Record<string, unknown[]>;
  statusLine?: {
    type: 'command';
    command: string;
    refreshInterval: number;
  };
  /**
   * Claude Code's own UI theme, which the Hive sets to match the app's.
   *
   * The terminal's palette already follows the app theme — `ansi.ts` owns that
   * — but a palette only decides what the *named* colours mean. Claude Code
   * paints its own chrome with explicit colours from this setting, so in the
   * app's light theme a dark-themed Claude drew the user's own prompt as a
   * near-black bar across a white terminal. Measured against 2.1.228: the
   * submitted-prompt row is `#373737` under `dark` and `#f0f0f0` under `light`.
   */
  theme?: SessionTheme;
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
export function hookSettings(url: string, theme?: SessionTheme): HookSettings {
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

  return {
    hooks: Object.fromEntries(
      HOOK_EVENTS.map((event) => [event, [{ matcher: '*', hooks: [handler] }]]),
    ),
    /*
      Unconditional, where `theme` is optional. The agent view is wrong for
      every Hive session regardless of how it was started or what the app looks
      like; the theme is a match to something the app knows and a caller may
      not. See the two fields on `HookSettings` for what each one costs.
    */
    disableAgentView: true,
    ...(theme === undefined ? {} : { theme }),
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
): Promise<HookSettingsPaths> {
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

  const paths = {} as HookSettingsPaths;

  for (const theme of SESSION_THEMES) {
    const path = join(userDataPath, hookSettingsFile(theme));
    const settings = hookSettings(url, theme);
    if (statusLine !== undefined) settings.statusLine = statusLine;
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    paths[theme] = path;
  }

  return paths;
}
