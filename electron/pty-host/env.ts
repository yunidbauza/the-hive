import { TERM, COLORTERM, buildSessionEnv } from '@shared/config-contract';

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
 *
 * The actual construction — `TERM`/`COLORTERM`/`PWD`, the deny lists, the
 * `CLAUDE_*` session-marker strip — moved to `@shared/config-contract`'s
 * `buildSessionEnv` in story 108's fix round, because the env diagnostic runs
 * in **main**, which may not import `electron/pty-host/**`, and had been
 * building a slightly different environment by hand. One definition with two
 * consumers cannot drift. `TERM` and `COLORTERM` are re-exported here so
 * nothing that already imports them from this module has to change.
 */

export { TERM, COLORTERM };

/** Build the child's environment. See `buildSessionEnv` for the actual logic. */
export function buildEnv(
  base: NodeJS.ProcessEnv,
  cwd: string,
  injected: Record<string, string> = {},
  stripEnv: readonly string[] = [],
): Record<string, string> {
  return buildSessionEnv(base, cwd, injected, stripEnv);
}
