import { ISSUE_KEY_PATTERN } from '@shared/jira-contract';

/**
 * The WORK tab's search term, turned into JQL.
 *
 * ## Why the renderer builds the query
 *
 * `jira:search` already takes an optional `jql` — the settings pane's "Test
 * query" passes one — so a search needs no new channel and no main-process
 * change. The standing list is the opposite case and stays that way: its query
 * is resolved in main, because main reads the config on every verb and passing
 * the override from here would mean the store holding a setting it would then
 * race a hand-edit of the file over.
 *
 * ## Every rule below was measured, not read
 *
 * Against a real Jira Cloud site, because the documentation and the behaviour
 * disagree in the places that decide whether the box feels broken:
 *
 * - **`~` matches whole words, not substrings.** `summary ~ "termi"` returns
 *   nothing; `summary ~ "termi*"` returns plenty. A search-as-you-type box
 *   without the wildcard is empty at every keystroke until a word is finished,
 *   which reads as "no results" rather than as "still typing". Leading
 *   wildcards are not supported, so `*term*` is not the way out.
 * - **Words are AND-ed.** Left to Jira, a two-word term ORs its tokens and a
 *   second word *widens* the search — the opposite of what typing more means.
 * - **An issue key is not in the text index.** `text ~ "HIVE-79"` returns the
 *   issues that mention HIVE-79, not HIVE-79 itself. The key needs `key =`.
 * - **A bare `"` is the only character that fails.** It answers 400; `(`, `-`,
 *   `*` and the word `AND` all come back as an ordinary empty result. So the
 *   escaping here is exactly two characters wide, and nothing is stripped.
 *
 * ## What it deliberately does not search
 *
 * Comments. `text ~` would cover them, along with environment and every text
 * custom field, and descriptions are already the noisy half: on the site this
 * was measured against, `terminal` matches 9 summaries and over 100 issues once
 * descriptions join in.
 */

/**
 * The shortest term worth a round trip.
 *
 * A single letter matched the entire backlog — `a*` is a prefix of something in
 * almost every description — so the first keystroke would spend a request to
 * return every issue the user can see.
 */
export const MIN_TICKET_SEARCH_LENGTH = 2;

/**
 * The two characters that would otherwise end the JQL string literal.
 *
 * Backslash first, or it would escape the backslashes added for the quotes.
 */
function escape(word: string): string {
  return word.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * A word, with any trailing backslashes removed.
 *
 * Not cosmetic. Escaping doubles a trailing `\`, and the wildcard is appended
 * after it — so `foo\` becomes `"foo\\*"`, which Lucene reads as an *escaped,
 * literal* asterisk and the prefix match silently stops applying. Measured:
 * `summary ~ "termi\\*"` returns nothing where `"termi*"` returns three.
 *
 * Dropping them loses nothing, because a trailing backslash is not searchable
 * text either.
 */
function searchable(word: string): string {
  return word.replace(/\\+$/, '');
}

/** One word, matched as a prefix against either field the user asked for. */
function wordClause(word: string): string {
  const value = `${escape(word)}*`;
  return `(summary ~ "${value}" OR description ~ "${value}")`;
}

/**
 * The JQL for a term, or `null` when there is nothing worth asking.
 *
 * `null` rather than an empty string so a caller cannot accidentally send it:
 * an empty `jql` is not an empty search, it is the whole site.
 */
export function buildTicketSearchJql(
  term: string,
  mineOnly: boolean,
): string | null {
  const words = term.trim().split(/\s+/).filter(Boolean);

  /*
    The minimum applies to each **word**, because each word becomes a clause.
    Measuring the joined term instead let "a b" through — three characters, and
    two clauses that each prefix-match most of a backlog.

    A short word is dropped rather than failing the whole search, because
    mid-phrase typing produces one constantly: "rail a" is on the way to "rail
    alignment", and blanking the panel there would fight the user mid-word.
    Nothing left to ask means nothing is asked.
  */
  const asked = words
    .map(searchable)
    .filter((word) => word.length >= MIN_TICKET_SEARCH_LENGTH);
  if (asked.length === 0) return null;

  const text = asked.map(wordClause).join(' AND ');

  /*
    A key lookup only when the *whole* term is one. "HIVE-79 rails" is a text
    search that happens to start with something key-shaped, and `key =` takes a
    single value — reading the first word as the key would silently drop the
    rest of what was typed.

    Raised to upper case because Jira's keys are uppercase and `key =` is exact,
    so `hive-79` would match nothing at all.
  */
  const key = words.length === 1 ? words[0].toUpperCase() : null;
  const matched =
    key !== null && ISSUE_KEY_PATTERN.test(key)
      ? `(key = "${key}" OR (${text}))`
      : text;

  /*
    `currentUser()` is evaluated by Jira, so this never needs an account id —
    the same reason `JIRA_DEFAULT_JQL` uses it for the standing list.
  */
  const scoped = mineOnly ? `${matched} AND assignee = currentUser()` : matched;

  return `${scoped} ORDER BY updated DESC`;
}
