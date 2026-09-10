import { IpcValidationError, assertText } from '@shared/guards';

/**
 * Server-mode invocation parsing (HIVE-142).
 *
 * Split from `index.ts` so it can be driven directly in a unit test, the way
 * `lifecycle.ts` is: asserting argv handling through a real Electron boot
 * would be slow and indirect, and this module has nothing Electron-specific
 * in it — no `electron` import, not even a type import. `@shared/guards` is
 * fine to pull in here for the same reason it is fine in `one-shot.ts`'s own
 * `@shared/config-contract` import: nothing in `electron/shared/` reaches
 * into `electron` itself.
 */

export type Invocation =
  | { kind: 'app'; server: boolean }
  | { kind: 'pair'; name: string }
  | { kind: 'revoke'; name: string }
  | { kind: 'devices' }
  | { kind: 'update' }
  | { kind: 'usage'; message: string };

/**
 * Every flag this parser recognizes. Used to reject a `--pair`/`--revoke`
 * name that is actually the *next* flag rather than a real name — e.g.
 * `--pair --devices` with no name supplied. We only special-case these four
 * known flags rather than "anything starting with `-`": a device legitimately
 * named `--devices` is not a real scenario, but neither is one merely
 * *starting* with a dash, so there is no case here worth the extra rule.
 */
const KNOWN_FLAGS = ['--pair', '--revoke', '--devices', '--update', '--server'];

/**
 * Trims and validates a device name the same way both other pairing surfaces
 * do before it ever reaches `mintDevice` (HIVE-142 review, M1): the Settings
 * pane trims (`server-mode-group.tsx`'s `handlePair`), and the IPC guard runs
 * `assertText` (`parsePairDeviceRequest`). This CLI path had neither, so
 * `--pair "   "` minted and persisted a device whose name is blank once
 * trimmed — exactly what `optionalDevices` (`config/parse.ts`) then drops on
 * every later load, leaving a token that can never authenticate anything.
 * `null` on a refusal — the caller turns that into the same `usage` shape a
 * missing name already gets.
 */
function assertDeviceName(name: string): string | null {
  const trimmed = name.trim();
  try {
    return assertText(trimmed, 'device name');
  } catch (cause) {
    if (!(cause instanceof IpcValidationError)) throw cause;
    return null;
  }
}

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
    const raw = args[pairIndex + 1];
    const name = raw && !KNOWN_FLAGS.includes(raw) ? assertDeviceName(raw) : null;
    if (name === null) {
      return {
        kind: 'usage',
        message: 'Usage: the-hive --pair "<device name>"\nA device name is required.',
      };
    }
    return { kind: 'pair', name };
  }

  const revokeIndex = args.indexOf('--revoke');
  if (revokeIndex !== -1) {
    const raw = args[revokeIndex + 1];
    const name = raw && !KNOWN_FLAGS.includes(raw) ? assertDeviceName(raw) : null;
    if (name === null) {
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

  if (args.includes('--update')) {
    return { kind: 'update' };
  }

  return { kind: 'app', server: args.includes('--server') };
}
