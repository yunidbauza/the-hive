import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_EVENTS,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
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

/** Where the file lives inside userData. */
export const HOOK_SETTINGS_FILE = join('hive', 'claude-hooks.settings.json');

/** The status line script, beside the settings file that names it. */
export const METRICS_SCRIPT_FILE = join('hive', 'statusline.sh');

export interface HookSettings {
  hooks: Record<string, unknown[]>;
  statusLine?: {
    type: 'command';
    command: string;
    refreshInterval: number;
  };
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
export function hookSettings(url: string): HookSettings {
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
 * Write the settings file and its script, and return the settings path.
 *
 * The script is written **first**. A settings file naming a script that is not
 * there yet is a window in which every session's status line fails; the reverse
 * — a script nothing points at — is inert.
 *
 * `metricsUrl` is optional so a caller that only wants hooks can have them. In
 * practice both come from the same receiver, but the settings file is the one
 * artifact a session sees and it should not become all-or-nothing.
 */
export async function writeHookSettings(
  userDataPath: string,
  url: string,
  metricsUrl?: string,
): Promise<string> {
  const path = join(userDataPath, HOOK_SETTINGS_FILE);
  await mkdir(dirname(path), { recursive: true });

  const settings = hookSettings(url);

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
    settings.statusLine = statusLineSettings(scriptPath);
  }

  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return path;
}
