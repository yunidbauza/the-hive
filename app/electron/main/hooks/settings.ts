import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  HOOK_ENV_SESSION,
  HOOK_ENV_TOKEN,
  HOOK_EVENTS,
  HOOK_HEADER_SESSION,
  HOOK_HEADER_TOKEN,
} from '@shared/hook-contract';

/**
 * The settings file the app hands every session (HIVE-62).
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

export interface HookSettings {
  hooks: Record<string, unknown[]>;
}

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

/** Write the settings file and return its path. */
export async function writeHookSettings(
  userDataPath: string,
  url: string,
): Promise<string> {
  const path = join(userDataPath, HOOK_SETTINGS_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(hookSettings(url), null, 2)}\n`, 'utf8');
  return path;
}
