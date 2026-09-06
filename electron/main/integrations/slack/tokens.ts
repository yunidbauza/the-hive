import type { SlackTokensState } from '../../../shared/slack-contract';
import type { SecretFile, SecretStore } from '../jira/auth';

/**
 * The two Hive-owned Slack tokens (HIVE-124).
 *
 * The opposite custody from HIVE-123's OAuth token, and the pane now says so in
 * one place: that one lives in `~/.claude/.credentials.json`, held and
 * refreshed by Claude Code, and this app never reads it. These two are the
 * Hive's own — an app-level `xapp-` for the socket and a bot `xoxb-` for
 * `auth.test` and channel-name resolution — so they are stored the way Jira's
 * credential is, and never posted with.
 *
 * Both live in **one** file rather than two. They are acquired together from
 * one Slack app, are useless apart, and are cleared together; two files would
 * make a half-configured state representable on disk for no gain.
 *
 * {@link SlackTokens.read} is main-internal. No IPC verb returns it and no
 * channel carries it. {@link SlackTokens.state} is assembled from presence
 * alone, and the unit test asserts that by scanning the serialised state,
 * because it is the invariant most easily lost in a refactor.
 */

interface StoredTokens {
  appToken?: string;
  botToken?: string;
}

export interface SlackTokens {
  state(): SlackTokensState;
  save(next: StoredTokens): SlackTokensState;
  clear(): SlackTokensState;
  /** **Main-internal.** There is no IPC verb that reaches this. */
  read(): StoredTokens;
}

const NO_ENCRYPTION =
  `This system has no keyring available to encrypt with, so no Slack token ` +
  `can be stored. Real-time events stay off.`;

export function createSlackTokens(deps: {
  store: SecretStore;
  file: SecretFile;
}): SlackTokens {
  const { store, file } = deps;

  const read = (): StoredTokens => {
    const bytes = file.read();
    if (bytes === null) return {};
    try {
      const parsed: unknown = JSON.parse(store.decryptString(bytes));
      if (typeof parsed !== 'object' || parsed === null) return {};
      const { appToken, botToken } = parsed as StoredTokens;
      return {
        ...(typeof appToken === 'string' && appToken !== '' ? { appToken } : {}),
        ...(typeof botToken === 'string' && botToken !== '' ? { botToken } : {}),
      };
    } catch {
      /*
        Ciphertext this machine cannot read — a copied `userData`, a rotated OS
        key — is the same situation as no file at all, and `jira/auth.ts` treats
        it that way for the same reason: the user's remedy is to paste the
        tokens again, which an empty state invites and a thrown error does not.
      */
      return {};
    }
  };

  const state = (): SlackTokensState => {
    const held = read();
    return {
      hasAppToken: held.appToken !== undefined,
      hasBotToken: held.botToken !== undefined,
      encryptionAvailable: store.isEncryptionAvailable(),
    };
  };

  return {
    state,
    read,
    save(next) {
      if (!store.isEncryptionAvailable()) throw new Error(NO_ENCRYPTION);
      /*
        Merged, not replaced. The pane commits one field at a time, and a save
        that dropped the token the user was not editing would clear half the
        configuration on every keystroke they finished.
      */
      const merged: StoredTokens = { ...read() };
      if (next.appToken !== undefined) merged.appToken = next.appToken.trim();
      if (next.botToken !== undefined) merged.botToken = next.botToken.trim();
      file.write(store.encryptString(JSON.stringify(merged)));
      return state();
    },
    clear() {
      file.clear();
      return state();
    },
  };
}
