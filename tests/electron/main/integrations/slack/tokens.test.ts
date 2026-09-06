// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createSlackTokens } from '../../../../../electron/main/integrations/slack/tokens';
import type {
  SecretFile,
  SecretStore,
} from '../../../../../electron/main/integrations/jira/auth';

/** Reversible, not secure — the point is the round trip, not the cipher. */
const fakeStore = (available = true): SecretStore => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (cipher) => {
    const text = cipher.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('not mine');
    return text.slice(4);
  },
});

const fakeFile = (): SecretFile => {
  let bytes: Buffer | null = null;
  return {
    read: () => bytes,
    write: (b) => {
      bytes = b;
    },
    clear: () => {
      bytes = null;
    },
  };
};

describe('createSlackTokens', () => {
  it('reads back nothing before anything is saved', () => {
    const tokens = createSlackTokens({ store: fakeStore(), file: fakeFile() });
    expect(tokens.state()).toEqual({
      hasAppToken: false,
      hasBotToken: false,
      encryptionAvailable: true,
    });
    expect(tokens.read()).toEqual({});
  });

  it('round-trips both tokens', () => {
    const tokens = createSlackTokens({ store: fakeStore(), file: fakeFile() });
    tokens.save({ appToken: 'xapp-1-A', botToken: 'xoxb-2-B' });
    expect(tokens.read()).toEqual({ appToken: 'xapp-1-A', botToken: 'xoxb-2-B' });
    expect(tokens.state()).toEqual({
      hasAppToken: true,
      hasBotToken: true,
      encryptionAvailable: true,
    });
  });

  it('saves one token without clearing the other', () => {
    const tokens = createSlackTokens({ store: fakeStore(), file: fakeFile() });
    tokens.save({ appToken: 'xapp-1-A', botToken: 'xoxb-2-B' });
    tokens.save({ botToken: 'xoxb-3-C' });
    expect(tokens.read()).toEqual({ appToken: 'xapp-1-A', botToken: 'xoxb-3-C' });
  });

  it('never puts a token in the state that crosses IPC', () => {
    const tokens = createSlackTokens({ store: fakeStore(), file: fakeFile() });
    tokens.save({ appToken: 'xapp-1-SECRET', botToken: 'xoxb-2-SECRET' });
    const serialised = JSON.stringify(tokens.state());
    expect(serialised).not.toContain('SECRET');
    expect(serialised).not.toContain('xapp-');
    expect(serialised).not.toContain('xoxb-');
  });

  it('clears both', () => {
    const file = fakeFile();
    const tokens = createSlackTokens({ store: fakeStore(), file });
    tokens.save({ appToken: 'xapp-1-A', botToken: 'xoxb-2-B' });
    expect(tokens.clear()).toEqual({
      hasAppToken: false,
      hasBotToken: false,
      encryptionAvailable: true,
    });
    expect(file.read()).toBeNull();
    expect(tokens.read()).toEqual({});
  });

  it('reads ciphertext this machine cannot decrypt as empty, not as a throw', () => {
    const file = fakeFile();
    file.write(Buffer.from('someone-elses-bytes', 'utf8'));
    const tokens = createSlackTokens({ store: fakeStore(), file });
    expect(tokens.read()).toEqual({});
    expect(tokens.state().hasAppToken).toBe(false);
  });

  it('refuses to write plaintext when there is no keyring', () => {
    const tokens = createSlackTokens({ store: fakeStore(false), file: fakeFile() });
    expect(() => tokens.save({ appToken: 'xapp-1-A' })).toThrow(/encrypt/i);
    expect(tokens.state().encryptionAvailable).toBe(false);
  });
});
