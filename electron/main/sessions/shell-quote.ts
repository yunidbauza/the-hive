/**
 * Wrap a value in single quotes, escaping any it contains.
 *
 * Extracted from `bootstrap.ts` in HIVE-133 so `container-command.ts` can share
 * it. Importing it from `bootstrap.ts` instead would be a cycle: `bootstrap.ts`
 * imports `container-command.ts` to build a container project's command line.
 *
 * `'\''` is the POSIX idiom — close the quote, escape a literal one, reopen —
 * and it is what makes a path or an environment value safe to type into a login
 * shell no matter what it contains.
 */
export const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;
