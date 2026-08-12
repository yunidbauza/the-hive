// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  MAX_PROMPT_SCAN,
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
