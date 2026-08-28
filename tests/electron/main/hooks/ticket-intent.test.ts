// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  MAX_PROMPT_SCAN,
  ticketKeysFromBranch,
  ticketKeyFromPrompt,
} from '../../../../electron/main/hooks/ticket-intent';

/**
 * The judgement that decides whether a session gets renamed and refiled
 * (HIVE-78).
 *
 * The false-positive cases below matter more than the true-positive ones. A
 * missed intent costs the user one extra sentence; a wrong one silently files
 * their work under someone else's ticket, and nothing on screen explains why.
 */
describe('ticketKeyFromPrompt', () => {
  describe('accepts', () => {
    it.each([
      'work on the ticket ABC-123',
      'work on ABC-123',
      'working on ABC-123',
      'start ABC-123',
      'starting ABC-123',
      'lets start issue ABC-123',
      'pick up ABC-123',
      'picking up jira card ABC-123',
      'implement ABC-123',
      'fix ABC-123',
      'fixing the bug ABC-123',
      'continue with ABC-123',
      'resume ABC-123',
      'switch to ABC-123',
      'take on ABC-123',
      'tackle ABC-123',
      'begin ABC-123',
      'please work on the jira ticket ABC-123 now',
      // The polite modals are intent, not questions — see INTERROGATIVE_LEAD.
      'can you work on ABC-123',
      'could you start ABC-123',
      'would you fix ABC-123',
      'Work On ABC-123',
      'WORK ON ABC-123',
      /*
        The slash-command spellings, which are how the work actually starts
        here and which matched nothing at all before this. The verb is the same
        verb; only the separator differs, because a command name cannot carry a
        space. `/workstream:work-on` is the plugin-qualified form of the same
        command, so the `:` has to be as transparent as the `/`.
      */
      '/work-on ABC-123',
      '/workstream:work-on ABC-123',
      '/pick-up ABC-123',
      '/switch-to ABC-123',
      'lets work-on ABC-123',
      '/work-on ABC-123 and open a PR',
    ])('%s', (prompt) => {
      expect(ticketKeyFromPrompt(prompt)).toBe('ABC-123');
    });

    it.each(['ABC-123', '  ABC-123  ', '#ABC-123', 'ABC-123.', 'ABC-123?'])(
      'a prompt that is essentially just the key: %s',
      (prompt) => {
        expect(ticketKeyFromPrompt(prompt)).toBe('ABC-123');
      },
    );
  });

  /**
   * A question about a command is not an instruction to run it.
   *
   * `INTERROGATIVE_LEAD` guarded the prose spelling from the start, and stopped
   * guarding anything the moment `VERB_GAP` made `/work-on` matchable: the
   * lookback then ended on the `/`, and the pattern anchors on whitespace, so
   * it could never fire. Every case below returned `ABC-123` before the
   * lookback stripped its trailing delimiters.
   */
  describe('refuses a question about the command', () => {
    it.each([
      'did you /work-on ABC-123',
      'what does /work-on ABC-123 do',
      'why did /work-on ABC-123 fail',
      'what happened when /switch-to ABC-123',
      // The prose forms, which must not regress while fixing the slash ones.
      'did you work on ABC-123',
      'have you started ABC-123',
    ])('%s', (prompt) => {
      expect(ticketKeyFromPrompt(prompt)).toBeNull();
    });

    it('still admits the polite modals, which are real instructions', () => {
      // The guard is past-and-perfect auxiliaries and wh-words, never `can` /
      // `could` / `would` — refusing those would trade a narrow false-positive
      // class for a very wide false-negative one.
      expect(ticketKeyFromPrompt('can you /work-on ABC-123')).toBe('ABC-123');
      expect(ticketKeyFromPrompt('please /work-on ABC-123')).toBe('ABC-123');
    });

    /**
     * The limit of the guard, recorded rather than claimed away.
     *
     * It allows **one** word between the wh-word and the verb, so a longer
     * lead-in still reads as intent. That is not new and is not a property of
     * the slash spelling — the prose form behaves identically — so it is left
     * alone here: widening it to `(?:\w+\s+)*` would start refusing genuine
     * instructions like "what I want is to work on ABC-123".
     */
    it('does not catch a two-word interrogative lead, in either spelling', () => {
      expect(ticketKeyFromPrompt('have you run /work-on ABC-123 yet')).toBe(
        'ABC-123',
      );
      expect(ticketKeyFromPrompt('have you run work on ABC-123 yet')).toBe(
        'ABC-123',
      );
    });
  });

  describe('refuses', () => {
    it.each([
      // Mentions a ticket without claiming it — the sentences that make an
      // "any key wins" rule unusable.
      'the PR for ABC-123 broke CI',
      'see also ABC-99 for context',
      'ABC-123 is blocked on infra',
      'why did ABC-123 fail',
      'this looks related to ABC-123',
      // Refers to it, but does not take it on. "review" in particular is
      // something a user does to somebody else's work.
      'review ABC-123',
      'check ABC-123',
      'look at ABC-123',
      'tell me about ABC-123',
      // Nothing key-shaped at all.
      'work on the login bug',
      '',
    ])('%s', (prompt) => {
      expect(ticketKeyFromPrompt(prompt)).toBeNull();
    });

    it('a lowercase branch name that merely looks like a key', () => {
      /**
       * The reason the key half of the match is case-sensitive. Every worktree
       * branch this project creates has exactly this shape, and lowercasing the
       * test would make "work on feat/incorp-332-adhoc-scrape" file the session
       * under a nonexistent issue.
       */
      expect(
        ticketKeyFromPrompt('work on feat/incorp-332-adhoc-scrape-tier'),
      ).toBeNull();
    });

    it('a key that is part of a longer identifier', () => {
      // A key must be delimited on both sides, or any uppercase identifier
      // carrying a number becomes a candidate.
      expect(ticketKeyFromPrompt('work on X-ABC-123')).toBeNull();
      expect(ticketKeyFromPrompt('work on ABC-123-BETA')).toBeNull();
    });

    it.each([
      // Past/perfect interrogatives: asking whether work happened, not asking
      // for it. Both were measured associating the session before the
      // INTERROGATIVE_LEAD guard existed.
      'did you fix the ABC-123 bug?',
      'did we start ABC-123?',
      'have you started ABC-123 yet?',
      'has anyone begun ABC-123?',
      // wh-questions about the ticket.
      'what do the ABC-123 tests cover?',
      'why did you start ABC-123',
      'when did we begin ABC-123',
    ])('a question about the ticket rather than a claim on it: %s', (prompt) => {
      expect(ticketKeyFromPrompt(prompt)).toBeNull();
    });

    it('a bare "do", which made ordinary questions match', () => {
      /**
       * `do` was in the verb list and is gone rather than guarded. It turned
       * "what do the ABC-123 tests cover?" into an association, and every
       * phrasing that genuinely needed it ("let's do ABC-123") is rare beside
       * the questions it swallowed.
       */
      expect(ticketKeyFromPrompt("let's do ABC-123")).toBeNull();
      expect(ticketKeyFromPrompt('do ABC-123')).toBeNull();
    });

    it('a verb separated from the key by unrelated words', () => {
      /**
       * Why the filler list is enumerated rather than `.{0,40}?`. This is a
       * sentence about a ticket, not a claim to be working on it, and a
       * wildcard between the verb and the key accepts it.
       */
      expect(
        ticketKeyFromPrompt('start the deploy that broke ABC-123'),
      ).toBeNull();
    });
  });

  describe('picks', () => {
    it('the first qualifying key when a prompt names two', () => {
      /**
       * Genuinely ambiguous, so the rule is at least predictable. Taking the
       * later one would let a sentence's word order silently decide which
       * ticket the session is filed under.
       */
      expect(ticketKeyFromPrompt('start ABC-1 then start DEF-2')).toBe('ABC-1');
    });

    it('a qualifying key even when an unqualified one comes first', () => {
      // The scan is over *qualifying* keys, not over keys — a mention early in
      // the prompt must not shadow a real intent later in it.
      expect(
        ticketKeyFromPrompt('DEF-9 is done, now work on ABC-123'),
      ).toBe('ABC-123');
    });
  });

  it('does not scan past the cap', () => {
    /**
     * A prompt is unbounded user text — a pasted stack trace, a whole file —
     * and both accepted shapes put the key in the opening words of a short
     * message. Scanning further is backtracking on the hot path of the most
     * frequent hook event, for no reachable benefit.
     */
    const buried = `${'x'.repeat(MAX_PROMPT_SCAN)} work on ABC-123`;
    expect(ticketKeyFromPrompt(buried)).toBeNull();

    const early = `work on ABC-123 ${'x'.repeat(MAX_PROMPT_SCAN)}`;
    expect(ticketKeyFromPrompt(early)).toBe('ABC-123');
  });

  it('accepts the key shapes Jira actually issues', () => {
    // A prefix may carry digits after its first letter, and the number is
    // unbounded — `assertJiraIssueKey` admits both, so this must too.
    expect(ticketKeyFromPrompt('work on H2-1')).toBe('H2-1');
    expect(ticketKeyFromPrompt('work on HIVE-104729')).toBe('HIVE-104729');
  });
});

/**
 * The second, weaker signal (goal/ticket-session-inference).
 *
 * A branch is evidence the user never spoke: they said it once to `git`, and
 * the name persists long after the sentence that created it has scrolled away.
 * That makes it the answer for a session resumed days later, or one whose
 * intent was expressed before this app was watching.
 *
 * It is deliberately **looser** than the prompt scanner, and safe only because
 * of what happens next: every candidate is put to Jira before it associates
 * anything. `release-2024-11` yields `RELEASE-2024` here, and Jira is what
 * throws it away. Tightening this into a classifier would buy nothing the
 * confirmation step does not already provide.
 */
/**
 * The second, weaker signal.
 *
 * A branch is evidence the user never spoke: they said it once to `git`, and
 * the name persists long after the sentence that created it has scrolled away.
 * That makes it the answer for a session resumed days later, or one whose
 * intent was expressed before this app was watching.
 *
 * It is deliberately **looser** than the prompt scanner, and safe only because
 * of what happens next: every candidate is put to Jira before it associates
 * anything. `release-2024-11` yields `RELEASE-2024` here, and Jira is what
 * throws it away. Tightening this into a classifier would buy nothing the
 * confirmation step does not already provide.
 */
describe('ticketKeysFromBranch', () => {
  describe('finds the key', () => {
    it.each([
      // The shape this app's own worktrees produce.
      ['worktree-feat+hive-111-ledger', 'HIVE-111'],
      ['feat/hive-111-ledger', 'HIVE-111'],
      ['feat/HIVE-111-ledger', 'HIVE-111'],
      ['fix/abc-42', 'ABC-42'],
      ['abc-42', 'ABC-42'],
      ['bugfix/ABC-42', 'ABC-42'],
      ['feature/abc-42_retry', 'ABC-42'],
      // A trailing word after the number is the common case, not the edge one.
      ['hive-111-the-ledger', 'HIVE-111'],
    ])('%s -> %s', (branch, key) => {
      expect(ticketKeysFromBranch(branch)).toEqual([key]);
    });

    it('uppercases, because a branch is lowercase by convention', () => {
      /*
        The prompt scanner is case-*sensitive* on the key and must stay so — it
        reads English, where a lowercase `hive-111` is far more likely to be a
        branch name someone pasted than an issue they are claiming. A branch is
        the opposite: it is lowercase precisely because git branches are, and
        refusing it there would refuse nearly every real branch.
      */
      expect(ticketKeysFromBranch('feat/hive-111')).toEqual(['HIVE-111']);
      expect(ticketKeyFromPrompt('feat/hive-111')).toBeNull();
    });
  });

  describe('finds nothing', () => {
    it.each([
      'main',
      'develop',
      // The branch this very change is being written on: words, no number.
      'goal/ticket-session-inference',
      'worktree-goal+ticket-session-inference',
      'feat/add-the-explorer',
      // A number with no project prefix in front of it.
      'release/2024',
      '',
    ])('%s', (branch) => {
      expect(ticketKeysFromBranch(branch)).toEqual([]);
    });

    it('refuses a null branch, which is what a detached HEAD reports', () => {
      expect(ticketKeysFromBranch(null)).toEqual([]);
    });
  });

  /**
   * Every candidate, in order — not just the leftmost.
   *
   * This is the finding that mattered most in review. The leftmost key-shaped
   * token in a branch is routinely *not* the issue: version numbers, sprint
   * numbers and node majors all match the same shape. While only the first was
   * returned, it went to Jira, Jira rejected it, and the branch signal
   * associated nothing — which is precisely the bug this signal exists to fix,
   * reappearing for an ordinary branch name.
   *
   * The renderer confirms these in order and stops at the first real issue, so
   * order still means something; it just no longer gets to be the only answer.
   */
  describe('offers every candidate, best-first', () => {
    it.each([
      ['chore/bump-node-22-hive-118', ['NODE-22', 'HIVE-118']],
      ['release-2024-11-hive-111', ['RELEASE-2024', 'HIVE-111']],
      ['feat/sprint-42-hive-111', ['SPRINT-42', 'HIVE-111']],
    ])('%s -> %s', (branch, keys) => {
      expect(ticketKeysFromBranch(branch)).toEqual(keys);
    });

    it('de-duplicates, because each entry costs a Jira read', () => {
      expect(ticketKeysFromBranch('feat/hive-111-rebase-hive-111')).toEqual([
        'HIVE-111',
      ]);
    });

    it('caps what one branch may spend', () => {
      // A pathological name must not turn a checkout into a dozen network
      // calls. Five candidates, four allowed through.
      const branch = 'a-1-b-2-c-3-d-4-e-5';

      expect(ticketKeysFromBranch(branch)).toEqual(['A-1', 'B-2', 'C-3', 'D-4']);
    });
  });

  it('does not split a longer number', () => {
    // `hive-1112` is one issue, not `HIVE-111` with a stray digit.
    expect(ticketKeysFromBranch('feat/hive-1112')).toEqual(['HIVE-1112']);
  });
});
