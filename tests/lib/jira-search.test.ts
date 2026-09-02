import { describe, expect, it } from 'vitest';

import { buildTicketSearchJql, MIN_TICKET_SEARCH_LENGTH } from '@/lib/jira-search';

/**
 * The term-to-JQL builder behind the WORK tab's search box.
 *
 * Every rule here was measured against a real Jira Cloud site rather than read
 * off a doc page, because the two disagree in the places that matter. What the
 * probe established, and what each group below pins down:
 *
 * - `~` matches whole words, not substrings. `summary ~ "termi"` finds nothing
 *   while `summary ~ "termi*"` finds plenty, so a box that searches as you type
 *   is empty at every keystroke until the word is finished unless a `*` is
 *   appended. Leading wildcards return nothing at all, so `*term*` is not a
 *   workaround.
 * - An issue key is **not** in the text index. `text ~ "HIVE-79"` returns the
 *   issues that *mention* HIVE-79, not HIVE-79 — it needs its own `key =`.
 * - A bare `"` is the only character that makes Jira answer 400. `(`, `-`, `*`
 *   and the word `AND` all come back as an ordinary empty result.
 */

describe('the words', () => {
  it('appends a wildcard, because ~ matches whole words', () => {
    // Without the `*`, this query returns nothing until the user has typed
    // every letter of a word that exists — measured, not assumed.
    expect(buildTicketSearchJql('termi', false)).toBe(
      '(summary ~ "termi*" OR description ~ "termi*") ORDER BY updated DESC',
    );
  });

  it('requires every word, so a second one narrows the search', () => {
    expect(buildTicketSearchJql('rail collapse', false)).toBe(
      '(summary ~ "rail*" OR description ~ "rail*")' +
        ' AND (summary ~ "collapse*" OR description ~ "collapse*")' +
        ' ORDER BY updated DESC',
    );
  });

  it('treats any run of whitespace as one separator', () => {
    expect(buildTicketSearchJql('  rail \t collapse  ', false)).toBe(
      '(summary ~ "rail*" OR description ~ "rail*")' +
        ' AND (summary ~ "collapse*" OR description ~ "collapse*")' +
        ' ORDER BY updated DESC',
    );
  });
});

describe('the ticket number', () => {
  it('gets its own clause, because a key is not in the text index', () => {
    expect(buildTicketSearchJql('HIVE-79', false)).toBe(
      '(key = "HIVE-79"' +
        ' OR ((summary ~ "HIVE-79*" OR description ~ "HIVE-79*")))' +
        ' ORDER BY updated DESC',
    );
  });

  it('accepts the key in the case it was typed', () => {
    // Jira's own keys are uppercase and `key =` is exact, so a lowercased one
    // has to be raised or it matches nothing.
    expect(buildTicketSearchJql('hive-79', false)).toContain('key = "HIVE-79"');
  });

  it('leaves the text clause alone when the term is not a key', () => {
    expect(buildTicketSearchJql('HIVE', false)).not.toContain('key =');
    expect(buildTicketSearchJql('HIVE-', false)).not.toContain('key =');
    expect(buildTicketSearchJql('79', false)).not.toContain('key =');
  });

  it('is not a key when it is one word of several', () => {
    // `key =` takes one value. "HIVE-79 rails" is a text search that happens to
    // start with something key-shaped, and treating it as a key lookup would
    // silently drop the other word.
    expect(buildTicketSearchJql('HIVE-79 rails', false)).not.toContain('key =');
  });
});

describe('whose tickets', () => {
  it('names no assignee by default — a search is about anyone’s work', () => {
    expect(buildTicketSearchJql('rails', false)).not.toContain('assignee');
  });

  it('narrows to the user when asked', () => {
    // `currentUser()` is evaluated by Jira, so this never needs an account id —
    // the same reason `JIRA_DEFAULT_JQL` uses it.
    expect(buildTicketSearchJql('rails', true)).toBe(
      '(summary ~ "rails*" OR description ~ "rails*")' +
        ' AND assignee = currentUser()' +
        ' ORDER BY updated DESC',
    );
  });
});

describe('what a keystroke cannot do', () => {
  it('escapes a quote, the one character that makes Jira answer 400', () => {
    expect(buildTicketSearchJql('foo"bar', false)).toBe(
      '(summary ~ "foo\\"bar*" OR description ~ "foo\\"bar*")' +
        ' ORDER BY updated DESC',
    );
  });

  it('escapes a backslash before it can escape the quote', () => {
    expect(buildTicketSearchJql('foo\\bar', false)).toBe(
      '(summary ~ "foo\\\\bar*" OR description ~ "foo\\\\bar*")' +
        ' ORDER BY updated DESC',
    );
  });

  it('cannot close the clause and append its own', () => {
    // The injection attempt in full: a quote to end the string, then a clause
    // of the caller's choosing. The quote comes back escaped and every word
    // lands inside a `~` clause, so the whole thing stays a search term.
    const jql = buildTicketSearchJql('x" OR key = "HIVE-1', false);

    expect(jql).toContain('summary ~ "x\\"*"');
    expect(jql).not.toContain('key = "HIVE-1"');
  });
});

describe('when there is nothing to ask', () => {
  it('refuses a term shorter than the minimum', () => {
    // A single letter matched the entire backlog on the real site, which is a
    // round trip that can only ever return noise.
    expect(buildTicketSearchJql('a', false)).toBeNull();
    expect(MIN_TICKET_SEARCH_LENGTH).toBe(2);
  });

  it('refuses whitespace, however much of it', () => {
    expect(buildTicketSearchJql('   ', false)).toBeNull();
    expect(buildTicketSearchJql('', false)).toBeNull();
  });

  it('measures the trimmed term, not what was typed around it', () => {
    expect(buildTicketSearchJql('  ab  ', false)).not.toBeNull();
    expect(buildTicketSearchJql('  a  ', false)).toBeNull();
  });

  it('applies the minimum to each word, not just to the whole term', () => {
    // "a b" is three characters and two useless clauses: `a*` and `b*` each
    // prefix-match most of a backlog, and AND-ing two of them is the round trip
    // the minimum exists to prevent.
    expect(buildTicketSearchJql('a b', false)).toBeNull();
  });

  it('drops a too-short word rather than the whole search', () => {
    // Mid-phrase typing reaches this constantly — "rail a" is on the way to
    // "rail alignment". Returning null there would blank a search the user is
    // still writing.
    expect(buildTicketSearchJql('rail a', false)).toBe(
      '(summary ~ "rail*" OR description ~ "rail*") ORDER BY updated DESC',
    );
  });
});

describe('the wildcard survives the escaping', () => {
  it('is not turned off by a word ending in a backslash', () => {
    /*
      Measured: `summary ~ "termi\\*"` returns 0 where `"termi*"` returns 3.
      Escaping the backslash leaves Lucene reading `\*` — an escaped, literal
      asterisk — so the prefix match silently stops applying for that word.
      Trailing backslashes are not searchable anyway, so they go.
    */
    expect(buildTicketSearchJql('foo\\', false)).toBe(
      '(summary ~ "foo*" OR description ~ "foo*") ORDER BY updated DESC',
    );
  });

  it('still escapes a backslash that is not the last character', () => {
    expect(buildTicketSearchJql('foo\\bar', false)).toContain(
      'summary ~ "foo\\\\bar*"',
    );
  });

  it('has nothing left to ask when a word is only backslashes', () => {
    expect(buildTicketSearchJql('\\\\\\', false)).toBeNull();
  });
});
