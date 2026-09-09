// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTokenStore,
  type RemoteSafeStorage,
  type TokenStore,
} from '../../../electron/remote-client/token-store';

/**
 * A fake `safeStorage` that actually transforms the plaintext, unlike a
 * prefix-tagging fake. Base64 is not real encryption, but it is enough to
 * make "the ciphertext on disk contains the plaintext token" a claim that is
 * false for the fake and would be false for the real `safeStorage` too — so a
 * store that skipped `encryptString` and wrote raw JSON is the one thing this
 * fake can catch that a tagging fake could not.
 */
function fakeSafeStorage(available = true): RemoteSafeStorage {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').toString('base64'), 'utf8'),
    decryptString: (cipher) => Buffer.from(cipher.toString('utf8'), 'base64').toString('utf8'),
  };
}

describe('createTokenStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-remote-cred-'));
    filePath = join(dir, 'remote-credential.bin');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function harness(opts: { available?: boolean } = {}): {
    store: TokenStore;
    written: () => string;
  } {
    const store = createTokenStore({
      safeStorage: fakeSafeStorage(opts.available ?? true),
      filePath,
    });
    return {
      store,
      written: () => {
        try {
          return readFileSync(filePath, 'utf8');
        } catch {
          return '';
        }
      },
    };
  }

  it('round-trips a token through safeStorage', () => {
    const { store } = harness();
    store.write('dev-1', 'K7QM-3XTV-9WHZ-2BNP');
    expect(store.read()).toEqual({ deviceId: 'dev-1', token: 'K7QM-3XTV-9WHZ-2BNP' });
  });

  it('never writes the plaintext to disk', () => {
    const { store, written } = harness();
    store.write('dev-1', 'K7QM-3XTV-9WHZ-2BNP');
    expect(written()).not.toContain('K7QM-3XTV-9WHZ-2BNP');
  });

  it('reads null when nothing is stored', () => {
    expect(harness().store.read()).toBeNull();
  });

  it('reads null rather than throwing when encryption is unavailable', () => {
    const { store } = harness({ available: false });
    store.write('dev-1', 'tok');
    expect(store.read()).toBeNull();
  });

  it('clear removes it', () => {
    const { store } = harness();
    store.write('dev-1', 'tok');
    store.clear();
    expect(store.read()).toBeNull();
  });

  it('clear is idempotent and needs no working keychain', () => {
    const { store } = harness({ available: false });
    expect(() => store.clear()).not.toThrow();
    expect(store.read()).toBeNull();
  });

  /**
   * Fix-round review (Important-2): `write` used to answer `void`, so
   * `remote:pair`'s handler had no way to tell the pane a locked keychain
   * silently discarded the pairing token. It now reports success as a
   * boolean, and the handler surfaces `false` as `{ error }` rather than a
   * false `{ paired: true }`.
   */
  it('write returns true on a successful persist', () => {
    const { store } = harness();
    expect(store.write('dev-1', 'tok')).toBe(true);
  });

  it('write is a silent no-op when encryption is unavailable, not a throw — and reports false', () => {
    const { store, written } = harness({ available: false });
    let result: boolean | undefined;
    expect(() => {
      result = store.write('dev-1', 'tok');
    }).not.toThrow();
    expect(result).toBe(false);
    expect(written()).toBe('');
  });

  it('writes the file owner-only, because a world-readable secrets file outlives its reasoning', () => {
    const { store } = harness();
    store.write('dev-1', 'tok');
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('a second write replaces the first rather than merging', () => {
    const { store } = harness();
    store.write('dev-1', 'first-token');
    store.write('dev-2', 'second-token');
    expect(store.read()).toEqual({ deviceId: 'dev-2', token: 'second-token' });
  });

  it('reads null for bytes that decrypt but are not this shape', () => {
    const safeStorage = fakeSafeStorage();
    const store = createTokenStore({ safeStorage, filePath });
    // Something else's ciphertext, or a truncated write — decrypts fine but
    // is not a { deviceId, token } pair.
    writeFileSync(filePath, safeStorage.encryptString('"just a string"'));
    expect(store.read()).toBeNull();
  });

  /**
   * The case the interface doc names *first* — a copied `userData`, a
   * rotated OS key — and, before this fix round, the one branch this file
   * never actually exercised: `decryptString` throwing on bytes that were
   * never this machine's ciphertext at all.
   */
  it('reads null rather than throwing when decryptString itself throws', () => {
    const safeStorage: RemoteSafeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain, 'utf8'),
      decryptString: () => {
        throw new Error('OS key rotated — this ciphertext is not this machine\'s');
      },
    };
    const store = createTokenStore({ safeStorage, filePath });
    writeFileSync(filePath, Buffer.from('anything'));

    expect(store.read()).toBeNull();
  });

  /**
   * `readBytes` rethrows anything that is not ENOENT (fix-round review):
   * `read()` used to call it *outside* its own `try`, so an EACCES or an
   * EISDIR on the credential file threw straight out of `read()`, breaking
   * the interface's "never throws" promise. A directory where the file is
   * expected reproduces a real non-ENOENT `readFileSync` failure without
   * needing to fake `fs` or touch file permissions.
   */
  it('reads null rather than throwing when the credential path is not a plain file', () => {
    const dirAsFile = join(dir, 'is-a-directory');
    mkdirSync(dirAsFile);
    const store = createTokenStore({ safeStorage: fakeSafeStorage(), filePath: dirAsFile });

    expect(() => store.read()).not.toThrow();
    expect(store.read()).toBeNull();
  });
});
