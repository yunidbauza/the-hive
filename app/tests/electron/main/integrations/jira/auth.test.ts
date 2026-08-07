// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createJiraAuth,
  credentialFile,
  type SecretFile,
  type SecretStore,
} from '../../../../../electron/main/integrations/jira/auth';

/**
 * The credential (HIVE-67).
 *
 * Both dependencies are injected — `safeStorage` because a test that touched a
 * real keychain would answer differently on every machine and prompt for a
 * password on some, and the file because what is worth testing is the decision
 * logic, not `writeFileSync`. `credentialFile` gets its own describe block
 * against a real temp directory, because "wrote it with mode 0600" is a claim
 * only the filesystem can settle.
 */

const TOKEN = 'ATATT-not-a-real-token-9f3c';

/** A store that "encrypts" by tagging, so a test can tell cipher from plain. */
function store(available = true): SecretStore {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (cipher) => {
      const text = cipher.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not ciphertext');
      return text.slice(4);
    },
  };
}

/** An in-memory ciphertext file, exposing what it holds. */
function file(
  initial: Buffer | null = null,
): SecretFile & { bytes: Buffer | null } {
  const seam = {
    bytes: initial,
    read: () => seam.bytes,
    write: (next: Buffer) => {
      seam.bytes = next;
    },
    clear: () => {
      seam.bytes = null;
    },
  };
  return seam;
}

describe('credential state', () => {
  it('is none with nothing stored, no env var and working encryption', () => {
    const auth = createJiraAuth({ store: store(), file: file(), env: {} });
    expect(auth.state(null)).toEqual({ kind: 'none' });
    expect(auth.encryptionAvailable()).toBe(true);
  });

  it('is stored, carrying the configured email, once a token is saved', () => {
    const auth = createJiraAuth({ store: store(), file: file(), env: {} });
    auth.save(TOKEN);
    expect(auth.state('me@example.com')).toEqual({
      kind: 'stored',
      email: 'me@example.com',
    });
  });

  it('is still stored when no email is configured yet', () => {
    const auth = createJiraAuth({ store: store(), file: file(), env: {} });
    auth.save(TOKEN);
    expect(auth.state(null)).toEqual({ kind: 'stored', email: '' });
  });

  it('is env when JIRA_API_KEY is set and nothing is stored', () => {
    const auth = createJiraAuth({
      store: store(),
      file: file(),
      env: { JIRA_API_KEY: TOKEN },
    });
    expect(auth.state(null)).toEqual({ kind: 'env', variable: 'JIRA_API_KEY' });
  });

  it('treats an exported-but-empty variable as unset', () => {
    const auth = createJiraAuth({
      store: store(),
      file: file(),
      env: { JIRA_API_KEY: '   ' },
    });
    expect(auth.state(null)).toEqual({ kind: 'none' });
    expect(auth.token()).toBeNull();
  });

  it('prefers a stored token over the environment', () => {
    const auth = createJiraAuth({
      store: store(),
      file: file(),
      env: { JIRA_API_KEY: 'from-env' },
    });
    auth.save(TOKEN);
    expect(auth.state('me@example.com').kind).toBe('stored');
    expect(auth.token()).toBe(TOKEN);
  });

  it('is unavailable, with a reason, when encryption is off and no env var is set', () => {
    const auth = createJiraAuth({ store: store(false), file: file(), env: {} });
    const state = auth.state(null);
    expect(state.kind).toBe('unavailable');
    expect(state.kind === 'unavailable' && state.reason).toMatch(/keyring/i);
    expect(state.kind === 'unavailable' && state.reason).toContain(
      'JIRA_API_KEY',
    );
    expect(auth.encryptionAvailable()).toBe(false);
  });

  it('is env — not unavailable — when encryption is off but the variable is set', () => {
    const auth = createJiraAuth({
      store: store(false),
      file: file(),
      env: { JIRA_API_KEY: TOKEN },
    });
    expect(auth.state(null)).toEqual({ kind: 'env', variable: 'JIRA_API_KEY' });
    expect(auth.encryptionAvailable()).toBe(false);
    expect(auth.token()).toBe(TOKEN);
  });

  it('is none, not stored, when the ciphertext will not decrypt', () => {
    const auth = createJiraAuth({
      store: store(),
      file: file(Buffer.from('garbage', 'utf8')),
      env: {},
    });
    expect(auth.state('me@example.com')).toEqual({ kind: 'none' });
    expect(auth.token()).toBeNull();
  });
});

describe('writing and clearing', () => {
  it('refuses to write when encryption is unavailable, storing nothing', () => {
    const seam = file();
    const auth = createJiraAuth({ store: store(false), file: seam, env: {} });
    expect(() => auth.save(TOKEN)).toThrow(/keyring/i);
    expect(seam.bytes).toBeNull();
  });

  it('writes ciphertext, never the plaintext token', () => {
    const seam = file();
    const auth = createJiraAuth({ store: store(), file: seam, env: {} });
    auth.save(TOKEN);
    expect(seam.bytes?.toString('utf8')).not.toBe(TOKEN);
    expect(seam.bytes?.toString('utf8')).toBe(`enc:${TOKEN}`);
  });

  it('replaces an existing token rather than appending', () => {
    const seam = file();
    const auth = createJiraAuth({ store: store(), file: seam, env: {} });
    auth.save('first');
    auth.save('second');
    expect(auth.token()).toBe('second');
  });

  it('clear removes the file and drops back to none', () => {
    const seam = file();
    const auth = createJiraAuth({ store: store(), file: seam, env: {} });
    auth.save(TOKEN);
    auth.clear();
    expect(seam.bytes).toBeNull();
    expect(auth.state('me@example.com')).toEqual({ kind: 'none' });
  });

  it('clear falls back to the environment rather than to none', () => {
    const auth = createJiraAuth({
      store: store(),
      file: file(),
      env: { JIRA_API_KEY: TOKEN },
    });
    auth.save('stored-one');
    auth.clear();
    expect(auth.state(null)).toEqual({ kind: 'env', variable: 'JIRA_API_KEY' });
  });
});

/**
 * The test that guards the security property rather than a behaviour.
 *
 * A future field that "just includes the config" would pass every behavioural
 * test above and fail this one, which is exactly why it is a blunt deep scan of
 * the serialised value rather than an assertion about known keys.
 */
describe('the token never leaves', () => {
  it('does not appear anywhere in the serialised state, in any case', () => {
    for (const env of [{}, { JIRA_API_KEY: TOKEN }]) {
      for (const available of [true, false]) {
        const auth = createJiraAuth({ store: store(available), file: file(), env });
        try {
          auth.save(TOKEN);
        } catch {
          // Unavailable encryption refuses the write; the states below are
          // still the ones that must be scanned.
        }
        for (const email of [null, 'me@example.com']) {
          const serialised = JSON.stringify(auth.state(email));
          expect(serialised).not.toContain(TOKEN);
          expect(serialised).not.toContain('ATATT');
        }
      }
    }
  });
});

describe('credentialFile', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hive-cred-'));
    path = join(dir, 'jira-credential.bin');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads null rather than throwing when there is no file', () => {
    expect(credentialFile(path).read()).toBeNull();
  });

  it('round-trips bytes', () => {
    const seam = credentialFile(path);
    seam.write(Buffer.from([1, 2, 3]));
    expect(seam.read()).toEqual(Buffer.from([1, 2, 3]));
    expect(readFileSync(path)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('writes owner-only, because a world-readable secrets file outlives its reasoning', () => {
    credentialFile(path).write(Buffer.from([1]));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('clear is idempotent and leaves no file behind', () => {
    const seam = credentialFile(path);
    seam.write(Buffer.from([1]));
    seam.clear();
    seam.clear();
    expect(seam.read()).toBeNull();
  });
});
