import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/**
 * The device credential this machine was handed when it attached to someone
 * else's Hive (HIVE-144).
 *
 * `electron/main/server/devices.ts:17-19` already states where the plaintext
 * of a paired device's token is allowed to exist: stdout at mint time, on the
 * server that minted it, and "the client's own `safeStorage` in a later
 * story." This module is that later story, for the opposite side of the same
 * credential — the device being paired *into* someone else's server, rather
 * than the server minting it.
 *
 * ## Why this is not `jira/auth.ts` or `slack/tokens.ts` with a shared helper
 *
 * The shape is deliberately close to both — a `safeStorage`-encrypted blob in
 * one file under `userData`, `null` when nothing is stored, `null` (never a
 * throw) when a copied `userData` or a rotated OS key leaves the ciphertext
 * unreadable — because it is solving the same problem they already solved.
 * Extracting a shared credential-store helper out of three call sites is
 * explicitly out of scope for HIVE-144: the ticket asks for this module on
 * its own, and a fourth abstraction shared by three two-line callers would be
 * more machinery than the problem needs.
 *
 * The one real difference from `jira/auth.ts`'s `SecretFile`/`SecretStore`
 * pair: this module takes a bare `filePath` rather than an injected file seam.
 * There is exactly one file this credential ever lives in, so the extra
 * indirection buys nothing a unit test needs — a real temp file stands in for
 * it exactly as `credentialFile`'s own tests use one.
 *
 * ## What this module is not
 *
 * It stores and returns the pair the socket handshake needs
 * (`electron/remote-client/index.ts`'s `attachRequest` takes `deviceId` and
 * `token` as plain arguments) — it does not construct an `AttachRequest`
 * itself, and it never touches `~/.hive/config.json`. `RemoteConfig` names
 * *where* to attach; this module names *who is attaching*, and the two are
 * kept apart so a config file a user is invited to hand-edit can never carry
 * a secret.
 */

/** Everything this credential is: which device this machine is, and its secret. */
export interface StoredDeviceCredential {
  deviceId: string;
  token: string;
}

export interface TokenStore {
  /**
   * `null` covers three cases the caller must not have to tell apart: no
   * credential was ever paired, `safeStorage` cannot decrypt what is on disk
   * (a copied `userData`, a rotated OS key), and encryption is unavailable on
   * this machine right now. All three mean the same thing to a settings pane:
   * there is no usable credential, offer pairing again.
   */
  read(): StoredDeviceCredential | null;
  /**
   * Overwrites whatever was stored. There is no merge arm — unlike the Slack
   * tokens, `deviceId` and `token` are minted together by one `server:pair`
   * call on the far end and are useless apart, so a partial write is never a
   * meaningful state.
   *
   * Silently does nothing when encryption is unavailable, for the same
   * reason {@link TokenStore.read} answers `null` rather than throwing: this
   * is only ever reached from a renderer, which exists only after
   * `app.whenReady()`, but a locked keychain is a real state a machine can be
   * in at that point, and the settings pane should degrade rather than crash
   * a handler over a pairing attempt it could not have prevented.
   */
  write(deviceId: string, token: string): void;
  /** Idempotent, and does not depend on `safeStorage` — deleting a file needs no key. */
  clear(): void;
}

/**
 * The slice of `safeStorage` this store needs, narrowed to an interface a
 * unit test can implement without a keychain — the same reason `jira/auth.ts`
 * and `slack/tokens.ts` take theirs by injection rather than importing
 * Electron's global.
 */
export type RemoteSafeStorage = Pick<
  Electron.SafeStorage,
  'isEncryptionAvailable' | 'encryptString' | 'decryptString'
>;

export function createTokenStore(deps: {
  safeStorage: RemoteSafeStorage;
  filePath: string;
}): TokenStore {
  const { safeStorage, filePath } = deps;

  /** `null` on ENOENT, exactly as `credentialFile`'s reader does; anything else rethrows. */
  const readBytes = (): Buffer | null => {
    try {
      return readFileSync(filePath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw cause;
    }
  };

  return {
    read() {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const bytes = readBytes();
      if (bytes === null) return null;
      try {
        const parsed: unknown = JSON.parse(safeStorage.decryptString(bytes));
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed) ||
          typeof (parsed as Record<string, unknown>).deviceId !== 'string' ||
          typeof (parsed as Record<string, unknown>).token !== 'string'
        ) {
          // Bytes that decrypt but do not parse as this shape are not this
          // machine's credential — treated as absent rather than corrupt for
          // the same reason a decrypt failure is: the user's remedy is to
          // pair again, and an error banner would send them looking for a
          // problem they cannot solve.
          return null;
        }
        const { deviceId, token } = parsed as StoredDeviceCredential;
        return { deviceId, token };
      } catch {
        return null;
      }
    },

    write(deviceId, token) {
      // Refusing to write plaintext is `jira/auth.ts:save`'s rule; refusing to
      // throw over it is this module's own, because `remote:pair`'s caller is
      // always a renderer with a pairing dialog open, not a script that can
      // act on a thrown reason. A pairing attempt on a machine with no keyring
      // simply does not persist — the pane's `read()` right after will report
      // no credential, which is the true state.
      if (!safeStorage.isEncryptionAvailable()) return;
      const bytes = safeStorage.encryptString(JSON.stringify({ deviceId, token }));
      writeFileSync(filePath, bytes, { mode: 0o600 });
      // `writeFileSync`'s mode applies only when it creates the file, so an
      // existing one keeps whatever mode it had — re-asserted here for the
      // same one-syscall reason `credentialFile.write` does.
      chmodSync(filePath, 0o600);
    },

    clear() {
      rmSync(filePath, { force: true });
    },
  };
}
