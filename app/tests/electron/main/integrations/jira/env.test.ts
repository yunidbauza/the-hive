// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  parseCredential,
  readEnvSite,
  readEnvToken,
} from '../../../../../electron/main/integrations/jira/env';

/**
 * Reading Jira settings out of the environment.
 *
 * The case that matters most here is a real defect rather than a hypothetical:
 * `jira-writer` documents `JIRA_API_KEY` as `email:token`, this app read it as a
 * bare token, and the resulting `base64(email:email:token)` returned 401 — a
 * failure that reads as a bad token and sends the user to Atlassian to
 * regenerate one that was fine.
 */

const TOKEN = 'ATATT3xFfGF0T0kEn';

describe('parseCredential', () => {
  it('splits the email:token form jira-writer exports', () => {
    expect(parseCredential(`me@example.com:${TOKEN}`)).toEqual({
      email: 'me@example.com',
      token: TOKEN,
    });
  });

  it('passes a bare token through untouched', () => {
    expect(parseCredential(TOKEN)).toEqual({ email: null, token: TOKEN });
  });

  it('splits on the first colon only, so a token keeping one survives whole', () => {
    expect(parseCredential(`me@example.com:a:b:c`)).toEqual({
      email: 'me@example.com',
      token: 'a:b:c',
    });
  });

  it('does not split a value whose head is not an address', () => {
    // Requiring the `@` means a token that somehow contained a colon is treated
    // as a token rather than silently truncated at it.
    expect(parseCredential(`notanemail:${TOKEN}`)).toEqual({
      email: null,
      token: `notanemail:${TOKEN}`,
    });
  });

  it('does not split a trailing colon into an empty token', () => {
    expect(parseCredential('me@example.com:')).toEqual({
      email: null,
      token: 'me@example.com:',
    });
  });

  it('keeps the token when the address half is unusable', () => {
    // Dropping only the address is a better answer than handing Jira a
    // credential we already know is malformed.
    const parsed = parseCredential(`@@@@:${TOKEN}`);
    expect(parsed.token).toBe(TOKEN);
    expect(parsed.email).toBeNull();
  });

  it('trims surrounding whitespace, which a shell profile leaves behind', () => {
    expect(parseCredential(`  me@example.com : ${TOKEN}  `)).toEqual({
      email: 'me@example.com',
      token: TOKEN,
    });
  });
});

describe('readEnvToken', () => {
  it('reads the variable', () => {
    expect(readEnvToken({ JIRA_API_KEY: TOKEN })).toBe(TOKEN);
  });

  it('treats an exported-but-empty variable as unset', () => {
    // The common shell-profile pattern: a profile exports a name it never
    // assigns. Reporting that as "set" is a false positive the user cannot see.
    expect(readEnvToken({ JIRA_API_KEY: '   ' })).toBeNull();
    expect(readEnvToken({})).toBeNull();
  });
});

describe('readEnvSite', () => {
  it('reads JIRA_DOMAIN', () => {
    expect(readEnvSite({ JIRA_DOMAIN: 'behiques.atlassian.net' })).toBe(
      'behiques.atlassian.net',
    );
  });

  it('trims a pasted https:// address down to the host', () => {
    expect(readEnvSite({ JIRA_DOMAIN: 'https://behiques.atlassian.net/' })).toBe(
      'behiques.atlassian.net',
    );
  });

  it('lowercases, so the header and the URL cannot disagree', () => {
    expect(readEnvSite({ JIRA_DOMAIN: 'Behiques.Atlassian.NET' })).toBe(
      'behiques.atlassian.net',
    );
  });

  it.each([
    ['a path', 'behiques.atlassian.net/jira'],
    ['a port', 'behiques.atlassian.net:8080'],
    ['credentials', 'user:pass@behiques.atlassian.net'],
    ['plain http', 'http://behiques.atlassian.net'],
    ['not a hostname', 'localhost'],
  ])('ignores %s rather than throwing', (_label, value) => {
    /**
     * An environment variable is not a form field: nobody is standing in front
     * of it when it is read, there is no control to put an error beside, and a
     * bad value must not be able to stop the app starting. An unusable one is
     * simply absent.
     */
    expect(readEnvSite({ JIRA_DOMAIN: value })).toBeNull();
  });

  it('treats an exported-but-empty variable as unset', () => {
    expect(readEnvSite({ JIRA_DOMAIN: '  ' })).toBeNull();
    expect(readEnvSite({})).toBeNull();
  });
});
