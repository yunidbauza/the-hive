import { assertJiraEmail, assertJiraSite } from '../../../shared/guards';
import { JIRA_SITE_ENV, JIRA_TOKEN_ENV } from '../../../shared/jira-contract';

/**
 * Reading Jira settings out of the environment.
 *
 * ## Why the token variable has two shapes
 *
 * `JIRA_API_KEY` was chosen for this app because it is the variable an
 * Atlassian-adjacent machine already has. That turned out to be truer than
 * intended: the `jira-writer` tooling documents the *same* name holding
 * `email:token` — the address and the secret joined by a colon, not base64 —
 * and anyone working on this integration has it exported that way.
 *
 * The app builds `Basic base64(email:token)` from a configured email and this
 * value. Reading the joined form as a bare token therefore produced
 * `email:email:token` and a 401 — a failure that reads as a bad token and sends
 * the user to Atlassian to regenerate one that was never the problem.
 *
 * So both shapes are accepted, and when the value carries an address the app
 * uses it rather than making the user retype what it is already holding.
 *
 * ## Why malformed values are ignored rather than rejected
 *
 * Nothing here throws. An environment variable is not a form field: the user
 * is not standing in front of it when it is read, there is no control to put an
 * error beside, and a bad `JIRA_DOMAIN` must not be able to stop the app
 * starting. An unusable value is simply absent, which lands the pane in the
 * "not configured yet" state it already renders.
 */

/** A credential value, split if it was carrying its own address. */
export interface ParsedCredential {
  /** The address the value carried, or `null` when it was a bare token. */
  email: string | null;
  token: string;
}

/**
 * Split `email:token`, or pass a bare token through.
 *
 * The test is deliberately narrow: a colon **and** an `@` before it. Atlassian
 * tokens are base64-alphabet, so they contain no colon of their own — but
 * requiring the address shape too means a token that somehow did would still be
 * treated as a token rather than silently truncated at its first colon.
 */
export function parseCredential(raw: string): ParsedCredential {
  const value = raw.trim();
  const separator = value.indexOf(':');
  if (separator === -1) return { email: null, token: value };

  const head = value.slice(0, separator).trim();
  const tail = value.slice(separator + 1).trim();
  if (!head.includes('@') || tail === '') return { email: null, token: value };

  /**
   * The address is validated, the token is not.
   *
   * A head that looks like an address but is not usable as one still means the
   * tail is the token — dropping only the address is a better answer than
   * handing Jira a credential we know is malformed.
   */
  try {
    return { email: assertJiraEmail(head, JIRA_TOKEN_ENV), token: tail };
  } catch {
    return { email: null, token: tail };
  }
}

/** The raw token value, treating an exported-but-empty variable as unset. */
export function readEnvToken(env: NodeJS.ProcessEnv): string | null {
  const value = env[JIRA_TOKEN_ENV];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The site from `JIRA_DOMAIN`, normalised, or `null`.
 *
 * `assertJiraSite` does the work — it strips a pasted `https://`, drops
 * trailing slashes, lowercases, and refuses anything carrying a path, port or
 * credentials. Its refusal is caught rather than propagated, per the note
 * above.
 */
export function readEnvSite(env: NodeJS.ProcessEnv): string | null {
  const value = env[JIRA_SITE_ENV];
  if (typeof value !== 'string' || value.trim() === '') return null;

  try {
    return assertJiraSite(value, JIRA_SITE_ENV);
  } catch {
    return null;
  }
}
