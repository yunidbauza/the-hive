import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import {
  JIRA_TOKEN_ENV,
  type JiraCredentialState,
} from '../../../shared/jira-contract';

import { parseCredential, readEnvToken, type ParsedCredential } from './env';

/**
 * The Jira credential (HIVE-67) — the only module in the app that ever sees a
 * token.
 *
 * ## Why this app stores a secret when `gh.ts` refuses to
 *
 * `gh.ts` stores no token, and its header says why: nothing read one, so it
 * would have been "a credential no code reads, living in a plaintext file the
 * product encourages the user to hand-edit."
 *
 * Both halves stop being true here. Something reads this one — the WORK tab —
 * and it is not going in `~/.hive/config.json`. That file is deliberately
 * hand-editable: `HIVE_CONFIG_PATH` relocates it, story 107 shipped a verb that
 * reveals it in the file manager, and `config-contract.ts` keeps an
 * `UNSAFE_ENV_KEYS` deny-list precisely because users edit it. So the token goes
 * to `safeStorage`, which encrypts against a key the OS holds — Keychain on
 * macOS, DPAPI on Windows, libsecret on Linux — and the ciphertext lives in its
 * own file under `userData`.
 *
 * ## Why both dependencies are injected
 *
 * The same reason `gh.ts` takes its `RunCommand` (gh.ts:49-58): what is worth
 * testing is the decision logic, and a unit test that reached a real keychain
 * would answer differently on every machine and prompt for a password on some.
 *
 * ## What never happens here
 *
 * {@link JiraAuth.token} is main-internal. No IPC verb returns it, no channel
 * carries it, and {@link JiraAuth.state} is assembled from names and kinds
 * rather than from anything the token touched. The unit test asserts that by
 * deep-scanning the serialised state, because it is the invariant most easily
 * lost in a refactor.
 */

/** The slice of Electron's `safeStorage` this module uses. */
export interface SecretStore {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

/** The ciphertext file, as a seam. */
export interface SecretFile {
  /** The bytes, or `null` when there is no file. Never throws on ENOENT. */
  read(): Buffer | null;
  write(bytes: Buffer): void;
  clear(): void;
}

export interface JiraAuth {
  /** What to tell the renderer. Never contains the token. */
  state(email: string | null): JiraCredentialState;
  /** Whether this machine can encrypt at all. Distinct from the state. */
  encryptionAvailable(): boolean;
  /**
   * **Main-internal.** There is no IPC verb that reaches this.
   *
   * Parsed, not raw: the value may be `email:token` from either source, and the
   * caller needs the halves apart to build a Basic header. See `env.ts`.
   */
  credential(): ParsedCredential | null;
  /** Throws when encryption is unavailable, rather than writing plaintext. */
  save(token: string): void;
  clear(): void;
}

/**
 * Why the reason is a sentence rather than a code.
 *
 * The only realistic reader is a Linux user whose session has no keyring, and
 * the actionable half of that sentence is the variable name — so the pane shows
 * this string verbatim instead of translating a code back into it.
 */
const NO_ENCRYPTION =
  `This system has no keyring available to encrypt with, so no token can be ` +
  `stored. Set ${JIRA_TOKEN_ENV} in this app's environment instead.`;

export function createJiraAuth(deps: {
  store: SecretStore;
  file: SecretFile;
  env: NodeJS.ProcessEnv;
}): JiraAuth {
  const { store, file, env } = deps;

  /**
   * Presence, and the value only where a request actually needs it.
   *
   * An exported-but-empty variable reads as unset — the same false positive
   * `gh.ts:96-107` avoids on a very common shell-profile pattern, where a
   * profile exports a variable it never assigns.
   */
  const envToken = (): string | null => readEnvToken(env);

  const stored = (): string | null => {
    const bytes = file.read();
    if (bytes === null) return null;
    try {
      return store.decryptString(bytes);
    } catch {
      /**
       * Ciphertext this machine cannot read — a copied `userData`, a rotated OS
       * key, a truncated write.
       *
       * Reported as *no credential* rather than as an error. The user's fix is
       * to paste the token again, which is exactly what the `none` state
       * offers; an error banner would send them looking for a problem they
       * cannot solve.
       */
      return null;
    }
  };

  return {
    encryptionAvailable: () => store.isEncryptionAvailable(),

    /**
     * Parsed at read time rather than at save time, and for both sources.
     *
     * The `email:token` form is what a user has on their clipboard, so it will
     * be pasted into the field as often as it is exported — normalising here
     * means the field and the variable behave the same way, and that what is
     * stored stays byte-identical to what the user gave us.
     */
    credential() {
      const raw = stored() ?? envToken();
      return raw === null ? null : parseCredential(raw);
    },

    state(email) {
      if (stored() !== null) {
        return { kind: 'stored', email: email ?? '' };
      }
      if (envToken() !== null) {
        return { kind: 'env', variable: JIRA_TOKEN_ENV };
      }
      /**
       * Only reached when there is no credential at all.
       *
       * A machine that cannot encrypt but has the variable set is an `env`
       * machine that also reports `encryptionAvailable: false` — the pane needs
       * both facts, and folding them into one union member would mean a fifth
       * kind whose only job is to be a conjunction.
       */
      if (!store.isEncryptionAvailable()) {
        return { kind: 'unavailable', reason: NO_ENCRYPTION };
      }
      return { kind: 'none' };
    },

    save(token) {
      // Refusing is the correct behaviour. Writing a base64 blob and calling it
      // encrypted would be worse than storing nothing, because the user would
      // believe it was protected.
      if (!store.isEncryptionAvailable()) throw new Error(NO_ENCRYPTION);
      file.write(store.encryptString(token));
    },

    clear() {
      file.clear();
    },
  };
}

/**
 * The real file seam.
 *
 * `0600` at creation and re-asserted on every write. The ciphertext is useless
 * without the OS key, so the mode is not what protects it — but a
 * world-readable secrets file is the kind of thing that outlives the reasoning
 * behind it, and the next person to look will not re-derive that argument.
 */
export function credentialFile(path: string): SecretFile {
  return {
    read() {
      try {
        return readFileSync(path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw cause;
      }
    },
    write(bytes) {
      writeFileSync(path, bytes, { mode: 0o600 });
      // `writeFileSync`'s mode applies only when it creates the file, so an
      // existing one keeps whatever mode it had. Re-asserting is one syscall.
      chmodSync(path, 0o600);
    },
    clear() {
      rmSync(path, { force: true });
    },
  };
}
