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
]);

/**
 * Variables removed by prefix.
 *
 * - `ELECTRON_*` — internal wiring, never meaningful to a user shell.
 * - `GDK_PIXBUF_*`, `CHROME_*` — Chromium sandbox/runtime leakage.
 */
const DENY_PREFIX = ['ELECTRON_', 'GDK_PIXBUF_', 'CHROME_'];

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
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || isDenied(key)) continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(injected)) {
    if (isDenied(key)) continue;
    env[key] = value;
  }

  env.TERM = TERM;
  env.COLORTERM = COLORTERM;
  env.PWD = cwd;

  return env;
}
