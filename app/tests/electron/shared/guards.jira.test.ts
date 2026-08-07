// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  IpcValidationError,
  parseAddJiraCommentRequest,
  parseApplyJiraTransitionRequest,
  parseJiraConversationRequest,
  parseJiraIssueRequest,
  parseJiraSearchRequest,
  parseJiraTransitionsRequest,
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

describe('parseJiraIssueRequest', () => {
  it('accepts a well-formed key', () => {
    expect(parseJiraIssueRequest({ key: 'HIVE-68' })).toEqual({
      key: 'HIVE-68',
    });
  });

  it('accepts digits in the project part', () => {
    expect(parseJiraIssueRequest({ key: 'AB2C-1' })).toEqual({ key: 'AB2C-1' });
  });

  it('refuses lower case, which Jira keys never are', () => {
    refuses(() => parseJiraIssueRequest({ key: 'hive-68' }), /key/);
  });

  it('refuses a key that starts with a digit', () => {
    refuses(() => parseJiraIssueRequest({ key: '1AB-2' }), /key/);
  });

  it('refuses path separators, which is the whole point of the pattern', () => {
    refuses(() => parseJiraIssueRequest({ key: 'HIVE-68/nope' }), /key/);
    refuses(() => parseJiraIssueRequest({ key: 'HIVE-68%2Fnope' }), /key/);
  });

  it('refuses a query fragment appended to a valid key', () => {
    refuses(() => parseJiraIssueRequest({ key: 'HIVE-68?expand=all' }), /key/);
    refuses(() => parseJiraIssueRequest({ key: 'HIVE-68#frag' }), /key/);
  });

  it('refuses a missing number, and a missing project', () => {
    refuses(() => parseJiraIssueRequest({ key: 'HIVE-' }), /key/);
    refuses(() => parseJiraIssueRequest({ key: '-68' }), /key/);
  });

  it('refuses whitespace inside the key', () => {
    refuses(() => parseJiraIssueRequest({ key: 'HIVE 68' }), /key/);
  });

  it('refuses a missing key and an unknown sibling', () => {
    refuses(() => parseJiraIssueRequest({}), /missing key/);
    refuses(
      () => parseJiraIssueRequest({ key: 'HIVE-68', jql: 'x' }),
      /unexpected key/,
    );
  });
});

describe('parseJiraSearchRequest', () => {
  it('accepts an absent jql — meaning the default query', () => {
    expect(parseJiraSearchRequest({})).toEqual({});
  });

  it('accepts a jql string verbatim, operators and all', () => {
    const jql = 'project = HIVE AND status != Done ORDER BY updated DESC';
    expect(parseJiraSearchRequest({ jql })).toEqual({ jql });
  });

  it('refuses control characters, which no JQL needs', () => {
    refuses(() => parseJiraSearchRequest({ jql: 'a\nb' }), /jql/);
  });

  it('refuses an empty query — absent is how you ask for the default', () => {
    refuses(() => parseJiraSearchRequest({ jql: '' }), /jql/);
  });

  it('refuses an over-long query', () => {
    refuses(() => parseJiraSearchRequest({ jql: 'x'.repeat(4097) }), /jql/);
  });

  it('refuses an unknown key', () => {
    refuses(() => parseJiraSearchRequest({ key: 'HIVE-1' }), /unexpected key/);
  });
});

describe('parseJiraTransitionsRequest', () => {
  it('accepts a well-formed key', () => {
    expect(parseJiraTransitionsRequest({ key: 'HIVE-70' })).toEqual({
      key: 'HIVE-70',
    });
  });

  it('refuses a malformed key, like every other verb', () => {
    refuses(() => parseJiraTransitionsRequest({ key: 'nope' }), /key/);
  });
});

describe('parseApplyJiraTransitionRequest', () => {
  it('accepts a key and a numeric id', () => {
    expect(
      parseApplyJiraTransitionRequest({ key: 'HIVE-70', transitionId: '31' }),
    ).toEqual({ key: 'HIVE-70', transitionId: '31' });
  });

  it('refuses a non-numeric transition id', () => {
    // Validated even though main handed the renderer this value moments ago:
    // main does not trust that what it gave out came back unchanged.
    refuses(
      () =>
        parseApplyJiraTransitionRequest({ key: 'HIVE-70', transitionId: '31; DROP' }),
      /transitionId/,
    );
    refuses(
      () =>
        parseApplyJiraTransitionRequest({ key: 'HIVE-70', transitionId: 'done' }),
      /transitionId/,
    );
  });

  it('refuses an empty or over-long id', () => {
    refuses(
      () => parseApplyJiraTransitionRequest({ key: 'HIVE-70', transitionId: '' }),
      /transitionId/,
    );
    refuses(
      () =>
        parseApplyJiraTransitionRequest({
          key: 'HIVE-70',
          transitionId: '1'.repeat(11),
        }),
      /transitionId/,
    );
  });

  it('requires both keys, and refuses an unknown one', () => {
    refuses(() => parseApplyJiraTransitionRequest({ key: 'HIVE-70' }), /missing key/);
    refuses(
      () => parseApplyJiraTransitionRequest({ transitionId: '31' }),
      /missing key/,
    );
    refuses(
      () =>
        parseApplyJiraTransitionRequest({
          key: 'HIVE-70',
          transitionId: '31',
          fields: {},
        }),
      /unexpected key/,
    );
  });
});

describe('parseJiraConversationRequest', () => {
  it('accepts a well-formed key', () => {
    expect(parseJiraConversationRequest({ key: 'HIVE-71' })).toEqual({
      key: 'HIVE-71',
    });
  });

  it('refuses a malformed key, like every other verb', () => {
    refuses(() => parseJiraConversationRequest({ key: 'nope' }), /key/);
    refuses(() => parseJiraConversationRequest({}), /missing key/);
  });
});

describe('parseAddJiraCommentRequest', () => {
  it('accepts markdown, punctuation and all', () => {
    const markdown = '# Heading\n\nSome **bold**, a `code span`, and <angle>.';
    expect(
      parseAddJiraCommentRequest({ key: 'HIVE-71', markdown }),
    ).toEqual({ key: 'HIVE-71', markdown });
  });

  it('allows newlines — a comment without paragraphs is not a comment', () => {
    const markdown = 'one\n\ntwo\r\nthree\tfour';
    expect(
      parseAddJiraCommentRequest({ key: 'HIVE-71', markdown }).markdown,
    ).toBe(markdown);
  });

  it('refuses other control characters', () => {
    // A control byte would ride into a text node and Jira would reject the
    // whole document with a message naming nothing.
    refuses(
      () =>
        parseAddJiraCommentRequest({ key: 'HIVE-71', markdown: 'a\u0000b' }),
      /control characters/,
    );
    refuses(
      () =>
        parseAddJiraCommentRequest({ key: 'HIVE-71', markdown: 'a\u001bb' }),
      /control characters/,
    );
  });

  it('refuses an empty or whitespace-only comment', () => {
    refuses(
      () => parseAddJiraCommentRequest({ key: 'HIVE-71', markdown: '' }),
      /empty/,
    );
    refuses(
      () => parseAddJiraCommentRequest({ key: 'HIVE-71', markdown: '   \n ' }),
      /empty/,
    );
  });

  it('refuses one past the bound', () => {
    refuses(
      () =>
        parseAddJiraCommentRequest({
          key: 'HIVE-71',
          markdown: 'x'.repeat(32_769),
        }),
      /too long/,
    );
  });

  it('refuses a malformed key and an unknown sibling', () => {
    refuses(
      () => parseAddJiraCommentRequest({ key: 'nope', markdown: 'hi' }),
      /key/,
    );
    refuses(
      () =>
        parseAddJiraCommentRequest({
          key: 'HIVE-71',
          markdown: 'hi',
          body: {},
        }),
      /unexpected key/,
    );
  });
});
