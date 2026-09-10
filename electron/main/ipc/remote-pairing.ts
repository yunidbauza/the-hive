import { parseRemotePairRequest } from '@shared/guards';

import { NO_ENCRYPTION_REASON, type TokenStore } from '../../remote-client/token-store';

/**
 * Everything `remote:pair` and `remote:forget` do, in the one place both
 * surfaces that answer them can reach (HIVE-153).
 *
 * ## Why this is a module and not two handler bodies
 *
 * The same reason `set-remote.ts` is one, arriving through the same door.
 * Both channels **read or change this process's own identity** — which device
 * this machine is when it dials someone else's Hive, and whether it still
 * holds the secret to dial with — so by `PROCESS_LOCAL`'s own membership test
 * they must be answered here, never forwarded. While they were proxied, a
 * Forget click on an attached client cleared the *server's* credential:
 * the far machine's own pairing revoked from the near machine's UI, and the
 * clicking user's credential left untouched. HIVE-144 hid the button rather
 * than fixing the routing, which held only for as long as `src/` had exactly
 * one caller.
 *
 * `PROCESS_LOCAL` means `registerRemoteProxy` has to answer them too, from a
 * process whose `registerIpcHandlers` closure — and the `remoteTokenStore` in
 * it — is gone. So the bodies moved here rather than being copied into the
 * proxy: two spellings of one verb are free to drift, and the direction they
 * would drift in is a machine that forgets a different credential depending
 * on which mode it was in when it asked.
 *
 * ## What travels, and what is passed in
 *
 * The guard and the refusal sentence travel, because they are module imports
 * with no Electron behind them. The store does not: it is built from
 * `app.getPath('userData')`, which is answerable only after the app exists.
 * It arrives as an argument for the same reason `applySetRemote` takes its
 * switcher as one — and callers must build it through
 * `remoteCredentialStore()` rather than composing their own, which is that
 * factory's own rule: a second spelling of the filename is a credential
 * written to one path and looked for at another.
 *
 * Neither function reaches `./index` or `./router`, which is what keeps this
 * module out of the `import/no-cycle` bind — `router.ts` imports it, and it
 * imports nothing back.
 */

/**
 * Store the credential this machine will dial someone else's Hive with.
 *
 * The boolean out of {@link TokenStore.write} is surfaced as `{ error }`
 * rather than swallowed: `write` no-ops on a machine with no usable keyring,
 * and a bare success return let a pairing dialog report a credential that was
 * never written. That distinction is the handler's whole reason for having a
 * return type at all.
 *
 * Throws `IpcValidationError` on a malformed payload, exactly as the handler
 * it replaces did — a thrown guard is what becomes an `error` frame, and the
 * shape of a pairing request is not something to be lenient about.
 */
export function applyRemotePair(
  payload: unknown,
  store: TokenStore,
): { paired: true } | { error: string } {
  const { deviceId, token } = parseRemotePairRequest(payload);
  const stored = store.write(deviceId, token);
  if (stored) return { paired: true };
  return { error: NO_ENCRYPTION_REASON };
}

/**
 * Discard the credential {@link applyRemotePair} stored. Idempotent, and takes
 * no payload — there is exactly one credential on this machine to forget,
 * never a name to disambiguate by, which is what separates this from
 * `server:revoke`.
 *
 * **It does not disturb an open socket.** A server authenticates a client at
 * the handshake and never again, so forgetting while attached leaves the
 * current attachment live and costs the *next* dial instead. That is stated in
 * the pane rather than guarded against: refusing the verb here would put back
 * the unreachability HIVE-144 settled for, and detaching on the user's behalf
 * would make Forget mean two things.
 */
export function applyRemoteForget(store: TokenStore): void {
  store.clear();
}
