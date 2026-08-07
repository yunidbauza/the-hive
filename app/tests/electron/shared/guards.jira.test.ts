// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  IpcValidationError,
  parseSetJiraRequest,
  parseSetJiraTokenRequest,
} from '../../../electron/shared/guards';

/**
 * The Jira payload guards (HIVE-67).
 *
 * `assertJiraSite` is the only guard in the app whose output is interpolated
 * into a URL that a credential is attached to, so its rejections are tested as
 * carefully as its acceptances: a host taken from a payload unchecked is the
 * difference between an integration and a credential-exfiltration primitive.
 */

const refuses = (run: () => unknown, match: RegExp): void => {
  expect(run).toThrow(IpcValidationError);
  expect(run).toThrow(match);
};

describe('parseSetJiraRequest — site', () => {
  it('accepts a bare hostname', () => {
    expect(parseSetJiraRequest({ site: 'behiques.atlassian.net' })).toEqual({
      site: 'behiques.atlassian.net',
    });
  });

  it('strips a pasted https:// prefix and a trailing slash', () => {
    expect(
      parseSetJiraRequest({ site: 'https://behiques.atlassian.net/' }),
    ).toEqual({ site: 'behiques.atlassian.net' });
  });

  it('lower-cases the host, so two configs cannot differ by case alone', () => {
    expect(parseSetJiraRequest({ site: 'Behiques.Atlassian.NET' })).toEqual({
      site: 'behiques.atlassian.net',
    });
  });

  it('refuses http://, which would downgrade the transport', () => {
    refuses(
      () => parseSetJiraRequest({ site: 'http://behiques.atlassian.net' }),
      /https/,
    );
  });

  it('refuses a path — the client appends its own', () => {
    refuses(
      () => parseSetJiraRequest({ site: 'behiques.atlassian.net/rest' }),
      /site/,
    );
  });

  it('refuses a port', () => {
    refuses(
      () => parseSetJiraRequest({ site: 'behiques.atlassian.net:8080' }),
      /site/,
    );
  });

  it('refuses userinfo, which is how a host gets impersonated', () => {
    refuses(
      () => parseSetJiraRequest({ site: 'evil.example@behiques.atlassian.net' }),
      /site/,
    );
  });

  it('refuses whitespace inside the host', () => {
    refuses(() => parseSetJiraRequest({ site: 'a b.net' }), /site/);
  });

  it('refuses a single label', () => {
    refuses(() => parseSetJiraRequest({ site: 'localhost' }), /site/);
  });

  it('refuses an empty string, which is not the same as clearing', () => {
    refuses(() => parseSetJiraRequest({ site: '   ' }), /empty/);
  });

  it('refuses a leading or trailing hyphen in a label', () => {
    refuses(() => parseSetJiraRequest({ site: '-bad.atlassian.net' }), /site/);
    refuses(() => parseSetJiraRequest({ site: 'bad-.atlassian.net' }), /site/);
  });

  it('refuses a host past the DNS limit', () => {
    const long = `${'a'.repeat(250)}.net`;
    refuses(() => parseSetJiraRequest({ site: long }), /site/);
  });

  it('refuses a non-string', () => {
    refuses(() => parseSetJiraRequest({ site: 7 }), /site/);
  });

  it('accepts null, which clears the field', () => {
    expect(parseSetJiraRequest({ site: null })).toEqual({ site: null });
  });
});

describe('parseSetJiraRequest — email', () => {
  it('accepts an ordinary address', () => {
    expect(parseSetJiraRequest({ email: 'a@b.co' })).toEqual({
      email: 'a@b.co',
    });
  });

  it('refuses a colon, which would move the Basic-auth separator', () => {
    refuses(() => parseSetJiraRequest({ email: 'a:b@c.co' }), /colon/);
  });

  it('refuses whitespace', () => {
    refuses(() => parseSetJiraRequest({ email: 'a b@c.co' }), /email/);
  });

  it('refuses an address with no @, and one with two', () => {
    refuses(() => parseSetJiraRequest({ email: 'abc.co' }), /email/);
    refuses(() => parseSetJiraRequest({ email: 'a@b@c.co' }), /email/);
  });

  it('refuses an empty local part or domain', () => {
    refuses(() => parseSetJiraRequest({ email: '@b.co' }), /email/);
    refuses(() => parseSetJiraRequest({ email: 'a@' }), /email/);
  });

  it('accepts null', () => {
    expect(parseSetJiraRequest({ email: null })).toEqual({ email: null });
  });
});

describe('parseSetJiraRequest — shape', () => {
  it('refuses an unknown key', () => {
    refuses(() => parseSetJiraRequest({ token: 'x' }), /unexpected key/);
  });

  it('refuses an empty request', () => {
    refuses(() => parseSetJiraRequest({}), /nothing to change/);
  });

  it('refuses a forbidden key', () => {
    refuses(
      () => parseSetJiraRequest(JSON.parse('{"__proto__": {}}')),
      /forbidden key/,
    );
  });

  it('keeps absent distinct from null', () => {
    expect(parseSetJiraRequest({ site: 'a.b.co' })).not.toHaveProperty('email');
  });

  it('accepts both fields together', () => {
    expect(
      parseSetJiraRequest({ site: 'a.b.co', email: 'me@example.com' }),
    ).toEqual({ site: 'a.b.co', email: 'me@example.com' });
  });
});

describe('parseSetJiraTokenRequest', () => {
  it('accepts a printable token', () => {
    expect(parseSetJiraTokenRequest({ token: 'ATATT3xFfGF0=abc' })).toEqual({
      token: 'ATATT3xFfGF0=abc',
    });
  });

  it('refuses an empty token', () => {
    refuses(() => parseSetJiraTokenRequest({ token: '' }), /token/);
  });

  it('refuses an oversized token', () => {
    refuses(
      () => parseSetJiraTokenRequest({ token: 'x'.repeat(1025) }),
      /token/,
    );
  });

  it('refuses whitespace and control characters', () => {
    refuses(() => parseSetJiraTokenRequest({ token: 'ab cd' }), /token/);
    refuses(() => parseSetJiraTokenRequest({ token: 'ab\ncd' }), /token/);
  });

  it('never echoes the value it refused', () => {
    const secret = 'sup3rsecret!'.repeat(200);
    try {
      parseSetJiraTokenRequest({ token: secret });
      expect.unreachable('should have refused');
    } catch (cause) {
      expect(String(cause)).not.toContain('sup3rsecret');
    }
  });

  it('requires the key', () => {
    refuses(() => parseSetJiraTokenRequest({}), /missing key/);
  });

  it('refuses an unknown sibling key', () => {
    refuses(
      () => parseSetJiraTokenRequest({ token: 'ok', site: 'a.b.co' }),
      /unexpected key/,
    );
  });
});
