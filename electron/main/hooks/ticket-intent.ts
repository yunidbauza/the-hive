import { ISSUE_KEY_SOURCE } from '@shared/jira-contract';

/**
 * Reading "I am working on ABC-123" out of a prompt (HIVE-78).
 *
 * A session started from the PROJECTS tree names no ticket, and often should:
 * the user opens a terminal, looks around, and *then* decides what they are
 * doing. `UserPromptSubmit` is where that decision is first said out loud, and
 * it is already arriving at the receiver for an unrelated reason.
 *
 * ## What this deliberately is not
 *
 * It is not a classifier, and it must not become one. Everything below is a
 * shape test over literal words, because the cost of a wrong answer is a session
 * silently renamed and filed under someone else's ticket — and the user has no
 * obvious way to see *why* that happened. When the shape is not unmistakable,
 * the answer is `null` and nothing changes.
 *
 * ## The two accepted shapes
 *
 * 1. **A prompt that is essentially just the key.** `ABC-123`, `#ABC-123`,
 *    `ABC-123.` — there is nothing else in it to mean.
 * 2. **A work-intent verb leading into the key**, allowing the filler English
 *    actually puts between them: "work on the ticket ABC-123", "let's start
 *    issue ABC-123", "pick up jira card ABC-123".
 *
 * Anything else — "the PR for ABC-123 broke CI", "see also ABC-99", "ABC-123 is
 * blocked on infra" — mentions a key without claiming to be working on it, and
 * is ignored. Those are the sentences that make an "any key wins" rule
 * unusable in practice.
 *
 * ## Case
 *
 * The verb lead-in is matched case-insensitively; the **key never is**. A Jira
 * key is uppercase by construction, and lowercasing the test would make every
 * `feat/incorp-332-adhoc-scrape` branch name in a prompt look like an issue.
 * That is why this is two passes rather than one case-insensitive regex: the
 * pattern for the key stays case-sensitive and shared with the IPC guard.
 */

/**
 * How much of a prompt is scanned.
 *
 * A prompt is user text of unbounded length — a pasted stack trace, a whole
 * file. Both accepted shapes above put the key in the opening words of a short
 * message, so scanning further buys nothing and turns a 64 KB paste into 64 KB
 * of backtracking on the hot path of the most frequent hook event.
 */
export const MAX_PROMPT_SCAN = 4_096;

/**
 * Verbs that claim the work, rather than merely referring to it.
 *
 * Every entry is a verb of *starting or continuing*, which is the distinction
 * that keeps "the PR for ABC-123 broke" out. Deliberately excludes "see",
 * "check", "look at", "review" and "about" — all of them refer to a ticket
 * without taking it on, and "review ABC-123" in particular is something a user
 * does to somebody else's work.
 */
const INTENT_VERBS = [
  'work(?:ing)?\\s+on',
  'works\\s+on',
  'start(?:ing|s)?',
  'pick(?:ing|s)?\\s+up',
  'implement(?:ing|s)?',
  'fix(?:ing|es)?',
  'continue\\s+(?:with|on)',
  'continuing\\s+(?:with|on)',
  'resume',
  'switch(?:ing|es)?\\s+to',
  'tackle',
  'tackling',
  'take\\s+on',
  'taking\\s+on',
  'begin',
];

/**
 * Words that turn a following verb into a **question about** the ticket rather
 * than a claim on it.
 *
 * Tested against the text immediately before a matched lead-in. Without it the
 * filler grammar reads ordinary questions as intent:
 *
 * ```
 * "did you fix the ABC-123 bug?"      -> fix + the + <key>
 * "have you started ABC-123?"         -> started + <key>
 * ```
 *
 * Both were measured associating the session before this guard existed.
 *
 * `do` was previously in {@link INTENT_VERBS} and is gone rather than guarded:
 * it made `"what do the ABC-123 tests cover?"` a match, and every phrasing that
 * genuinely needed it ("let's do ABC-123") is rare next to the questions it
 * swallowed. `does`/`did` live here instead, as interrogative markers.
 *
 * The trailing `(?:\\w+\\s+)?` is the pronoun — "did **you** fix", "have **we**
 * started" — and is optional so "did fix" is caught too.
 *
 * ## What is deliberately *not* here
 *
 * The polite modals — `can`, `could`, `would`, `will`, `please`. "can you work
 * on ABC-123" is how a great many people phrase a genuine instruction, and
 * refusing it would trade a narrow false-positive class for a wide
 * false-negative one. This list is past-and-perfect auxiliaries and wh-words:
 * the markers of *asking about* work, not of requesting it.
 */
const INTERROGATIVE_LEAD = new RegExp(
  `(?:^|[^a-z])(?:did|does|have|has|had|why|what|when|where|whether)\\s+(?:\\w+\\s+)?$`,
  'i',
);

/**
 * Words allowed to sit between the verb and the key.
 *
 * Two groups, applied in order: determiners and prepositions, then the nouns
 * people use for a Jira issue. Both are `*`-quantified, so "work on ABC-123",
 * "work on the ABC-123" and "work on the jira ticket ABC-123" all pass while a
 * sentence's worth of unrelated words in between does not.
 *
 * A bounded, enumerated filler list rather than `.{0,40}?` on purpose: the
 * wildcard version accepts "start the deploy that broke ABC-123", which is a
 * sentence about a ticket and not a claim to be working on it.
 */
const DETERMINERS = '(?:the|this|that|a|an|my|our|next|on|to|with|in)';
const ISSUE_NOUNS = '(?:jira|ticket|issue|story|task|card|bug|epic)';

/**
 * The text immediately before a key, when that key is being taken on.
 *
 * Anchored at the **end** — it is tested against everything preceding the key,
 * so a match means the verb phrase runs right up to it.
 */
const INTENT_LEAD_IN = new RegExp(
  `(?:^|[^a-z])(?:${INTENT_VERBS.join('|')})\\s+` +
    `(?:${DETERMINERS}\\s+)*` +
    `(?:${ISSUE_NOUNS}\\s+)*` +
    `[#:]?\\s*$`,
  'i',
);

/** A prompt carrying the key and nothing that changes its meaning. */
const BARE_KEY = new RegExp(`^[#\\s]*${ISSUE_KEY_SOURCE}[\\s.!?:,]*$`);

/**
 * Every key-shaped token in the text, with where it starts.
 *
 * "Token" is the load-bearing word: a key must be delimited on both sides, so
 * `X-ABC-123` and `ABC-123-4` are not matches. Without that, any uppercase
 * branch name or identifier with a number in it becomes a candidate.
 */
function* keyTokens(text: string): Generator<{ key: string; index: number }> {
  const pattern = new RegExp(ISSUE_KEY_SOURCE, 'g');
  let match = pattern.exec(text);

  while (match !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const before = start === 0 ? '' : text[start - 1];
    const after = end >= text.length ? '' : text[end];

    const delimited =
      !/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9-]/.test(after);

    if (delimited) yield { key: match[0], index: start };

    match = pattern.exec(text);
  }
}

/**
 * The ticket the user just said they are working on, or `null`.
 *
 * The **first** qualifying key wins. A prompt naming two of them — "finish
 * ABC-1 then start ABC-2" — is genuinely ambiguous about which one the session
 * is now for, and picking the later one would mean a sentence's word order
 * silently decided it. First is at least predictable, and the user can say it
 * again plainly.
 *
 * Never throws, for the same reason nothing else in the receiver's path does: it
 * runs inside an HTTP handler on the main process.
 */
export function ticketKeyFromPrompt(prompt: string): string | null {
  const text = prompt.slice(0, MAX_PROMPT_SCAN);

  if (BARE_KEY.test(text.trim())) {
    const [bare] = keyTokens(text);
    return bare?.key ?? null;
  }

  for (const { key, index } of keyTokens(text)) {
    const before = text.slice(0, index);
    const lead = INTENT_LEAD_IN.exec(before);
    if (lead === null) continue;

    /**
     * What sits in front of the verb phrase decides whether it is a claim or a
     * question — see {@link INTERROGATIVE_LEAD}.
     *
     * `lead.index + 1` because the lead-in pattern opens by consuming one
     * non-letter delimiter, so this is the text up to and including it, which
     * is exactly what the interrogative pattern anchors against. A lead-in that
     * matched at position 0 has nothing in front of it and cannot be a
     * question.
     */
    if (INTERROGATIVE_LEAD.test(before.slice(0, lead.index + 1))) continue;

    return key;
  }

  return null;
}
