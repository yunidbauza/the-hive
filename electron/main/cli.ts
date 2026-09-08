/**
 * Server-mode invocation parsing (HIVE-142).
 *
 * Split from `index.ts` so it can be driven directly in a unit test, the way
 * `lifecycle.ts` is: asserting argv handling through a real Electron boot
 * would be slow and indirect, and this module has nothing Electron-specific
 * in it — no `electron` import, not even a type import.
 */

export type Invocation =
  | { kind: 'app'; server: boolean }
  | { kind: 'pair'; name: string }
  | { kind: 'revoke'; name: string }
  | { kind: 'devices' }
  | { kind: 'usage'; message: string };

/**
 * Every flag this parser recognizes. Used to reject a `--pair`/`--revoke`
 * name that is actually the *next* flag rather than a real name — e.g.
 * `--pair --devices` with no name supplied. We only special-case these four
 * known flags rather than "anything starting with `-`": a device legitimately
 * named `--devices` is not a real scenario, but neither is one merely
 * *starting* with a dash, so there is no case here worth the extra rule.
 */
const KNOWN_FLAGS = ['--pair', '--revoke', '--devices', '--server'];

/**
 * Parse `process.argv` into a typed `Invocation`.
 *
 * `packaged` (from `app.isPackaged`) says how many leading elements are the
 * executable rather than arguments: a packaged launch is `[exe, ...args]`,
 * a dev launch is `[electron, appPath, ...args]`. Slicing by this rather than
 * scanning the whole array matters because argv[0] (or argv[1] in dev) can be
 * a filesystem path — an app installed under a folder literally named
 * `--server` must not be mistaken for the flag.
 *
 * Chromium/Electron switches (e.g. `--user-data-dir=/tmp/x`) may also appear
 * in argv; since we only ever look for our own known flags, anything else is
 * silently ignored rather than tripping up the parse.
 */
export function parseInvocation(argv: readonly string[], packaged: boolean): Invocation {
  const args = argv.slice(packaged ? 1 : 2);

  // Precedence when several command flags are present together is
  // deliberate: --pair > --revoke > --devices > --server, independent of
  // their order in argv. Each branch below returns before the next is
  // even inspected.
  const pairIndex = args.indexOf('--pair');
  if (pairIndex !== -1) {
    const name = args[pairIndex + 1];
    if (!name || KNOWN_FLAGS.includes(name)) {
      return {
        kind: 'usage',
        message: 'Usage: the-hive --pair "<device name>"\nA device name is required.',
      };
    }
    return { kind: 'pair', name };
  }

  const revokeIndex = args.indexOf('--revoke');
  if (revokeIndex !== -1) {
    const name = args[revokeIndex + 1];
    if (!name || KNOWN_FLAGS.includes(name)) {
      return {
        kind: 'usage',
        message: 'Usage: the-hive --revoke "<device name>"\nA device name is required.',
      };
    }
    return { kind: 'revoke', name };
  }

  if (args.includes('--devices')) {
    return { kind: 'devices' };
  }

  return { kind: 'app', server: args.includes('--server') };
}
