import { shellQuote } from '@main/sessions/shell-quote';
import { ENV_PLACEHOLDER } from '@shared/config-contract';

/**
 * Where a container project's expanded environment goes in its command.
 *
 * A placeholder rather than an append, because argument order is the runtime's
 * to decide and appending is wrong for the commonest one:
 * `docker exec [OPTIONS] CONTAINER COMMAND` requires options *before* the
 * container name, so `docker exec -it devbox -e FOO=bar claude` runs
 * `-e FOO=bar claude` **inside** the container rather than setting anything.
 *
 * Keeping it in `claudeCommand` rather than moving the invocation into the
 * container block is what preserves the free-form promise: a user wanting a
 * fresh container per session writes `docker run --rm … {env} … claude` and
 * needs no code change.
 */
// Re-exported so this module's own callers need one import, not two.
export { ENV_PLACEHOLDER };

/**
 * One argument per variable, spelled by `template`.
 *
 * The template is the runtime's vocabulary — `-e {name}={value}` for docker and
 * podman, something else elsewhere — so its own text is emitted verbatim and
 * only the two placeholders are substituted.
 *
 * **The value is quoted; the name is not.** A name reaches here from one of two
 * places, and both already constrain it to `ENV_NAME` (`config/parse.ts` for a
 * hand-edited file, `assertEnv` in `guards.ts` for the IPC path), so there is
 * nothing in it to quote. A value is arbitrary user text and gets the full
 * treatment — without it a value containing a space would split into two
 * arguments and the rest of the command line would shift by one.
 */
export function expandEnvArgs(
  env: Record<string, string>,
  template: string,
): string {
  return Object.entries(env)
    .map(([name, value]) =>
      template.replaceAll('{name}', name).replaceAll('{value}', shellQuote(value)),
    )
    .join(' ');
}

/**
 * Put `args` where the command asks for them, or refuse.
 *
 * `null` means the command has no {@link ENV_PLACEHOLDER}, which is fatal
 * rather than cosmetic: none of `HIVE_SESSION_ID`, `HIVE_HOOK_TOKEN` or
 * `HIVE_RECEIVER_URL` would reach the container, so every hook, ledger and
 * `/done` call from that session would 403 with nothing to say why. The caller
 * turns this into a diagnostic; it must never be silently spawned.
 *
 * Every occurrence is substituted rather than only the first. One placeholder
 * is the supported shape; a second repeats the expansion, which the settings
 * preview shows plainly, and is the user's to fix.
 *
 * The trailing space is swallowed when there is nothing to expand, so an empty
 * environment does not leave a gap in the middle of the preview.
 */
export function substituteEnv(command: string, args: string): string | null {
  if (!command.includes(ENV_PLACEHOLDER)) return null;

  if (args === '') {
    return command.replaceAll(`${ENV_PLACEHOLDER} `, '').replaceAll(ENV_PLACEHOLDER, '');
  }

  return command.replaceAll(ENV_PLACEHOLDER, args);
}
