/**
 * Environment sanitisation for spawned shells (story 092).
 *
 * **The non-obvious part of making a terminal real.** A child must not inherit
 * Electron's process environment verbatim: Electron sets variables that break
 * or confuse child processes, and a shell spawned from a `utilityProcess`
 * inherits several that make no sense for it.
 *
 * This is the bug class that produces "it works in my terminal but not in the
 * app", and it is invisible until something downstream behaves strangely — a
 * `node` that silently runs with different options, an `electron` invocation
 * that turns itself into a Node process. It gets a dedicated conformance
 * assertion in story 098.
 */

import {
  SESSION_ENV_KEYS,
  SESSION_ENV_PREFIXES,
} from '@shared/config-contract';

/**
 * Variables removed by exact name.
 *
 * `ELECTRON_RUN_AS_NODE` is also caught by the `ELECTRON_` prefix below; it is
 * named anyway because it is the single most damaging one to inherit — a child
 * that itself launches Electron silently becomes a Node process instead.
 */
const DENY_EXACT = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  /**
   * `NODE_PATH` is not in the story's list, and it should be.
   *
   * Electron's launcher sets it to Electron's *own* bundled `node_modules`.
   * Inheriting it means a `node` the user runs in their terminal resolves
   * modules out of Electron's tree instead of their project's — the same
   * invisible behaviour change `NODE_OPTIONS` is on this list for. It showed
   * up the first time a real shell was spawned and its environment read back.
   */
  'NODE_PATH',
  /**
   * `CLAUDECODE` marks a process as running *inside* a Claude Code session.
   *
   * It is the one session marker the `CLAUDE_` prefix below cannot catch —
   * there is no underscore in it — so this entry is load-bearing rather than
   * belt-and-braces, and removing it as redundant would reopen the leak.
   *
   * Spread from the shared list rather than spelled out here: the config layer
   * refuses these names and this layer strips them, and two hand-maintained
   * copies of the same list is how the message row and the terminal drifted
   * apart in HIVE-65.
   */
  ...SESSION_ENV_KEYS,
]);

/**
 * Variables removed by prefix.
 *
 * - `ELECTRON_*` — internal wiring, never meaningful to a user shell.
 * - `GDK_PIXBUF_*`, `CHROME_*` — Chromium sandbox/runtime leakage.
 * - `CLAUDE_*` — the most consequential entry on this list for this app in
 *   particular, for the reason the rest of this comment gives.
 *
 * ## Why `CLAUDE_*` is stripped, and why it matters more here than anywhere else
 *
 * Launch The Hive from a terminal that is *itself* inside a Claude Code session
 * — `pnpm desktop:dev` typed into one, which is exactly how it gets developed —
 * and Electron inherits that session's variables: `CLAUDE_CODE_SESSION_ID`,
 * `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDECODE=1`, and the rest. Every pty then
 * hands them to `claude`, and every agent The Hive spawns **joins the launching
 * session instead of starting its own**.
 *
 * The symptoms are bizarre until the cause is known, and were all observed:
 *
 * - Every new session opened already carrying the launching session's display
 *   name, ignoring the `--name` the app passed it.
 * - Renaming any one session renamed *all* of them, and the developer's own
 *   outer session along with them, because there was only ever one session.
 * - `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`
 *   in sessions nobody had configured that way.
 *
 * This is the same bug class the module comment above describes — "it works in
 * my terminal but not in the app" — but inverted and much worse: it works in a
 * plain terminal and breaks only when launched from the environment its own
 * developers use. Nothing about the app's own behaviour is wrong; it is asking
 * a `claude` that has already been told it is part of somebody else's
 * conversation to be a session of its own.
 *
 * Stripping here is the right layer and is not lossy. `buildEnv` seeds from the
 * *ambient* environment, and sessions run a **login shell**, so any `CLAUDE_*`
 * the user genuinely exports from their own profile is re-established by that
 * shell. What is removed is only the leakage from however the app happened to
 * be started.
 *
 * The one thing this layer must not do alone is swallow a value the user set
 * *deliberately*. `buildEnv` applies the deny-list to `injected` as well as to
 * the ambient copy, so a `CLAUDE_*` entry in a project's runtime settings would
 * be discarded on every spawn with nothing said. That is why the names live in
 * `@shared/config-contract` and `unsafeEnvReason` refuses them at the point
 * they are typed: stripped here, but never *silently* — a setting that vanishes
 * is worse than one that names itself.
 */
const DENY_PREFIX = [
  'ELECTRON_',
  'GDK_PIXBUF_',
  'CHROME_',
  ...SESSION_ENV_PREFIXES,
];

/**
 * The single most consequential option in the whole story.
 *
 * `TERM` is how every program in the terminal decides what it may emit. Get it
 * wrong and colours silently vanish or garbage appears.
 */
export const TERM = 'xterm-256color';

/**
 * Advertises 24-bit colour.
 *
 * The palette in `src/lib/terminal/ansi.ts` is truecolor SGR (story 011), and
 * without this some tools quantise to 256 — a difference nobody notices until
 * the app's own colours look subtly wrong next to the same tool in iTerm.
 */
export const COLORTERM = 'truecolor';

const isDenied = (key: string): boolean =>
  DENY_EXACT.has(key) || DENY_PREFIX.some((prefix) => key.startsWith(prefix));

/**
 * Build the child's environment.
 *
 * Start from a copy of the base environment, delete the deny-list, apply
 * whatever main asked for explicitly, then force `TERM`, `COLORTERM` and
 * `PWD`. Those three are last on purpose: they are the terminal's identity,
 * and an injected override of `TERM` is far more likely to be a mistake than
 * an intention.
 */
export function buildEnv(
  base: NodeJS.ProcessEnv,
  cwd: string,
  injected: Record<string, string> = {},
  stripEnv: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  /**
   * The caller's names, on top of this module's own.
   *
   * Separate from {@link DENY_EXACT} rather than merged into it, and the
   * distinction is worth keeping: everything on that list is removed because
   * inheriting it *breaks* a child process, which is a fact about the
   * environment. This list is whatever main was told to drop by the user's
   * config, which is a preference — see `AUTH_ENV_KEYS`.
   *
   * Applied to `injected` as well as to the ambient copy, exactly as the deny
   * list is. A project that could re-add a name the user asked to have removed
   * would make the setting silently conditional on which project was open.
   */
  const stripped = new Set(stripEnv);
  const isRemoved = (key: string): boolean => isDenied(key) || stripped.has(key);

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || isRemoved(key)) continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(injected)) {
    if (isRemoved(key)) continue;
    env[key] = value;
  }

  env.TERM = TERM;
  env.COLORTERM = COLORTERM;
  env.PWD = cwd;

  return env;
}
