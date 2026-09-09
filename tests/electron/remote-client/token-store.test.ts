// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('write is a silent no-op when encryption is unavailable, not a throw', () => {
    const { store, written } = harness({ available: false });
    expect(() => store.write('dev-1', 'tok')).not.toThrow();
    expect(written()).toBe('');
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
});
