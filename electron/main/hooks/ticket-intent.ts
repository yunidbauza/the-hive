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
 * What may sit between the two words of a verb phrase.
 *
 * Whitespace **or a hyphen**, because the most common way to claim a ticket in
 * this app is not a sentence at all — it is a slash command, and a command name
 * cannot contain a space:
 *
 * ```
 * /work-on ABC-123
 * /workstream:work-on ABC-123
 * ```
 *
 * Both returned `null` while this was `\s+`, which is the whole reason a
 * session could sit on a ticket all afternoon and never appear on its card. The
 * verb is the same verb; only the separator its spelling forced on it differs.
 *
 * The leading `/` and the plugin-qualifying `:` need no help — {@link
 * INTENT_LEAD_IN} already opens on `[^a-z]`, which both satisfy.
 *
 * This widens the *separator* and nothing else. No verb is added, and
 * {@link INTERROGATIVE_LEAD} still runs, so "did you work-on ABC-123" is still
 * a question rather than a claim.
 */
const VERB_GAP = '[\\s-]+';

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
  `work(?:ing)?${VERB_GAP}on`,
  `works${VERB_GAP}on`,
  'start(?:ing|s)?',
  `pick(?:ing|s)?${VERB_GAP}up`,
  'implement(?:ing|s)?',
  'fix(?:ing|es)?',
  `continue${VERB_GAP}(?:with|on)`,
  `continuing${VERB_GAP}(?:with|on)`,
  'resume',
  `switch(?:ing|es)?${VERB_GAP}to`,
  'tackle',
  'tackling',
  `take${VERB_GAP}on`,
  `taking${VERB_GAP}on`,
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
     *
     * ## Why the trailing delimiters are stripped
     *
     * {@link INTERROGATIVE_LEAD} anchors on `\s+(?:\w+\s+)?$` — it expects to
     * end on whitespace. That held while every lead-in delimiter *was*
     * whitespace, and stopped holding the moment {@link VERB_GAP} made
     * `/work-on` matchable: the slice then ends in `/`, the anchor cannot
     * match, and the guard silently never fires. Measured before this strip
     * existed:
     *
     * ```
     * "did you work on ABC-123"   -> null      (guarded)
     * "did you /work-on ABC-123"  -> ABC-123   (not guarded)
     * ```
     *
     * Stripping the trailing non-letters puts the slash form back on the same
     * footing as the prose one rather than widening the guard itself.
     *
     * It remains a one-pronoun guard: "have you **run** /work-on ABC-123" has
     * two words between the wh-word and the verb and still slips through. That
     * limit predates this change and applies identically to the whitespace
     * spelling, so it is left alone rather than widened here — `(?:\w+\s+)*`
     * would start refusing real intent like "what I want is to work on ABC-123".
     */
    const lookback = before.slice(0, lead.index + 1).replace(/[^a-z\s]+$/i, '');
    if (INTERROGATIVE_LEAD.test(lookback)) continue;

    return key;
  }

  return null;
}

/**
 * Every key-shaped token in a branch, hoisted like every other pattern here.
 *
 * `g` is safe on a module constant *because* it is only ever used with
 * `matchAll`, which iterates a clone and never advances this one's `lastIndex`.
 * A bare `.exec` loop on a shared global regex would carry state between calls
 * and skip the first candidate of every second branch.
 */
const BRANCH_KEY = new RegExp(`(^|[^A-Za-z0-9])(${ISSUE_KEY_SOURCE})`, 'gi');

/**
 * How many candidates one branch may offer.
 *
 * Each one costs a Jira read on the renderer's side, so this is the ceiling on
 * what a pathological branch name can spend. Four covers every real shape —
 * `chore/bump-node-22-hive-118` needs two — while a branch stuffed with
 * version numbers cannot turn a checkout into a dozen network calls.
 */
const MAX_BRANCH_CANDIDATES = 4;

/**
 * The keys a **branch name** offers, best-first, or an empty list.
 *
 * ## Why a second signal at all
 *
 * The prompt is the better evidence and stays the primary one, but it is only
 * ever spoken once. A session resumed the next morning, or one whose "let's do
 * ABC-123" scrolled past before this app was listening, has nothing left to
 * read — while the branch it is standing on still says exactly what it is for,
 * and goes on saying it for as long as the work lasts.
 *
 * The two are independent by design. A brainstorming session on a ticket has no
 * branch yet and is carried entirely by {@link ticketKeyFromPrompt}; a session
 * resumed onto an existing branch may be carried entirely by this. Neither is a
 * precondition for the other, and a session that satisfies neither correctly
 * associates with nothing — an empty answer is the common case, not a failure.
 *
 * ## Why it may be this loose
 *
 * Three rules only: something key-shaped, not glued to a preceding word, and
 * case-folded up. `release-2024-11` passes it and yields `RELEASE-2024`.
 *
 * That is survivable *here* and would not be in a prompt, because of what the
 * renderer does next: every candidate is put to Jira, and only a confirmed
 * issue associates anything. Jira has no `RELEASE` project, so the candidate
 * dies one call later having renamed nothing. A tighter matcher would duplicate
 * that check in the place with strictly less information — a branch name
 * carries no grammar to read, so there is nothing here to be cleverer with.
 *
 * ## Why the case rule is inverted
 *
 * {@link ticketKeyFromPrompt} matches the key case-**sensitively**, because in
 * English a lowercase `hive-111` is likelier to be a pasted branch name than an
 * issue someone is claiming. A branch is the mirror image: it is lowercase
 * precisely *because* it is a branch, by `git` convention rather than Jira's.
 * Applying the prompt's rule here would refuse nearly every real branch —
 * including this app's own `worktree-feat+hive-111-ledger`.
 *
 * ## Delimiting
 *
 * A branch separates its words with the same `-` a key uses, so the prompt
 * scanner's "delimited on both sides" rule cannot apply: it would reject
 * `hive-111-ledger`, which is the ordinary case rather than an edge one. The
 * left side is still guarded — a key may not be glued to a preceding
 * alphanumeric — and the right side needs no guard, because `\d+` is greedy and
 * so reads `hive-1112` as one issue rather than `HIVE-111` with a digit spare.
 *
 * ## Why every candidate is returned, not just the first
 *
 * A prompt scanner can stop at the first match because a sentence's leading
 * verb phrase says which key is meant. A branch has no grammar, and the
 * leftmost key-shaped token is routinely **not** the issue:
 *
 * ```
 * chore/bump-node-22-hive-118  ->  NODE-22, HIVE-118
 * release-2024-11-hive-111     ->  RELEASE-2024, HIVE-111
 * feat/sprint-42-hive-111      ->  SPRINT-42, HIVE-111
 * ```
 *
 * Returning only the leftmost meant a version number permanently shadowed the
 * real key: the shadow went to Jira, Jira rejected it, and the branch signal
 * associated nothing — the very failure this signal exists to fix, reappearing
 * for an ordinary branch shape.
 *
 * So the caller gets the list and confirms it **in order, stopping at the first
 * issue Jira actually recognises**. Order still carries meaning — leftmost is
 * tried first — but it no longer gets to be the only answer. Capped at
 * {@link MAX_BRANCH_CANDIDATES}, and de-duplicated, because each entry costs a
 * network read.
 *
 * Never throws — its caller is a status listener that must not be taken down by
 * an unusual branch name.
 */
export function ticketKeysFromBranch(branch: string | null): string[] {
  if (branch === null || branch === '') return [];

  const seen = new Set<string>();

  for (const match of branch.slice(0, MAX_PROMPT_SCAN).matchAll(BRANCH_KEY)) {
    seen.add(match[2].toUpperCase());
    if (seen.size === MAX_BRANCH_CANDIDATES) break;
  }

  return [...seen];
}
