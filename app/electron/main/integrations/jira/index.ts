import type {
  ConfigSnapshot,
  SetJiraTokenRequest,
} from '../../../shared/config-contract';
import type {
  JiraIdentity,
  JiraResult,
  JiraStatus,
} from '../../../shared/jira-contract';

import {
  createJiraAuth,
  type JiraAuth,
  type SecretFile,
  type SecretStore,
} from './auth';
import { createJiraClient, type FetchLike } from './client';

/**
 * The verbs main exposes for Jira (HIVE-67).
 *
 * Composition, and nothing else. `auth.ts` owns the credential, `client.ts`
 * owns HTTP, and this file owns two decisions: which of them a verb needs, and
 * what happens when the app is not configured yet.
 *
 * **Every verb answers; none throws.** A settings pane that cannot render
 * because Jira is unreachable tells the user this app is broken, when the truth
 * is that Jira is unreachable — `gh.ts:166-172`'s rule, and the reason the
 * result union exists.
 */

/** The identity endpoint. A constant, never assembled from a payload. */
const MYSELF = '/rest/api/3/myself';

export interface Jira {
  status(): JiraStatus;
  setToken(request: SetJiraTokenRequest): JiraStatus;
  clearToken(): JiraStatus;
  test(): Promise<JiraResult<JiraIdentity>>;
}

export function createJira(deps: {
  store: SecretStore;
  file: SecretFile;
  env: NodeJS.ProcessEnv;
  /**
   * Read fresh on every verb, not captured.
   *
   * The config file is hand-editable and story 107 ships a button that reveals
   * it, so a site captured at construction would be the site the app started
   * with rather than the one on disk.
   */
  config: () => ConfigSnapshot;
  fetch: FetchLike;
}): Jira {
  const { config, fetch } = deps;
  const auth: JiraAuth = createJiraAuth({
    store: deps.store,
    file: deps.file,
    env: deps.env,
  });

  const status = (): JiraStatus => {
    const { site, email } = config().jira;
    return {
      site,
      email,
      credential: auth.state(email),
      encryptionAvailable: auth.encryptionAvailable(),
    };
  };

  return {
    status,

    setToken(request) {
      try {
        auth.save(request.token);
      } catch {
        /**
         * Swallowed deliberately — the returned *state* is the report.
         *
         * `save` throws for exactly one reason, and in that case `status()`
         * already answers `unavailable` carrying the sentence the pane shows.
         * Rejecting the invoke as well would make the renderer handle one fact
         * twice, in two shapes, and the rejection path is the one that would
         * rot.
         */
      }
      return status();
    },

    clearToken() {
      auth.clear();
      return status();
    },

    async test() {
      const { site, email } = config().jira;
      if (site === null) {
        return {
          ok: false,
          error: {
            kind: 'bad-query',
            message: 'No Jira site is configured yet.',
          },
        };
      }
      if (email === null) {
        return {
          ok: false,
          error: {
            kind: 'bad-query',
            message: 'No account email is configured yet.',
          },
        };
      }

      const token = auth.token();
      if (token === null) {
        return {
          ok: false,
          error: {
            kind: 'unauthorized',
            message: 'No API token is stored, and JIRA_API_KEY is not set.',
          },
        };
      }

      const client = createJiraClient({
        fetch,
        site,
        credential: { email, token },
      });

      const result = await client.get<{
        displayName?: unknown;
        accountId?: unknown;
      }>(MYSELF);
      if (!result.ok) return result;

      /**
       * Narrowed to two fields before it crosses IPC.
       *
       * `/myself` also returns an avatar map, a locale, a time zone and the
       * account's email address. The epic's rule is that only mapped, named
       * fields ever cross — forwarding the payload would hand the renderer
       * personal data it has no use for, and would set the precedent that raw
       * Jira JSON is allowed through.
       */
      const { displayName, accountId } = result.value;
      if (typeof displayName !== 'string' || typeof accountId !== 'string') {
        return {
          ok: false,
          error: {
            kind: 'unknown',
            message: 'Jira answered without an account name.',
          },
        };
      }
      return { ok: true, value: { displayName, accountId } };
    },
  };
}
